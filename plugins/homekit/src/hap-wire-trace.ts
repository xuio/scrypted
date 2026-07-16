import { createHash, randomBytes } from 'crypto';
import {
    closeSync,
    constants as fsConstants,
    fstatSync,
    openSync,
    readFileSync,
} from 'fs';
import net from 'net';
import path from 'path';
import { HAPConnection } from './hap';

const HAP_WIRE_TRACE_PATCH = Symbol.for('@scrypted/homekit/hap-wire-trace');
const HAP_WIRE_TRACE_SOCKET_PATCH = Symbol.for('@scrypted/homekit/hap-wire-trace-socket');
const HAP_WIRE_TRACE_REQUEST_ID = Symbol.for('@scrypted/homekit/hap-wire-trace-request-id');
const HAP_WIRE_TRACE_VERSION = '2026-07-16-v1';
const HAP_TRACE_CONTROL_PATH = '/tmp/scrypted-homekit-hap-trace-control.json';
const CONTROL_POLL_MS = 1_000;
const MAX_CONTROL_AGE_MS = 15 * 60_000;
const MAX_QUEUED_BYTES = 512 * 1024;
const MAX_SENSITIVE_QUEUED_BYTES = 64 * 1024;
const MAX_RESOURCE_REQUEST_BYTES = 64 * 1024;
const MAX_CONTROL_BYTES = 8 * 1024;
const MAX_RESOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RESOURCE_RESPONSES_PER_CONNECTION = 4;
const MAX_CHUNK_LINE_BYTES = 8 * 1024;
const HTTP_HEADER_END = Buffer.from('\r\n\r\n');

interface TraceControl {
    version: 1;
    runId: string;
    socketPath: string;
    token: string;
    expiresAt: number;
    includeKeys?: boolean;
}

export interface HapWireTraceEvent {
    type: string;
    [key: string]: unknown;
}

export interface HapWireTraceSink {
    emit(event: HapWireTraceEvent, sensitive?: boolean): boolean;
    isActive(): boolean;
    includeKeys(): boolean;
    runId(): string | undefined;
    generation?(): number;
}

interface QueuedLine {
    line: string;
    bytes: number;
    sensitive: boolean;
}

function safeProcessUid() {
    try {
        return typeof process.getuid === 'function'
            ? process.getuid()
            : undefined;
    }
    catch {
        return;
    }
}

function isPrivateFileMode(mode: number) {
    return (mode & 0o077) === 0;
}

function parseTraceControl(): TraceControl | undefined {
    let fd: number | undefined;
    try {
        fd = openSync(
            HAP_TRACE_CONTROL_PATH,
            fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
        );
        const stat = fstatSync(fd);
        if (!stat.isFile()
            || !isPrivateFileMode(stat.mode)
            || stat.size <= 0
            || stat.size > MAX_CONTROL_BYTES)
            return;
        const uid = safeProcessUid();
        if (uid !== undefined && stat.uid !== uid)
            return;

        const parsed = JSON.parse(readFileSync(fd, 'utf8')) as Partial<TraceControl>;
        if (parsed.version !== 1
            || typeof parsed.runId !== 'string'
            || !/^[a-zA-Z0-9._-]{8,96}$/.test(parsed.runId)
            || typeof parsed.token !== 'string'
            || !/^[a-f0-9]{32,128}$/i.test(parsed.token)
            || typeof parsed.socketPath !== 'string'
            || typeof parsed.expiresAt !== 'number')
            return;
        const now = Date.now();
        if (parsed.expiresAt <= now || parsed.expiresAt - now > MAX_CONTROL_AGE_MS)
            return;

        const controlDirectory = path.dirname(HAP_TRACE_CONTROL_PATH);
        const socketPath = path.resolve(parsed.socketPath);
        if (path.dirname(socketPath) !== controlDirectory
            || !path.basename(socketPath).startsWith('scrypted-homekit-hap-trace-')
            || !path.basename(socketPath).endsWith('.sock'))
            return;

        return {
            version: 1,
            runId: parsed.runId,
            socketPath,
            token: parsed.token,
            expiresAt: parsed.expiresAt,
            includeKeys: parsed.includeKeys === true,
        };
    }
    catch {
        return;
    }
    finally {
        try {
            if (fd !== undefined)
                closeSync(fd);
        }
        catch {
        }
    }
}

// Exported as a narrow test seam; production uses the singleton below.
export class SocketHapWireTraceSink implements HapWireTraceSink {
    private control?: TraceControl;
    private nextControlPoll = 0;
    private socket?: net.Socket;
    private connecting = false;
    private ready = false;
    private blocked = false;
    private readyGeneration = 0;
    private nextConnectAttempt = 0;
    private retryDelayMs = 250;
    private retryTimer?: NodeJS.Timeout;
    private handshakeTimer?: NodeJS.Timeout;
    private queued: QueuedLine[] = [];
    private sensitiveQueued: QueuedLine[] = [];
    private queuedBytes = 0;
    private sensitiveQueuedBytes = 0;
    private droppedEvents = 0;
    private droppedBytes = 0;

    private clearRetryTimer() {
        if (!this.retryTimer)
            return;
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
    }

    private scheduleReconnect() {
        this.clearRetryTimer();
        const control = this.control;
        if (!control)
            return;
        const delay = Math.max(0, this.nextConnectAttempt - Date.now());
        this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            if (!this.control || this.control !== control)
                return;
            if (control.expiresAt <= Date.now()) {
                this.control = undefined;
                this.disconnect();
                return;
            }
            // Re-read the control file so a collector replacement or removal
            // is observed even when no further HAP traffic arrives.
            this.nextControlPoll = 0;
            this.refreshControl();
        }, delay);
        this.retryTimer.unref();
    }

    private disconnect(clearQueue = true, retry = false) {
        const transportGenerationEnded = retry
            && (this.ready || this.connecting || !!this.socket);
        this.ready = false;
        this.connecting = false;
        this.blocked = false;
        if (this.handshakeTimer) {
            clearTimeout(this.handshakeTimer);
            this.handshakeTimer = undefined;
        }
        const socket = this.socket;
        this.socket = undefined;
        try {
            socket?.destroy();
        }
        catch {
        }
        if (clearQueue) {
            this.queued.splice(0);
            this.sensitiveQueued.splice(0);
            this.queuedBytes = 0;
            this.sensitiveQueuedBytes = 0;
            this.droppedEvents = 0;
            this.droppedBytes = 0;
        }
        if (retry) {
            // Advance before backoff, not after the next ready message. Any HAP
            // traffic queued while the collector is unavailable will then
            // cause its current session keys/counters to be queued ahead of
            // the encrypted record diagnostics that need them.
            if (transportGenerationEnded)
                this.readyGeneration++;
            this.nextConnectAttempt = Date.now() + this.retryDelayMs;
            this.retryDelayMs = Math.min(this.retryDelayMs * 2, 5_000);
            this.scheduleReconnect();
        }
        else {
            this.clearRetryTimer();
            this.nextConnectAttempt = 0;
            this.retryDelayMs = 250;
        }
    }

    private refreshControl() {
        const now = Date.now();
        if (this.control && this.control.expiresAt <= now) {
            this.control = undefined;
            this.disconnect();
        }
        if (now < this.nextControlPoll)
            return;
        this.nextControlPoll = now + CONTROL_POLL_MS;

        const control = parseTraceControl();
        if (!control) {
            this.control = undefined;
            this.disconnect();
            return;
        }
        if (this.control?.runId !== control.runId
            || this.control.socketPath !== control.socketPath
            || this.control.token !== control.token) {
            this.disconnect();
        }
        this.control = control;
        this.connect();
    }

    private connect() {
        if (!this.control || this.socket || this.connecting)
            return;
        if (Date.now() < this.nextConnectAttempt) {
            this.scheduleReconnect();
            return;
        }
        this.clearRetryTimer();
        this.connecting = true;
        let socket: net.Socket;
        try {
            socket = net.createConnection(this.control.socketPath);
        }
        catch {
            this.connecting = false;
            this.disconnect(false, true);
            return;
        }
        this.socket = socket;
        socket.setNoDelay(true);
        socket.setEncoding('utf8');
        this.handshakeTimer = setTimeout(() => {
            if (!this.ready && this.socket === socket)
                this.disconnect(false, true);
        }, 5_000);
        this.handshakeTimer.unref();

        let input = '';
        socket.on('connect', () => {
            try {
                this.connecting = false;
                const control = this.control;
                if (!control)
                    return this.disconnect();
                socket.write(JSON.stringify({
                    type: 'hello',
                    version: 1,
                    runId: control.runId,
                    token: control.token,
                    pid: process.pid,
                }) + '\n');
            }
            catch {
                this.disconnect(false, true);
            }
        });
        socket.on('data', data => {
            try {
                input += data;
                while (true) {
                    const newline = input.indexOf('\n');
                    if (newline < 0)
                        break;
                    const line = input.slice(0, newline);
                    input = input.slice(newline + 1);
                    try {
                        const message = JSON.parse(line);
                        if (message?.type !== 'ready'
                            || message?.runId !== this.control?.runId)
                            continue;
                        this.ready = true;
                        this.clearRetryTimer();
                        this.retryDelayMs = 250;
                        this.nextConnectAttempt = 0;
                        if (this.handshakeTimer) {
                            clearTimeout(this.handshakeTimer);
                            this.handshakeTimer = undefined;
                        }
                        this.flush();
                    }
                    catch {
                    }
                }
                if (input.length > 64 * 1024)
                    this.disconnect(false, true);
            }
            catch {
                this.disconnect(false, true);
            }
        });
        socket.on('drain', () => {
            try {
                this.blocked = false;
                this.flush();
            }
            catch {
                this.disconnect(false, true);
            }
        });
        socket.on('error', () => {
            // A missing collector is the normal, tracing-disabled state.
        });
        socket.on('close', () => {
            if (this.socket === socket)
                this.disconnect(false, true);
        });
    }

    private recordDrop(bytes: number) {
        this.droppedEvents++;
        this.droppedBytes += bytes;
    }

    private dropOldestNormal() {
        const dropped = this.queued.shift();
        if (!dropped)
            return false;
        this.queuedBytes -= dropped.bytes;
        this.recordDrop(dropped.bytes);
        return true;
    }

    private queue(line: string, sensitive: boolean) {
        const bytes = Buffer.byteLength(line);
        if (bytes > MAX_QUEUED_BYTES
            || sensitive && bytes > MAX_SENSITIVE_QUEUED_BYTES) {
            this.recordDrop(bytes);
            return false;
        }

        if (sensitive) {
            if (this.sensitiveQueuedBytes + bytes > MAX_SENSITIVE_QUEUED_BYTES) {
                this.recordDrop(bytes);
                return false;
            }
            while (this.queuedBytes + bytes > MAX_QUEUED_BYTES
                && this.dropOldestNormal()) {
            }
            if (this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
                this.recordDrop(bytes);
                return false;
            }
            this.sensitiveQueued.push({ line, bytes, sensitive: true });
            this.sensitiveQueuedBytes += bytes;
            this.queuedBytes += bytes;
            return true;
        }

        while (this.queuedBytes + bytes > MAX_QUEUED_BYTES
            && this.dropOldestNormal()) {
        }
        if (this.queuedBytes + bytes > MAX_QUEUED_BYTES) {
            this.recordDrop(bytes);
            return false;
        }
        this.queued.push({ line, bytes, sensitive: false });
        this.queuedBytes += bytes;
        return true;
    }

    private flush() {
        if (!this.ready || !this.socket || !this.control || this.blocked)
            return;
        try {
            if (this.droppedEvents) {
                const line = JSON.stringify({
                    type: 'hap-trace-dropped',
                    droppedEvents: this.droppedEvents,
                    droppedBytes: this.droppedBytes,
                    traceVersion: 1,
                    runId: this.control.runId,
                    at: new Date().toISOString(),
                    monotonicNs: process.hrtime.bigint().toString(),
                    _traceToken: this.control.token,
                }) + '\n';
                if (!this.socket.write(line))
                    this.blocked = true;
                this.droppedEvents = 0;
                this.droppedBytes = 0;
                if (this.blocked)
                    return;
            }
            while (this.sensitiveQueued.length) {
                const entry = this.sensitiveQueued[0];
                if (!this.control.includeKeys) {
                    this.sensitiveQueued.shift();
                    this.sensitiveQueuedBytes -= entry.bytes;
                    this.queuedBytes -= entry.bytes;
                    continue;
                }
                const accepted = this.socket.write(entry.line);
                this.sensitiveQueued.shift();
                this.sensitiveQueuedBytes -= entry.bytes;
                this.queuedBytes -= entry.bytes;
                if (!accepted) {
                    this.blocked = true;
                    break;
                }
            }
            if (this.blocked)
                return;
            while (this.queued.length) {
                const entry = this.queued[0];
                const accepted = this.socket.write(entry.line);
                this.queued.shift();
                this.queuedBytes -= entry.bytes;
                if (!accepted) {
                    this.blocked = true;
                    break;
                }
            }
        }
        catch {
            this.disconnect(false, true);
        }
    }

    emit(event: HapWireTraceEvent, sensitive = false) {
        try {
            this.refreshControl();
            const control = this.control;
            if (!control || sensitive && !control.includeKeys)
                return false;
            const line = JSON.stringify({
                ...event,
                traceVersion: 1,
                runId: control.runId,
                at: new Date().toISOString(),
                monotonicNs: process.hrtime.bigint().toString(),
                _traceToken: control.token,
            }) + '\n';
            if (!this.queue(line, sensitive))
                return false;
            this.connect();
            this.flush();
            return true;
        }
        catch {
            // Diagnostics must never alter HomeKit request delivery.
            this.disconnect(false, true);
            return false;
        }
    }

    isActive() {
        try {
            this.refreshControl();
            return !!this.control;
        }
        catch {
            return false;
        }
    }

    includeKeys() {
        try {
            this.refreshControl();
            return this.control?.includeKeys === true;
        }
        catch {
            return false;
        }
    }

    runId() {
        try {
            this.refreshControl();
            return this.control?.runId;
        }
        catch {
            return;
        }
    }

    generation() {
        return this.readyGeneration;
    }
}

const socketTraceSink = new SocketHapWireTraceSink();
let installedSink: HapWireTraceSink = socketTraceSink;

interface ConnectionTraceState {
    id: string;
    requestSequence: number;
    connectionRunId?: string;
    keysRunId?: string;
    keysGeneration?: number;
    socketPatched?: boolean;
    closeRequested?: boolean;
}

const connectionStates = new WeakMap<object, ConnectionTraceState>();
const accessoryNamesByPort = new Map<number, string>();
const resourceResponses = new WeakMap<object, Map<string, {
    chunks: Buffer[];
    bytes: number;
    capturedBytes: number;
    truncated: boolean;
}>>();
const skippedResourceResponses = new WeakMap<object, Set<string>>();

function stateFor(connection: object) {
    let state = connectionStates.get(connection);
    if (!state) {
        state = {
            id: randomBytes(8).toString('hex'),
            requestSequence: 0,
        };
        connectionStates.set(connection, state);
    }
    return state;
}

function sha256(data: Buffer) {
    return createHash('sha256').update(data).digest('hex');
}

function safeSinkEmit(
    sink: HapWireTraceSink,
    event: HapWireTraceEvent,
    sensitive = false,
) {
    try {
        return sink.emit(event, sensitive);
    }
    catch {
        return false;
    }
}

function firstProtocolLine(data: Buffer) {
    const newline = data.indexOf('\r\n');
    if (newline <= 0 || newline > 160)
        return;
    const line = data.subarray(0, newline).toString('latin1');
    if (!/^(?:HTTP\/\d+\.\d+|EVENT\/\d+\.\d+)/.test(line))
        return;
    return line;
}

export function getHapRecordLengths(data: Buffer) {
    const lengths: number[] = [];
    let offset = 0;
    while (offset < data.length) {
        if (data.length - offset < 18)
            return;
        const length = data.readUInt16LE(offset);
        if (length > 0x400 || data.length - offset < length + 18)
            return;
        lengths.push(length);
        offset += length + 18;
    }
    return lengths;
}

function connectionInfo(connection: Record<PropertyKey, any>) {
    const tcpSocket = connection.tcpSocket;
    const httpSocket = connection.httpSocket;
    const localPort = tcpSocket?.localPort;
    return {
        connectionId: stateFor(connection).id,
        hapSessionId: connection.sessionID,
        state: connection.state,
        accessory: typeof localPort === 'number'
            ? accessoryNamesByPort.get(localPort)
            : undefined,
        external: {
            localAddress: tcpSocket?.localAddress || connection.localAddress,
            localPort,
            remoteAddress: tcpSocket?.remoteAddress || connection.remoteAddress,
            remotePort: tcpSocket?.remotePort || connection.remotePort,
        },
        loopback: {
            serverAddress: connection.internalHttpServerAddress,
            serverPort: connection.internalHttpServerPort,
            clientAddress: httpSocket?.localAddress,
            clientPort: httpSocket?.localPort,
        },
    };
}

function emitConnection(
    connection: Record<PropertyKey, any>,
    sink: HapWireTraceSink,
) {
    try {
        if (!sink.isActive())
            return false;
        const state = stateFor(connection);
        const runId = sink.runId();
        installSocketTrace(connection, sink);
        if (state.connectionRunId !== runId) {
            state.connectionRunId = runId;
            safeSinkEmit(sink, {
                type: 'hap-connection',
                pid: process.pid,
                ...connectionInfo(connection),
            });
        }
        emitSessionKeys(connection, sink);
        return true;
    }
    catch {
        return false;
    }
}

function emitSessionKeys(
    connection: Record<PropertyKey, any>,
    sink: HapWireTraceSink,
) {
    if (!sink.includeKeys())
        return;
    const state = stateFor(connection);
    const runId = sink.runId();
    const generation = sink.generation?.() || 0;
    if (!runId
        || state.keysRunId === runId && state.keysGeneration === generation)
        return;
    const encryption = connection.encryption;
    if (!Buffer.isBuffer(encryption?.accessoryToControllerKey)
        || encryption.accessoryToControllerKey.length !== 32
        || !Buffer.isBuffer(encryption?.controllerToAccessoryKey)
        || encryption.controllerToAccessoryKey.length !== 32)
        return;
    if (safeSinkEmit(sink, {
        type: 'hap-session-keys',
        ...connectionInfo(connection),
        accessoryToControllerKey: encryption.accessoryToControllerKey.toString('base64'),
        controllerToAccessoryKey: encryption.controllerToAccessoryKey.toString('base64'),
        accessoryToControllerCount: encryption.accessoryToControllerCount,
        controllerToAccessoryCount: encryption.controllerToAccessoryCount,
    }, true)) {
        state.keysRunId = runId;
        state.keysGeneration = generation;
    }
}

function installSocketTrace(
    connection: Record<PropertyKey, any>,
    sink: HapWireTraceSink,
) {
    const state = stateFor(connection);
    const socket = connection.tcpSocket as net.Socket & Record<PropertyKey, any>;
    if (!socket || state.socketPatched || socket[HAP_WIRE_TRACE_SOCKET_PATCH])
        return;
    state.socketPatched = true;
    socket[HAP_WIRE_TRACE_SOCKET_PATCH] = true;

    const originalWrite = socket.write;
    let sequence = 0;
    socket.write = function (...args: any[]) {
        const data = args[0];
        if (!Buffer.isBuffer(data) || !sink.isActive())
            return Reflect.apply(originalWrite, this, args);

        emitConnection(connection, sink);
        const writeId = `${state.id}-${++sequence}`;
        const started = process.hrtime.bigint();
        const originalCallbackIndex = typeof args[args.length - 1] === 'function'
            ? args.length - 1
            : -1;
        if (originalCallbackIndex >= 0) {
            const callback = args[originalCallbackIndex];
            args[originalCallbackIndex] = function (this: unknown, ...callbackArgs: any[]) {
                safeSinkEmit(sink, {
                    type: 'hap-socket-write-complete',
                    ...connectionInfo(connection),
                    writeId,
                    elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
                    bytesWritten: socket.bytesWritten,
                    writableLength: socket.writableLength,
                    destroyed: socket.destroyed,
                });
                return Reflect.apply(callback, this, callbackArgs);
            };
        }

        const writableLengthBefore = socket.writableLength;
        const bytesWrittenBefore = socket.bytesWritten;
        try {
            const accepted = Reflect.apply(originalWrite, this, args);
            safeSinkEmit(sink, {
                type: 'hap-socket-write',
                ...connectionInfo(connection),
                writeId,
                bytes: data.length,
                accepted,
                writableLengthBefore,
                writableLengthAfter: socket.writableLength,
                bytesWrittenBefore,
                bytesWrittenAfter: socket.bytesWritten,
                destroyed: socket.destroyed,
            });
            return accepted;
        }
        catch (error) {
            safeSinkEmit(sink, {
                type: 'hap-socket-write-error',
                ...connectionInfo(connection),
                writeId,
                error: error instanceof Error ? error.message : String(error),
                destroyed: socket.destroyed,
            });
            throw error;
        }
    } as typeof socket.write;

    socket.on('drain', () => safeSinkEmit(sink, {
        type: 'hap-socket-drain',
        ...connectionInfo(connection),
        bytesWritten: socket.bytesWritten,
        writableLength: socket.writableLength,
    }));
    socket.on('error', error => safeSinkEmit(sink, {
        type: 'hap-socket-error',
        ...connectionInfo(connection),
        error: error.message,
        bytesWritten: socket.bytesWritten,
        writableLength: socket.writableLength,
    }));
    socket.on('close', hadError => safeSinkEmit(sink, {
        type: 'hap-socket-close',
        ...connectionInfo(connection),
        hadError,
        bytesRead: socket.bytesRead,
        bytesWritten: socket.bytesWritten,
    }));
}

export function registerHapTraceAccessory(port: number | undefined, name: string | undefined) {
    if (Number.isSafeInteger(port) && port! > 0 && name)
        accessoryNamesByPort.set(port!, name);
}

export function getHapTraceRequestId(request: Record<PropertyKey, any>) {
    return request?.[HAP_WIRE_TRACE_REQUEST_ID] as string | undefined;
}

export function emitHapWireTrace(event: HapWireTraceEvent, sensitive = false) {
    try {
        return installedSink.emit(event, sensitive);
    }
    catch {
        return false;
    }
}

export function isHapWireTraceActive() {
    try {
        return installedSink.isActive();
    }
    catch {
        return false;
    }
}

export function inspectHapTraceJpeg(jpeg: Buffer) {
    const result: Record<string, unknown> = {
        bytes: jpeg.length,
        sha256: sha256(jpeg),
        soi: jpeg.length >= 2 && jpeg[0] === 0xff && jpeg[1] === 0xd8,
        eoi: jpeg.length >= 2
            && jpeg[jpeg.length - 2] === 0xff
            && jpeg[jpeg.length - 1] === 0xd9,
        jfif: false,
        exif: false,
        iccProfile: false,
        adobe: false,
    };
    if (!result.soi)
        return result;

    let offset = 2;
    while (offset + 4 < jpeg.length) {
        if (jpeg[offset] !== 0xff)
            break;
        while (offset < jpeg.length && jpeg[offset] === 0xff)
            offset++;
        const marker = jpeg[offset++];
        if (result.firstMarker === undefined)
            result.firstMarker = `0x${marker.toString(16)}`;
        if (marker === 0xd9 || marker === 0xda)
            break;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7)
            continue;
        if (offset + 2 > jpeg.length)
            break;
        const length = jpeg.readUInt16BE(offset);
        if (length < 2 || offset + length > jpeg.length)
            break;
        const payload = jpeg.subarray(offset + 2, offset + length);
        if (marker === 0xe0 && payload.subarray(0, 5).equals(Buffer.from('JFIF\0')))
            result.jfif = true;
        else if (marker === 0xe1 && payload.subarray(0, 6).equals(Buffer.from('Exif\0\0')))
            result.exif = true;
        else if (marker === 0xe2 && payload.subarray(0, 12).equals(Buffer.from('ICC_PROFILE\0')))
            result.iccProfile = true;
        else if (marker === 0xee && payload.subarray(0, 5).equals(Buffer.from('Adobe')))
            result.adobe = true;
        const isSof = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof && length >= 8) {
            result.sof = `0x${marker.toString(16)}`;
            result.height = jpeg.readUInt16BE(offset + 3);
            result.width = jpeg.readUInt16BE(offset + 5);
            result.components = jpeg[offset + 7];
            break;
        }
        offset += length;
    }
    return result;
}

function decodeChunkedBody(wireBody: Buffer) {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let cursor = 0;
    while (true) {
        const lineEnd = wireBody.indexOf('\r\n', cursor, 'latin1');
        if (lineEnd < 0 || lineEnd - cursor > MAX_CHUNK_LINE_BYTES)
            return;
        const sizeText = wireBody.subarray(cursor, lineEnd)
            .toString('latin1')
            .split(';', 1)[0]
            .trim();
        if (!/^[0-9a-f]+$/i.test(sizeText))
            return;
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isSafeInteger(size) || size < 0)
            return;
        cursor = lineEnd + 2;
        if (!size) {
            while (true) {
                const trailerEnd = wireBody.indexOf('\r\n', cursor, 'latin1');
                if (trailerEnd < 0 || trailerEnd - cursor > MAX_CHUNK_LINE_BYTES)
                    return;
                if (trailerEnd === cursor) {
                    cursor += 2;
                    if (cursor !== wireBody.length)
                        return;
                    return Buffer.concat(chunks, bytes);
                }
                const trailer = wireBody.subarray(cursor, trailerEnd).toString('latin1');
                if (!trailer.includes(':'))
                    return;
                cursor = trailerEnd + 2;
            }
        }
        if (cursor + size + 2 > wireBody.length)
            return;
        chunks.push(wireBody.subarray(cursor, cursor + size));
        bytes += size;
        cursor += size;
        if (wireBody[cursor] !== 0x0d || wireBody[cursor + 1] !== 0x0a)
            return;
        cursor += 2;
    }
}

function captureHapResourceResponse(
    connection: Record<PropertyKey, any>,
    sink: HapWireTraceSink,
    details: {
        requestId?: string;
        data?: Buffer;
        responseComplete?: boolean;
    },
) {
    const { requestId, data } = details;
    if (!requestId || !data)
        return;
    const skipped = skippedResourceResponses.get(connection);
    if (skipped?.has(requestId)) {
        if (details.responseComplete) {
            skipped.delete(requestId);
            if (!skipped.size)
                skippedResourceResponses.delete(connection);
        }
        return;
    }
    let responses = resourceResponses.get(connection);
    if (!responses) {
        responses = new Map();
        resourceResponses.set(connection, responses);
    }
    let response = responses.get(requestId);
    if (!response) {
        if (responses.size >= MAX_RESOURCE_RESPONSES_PER_CONNECTION) {
            let skipped = skippedResourceResponses.get(connection);
            if (!skipped) {
                skipped = new Set();
                skippedResourceResponses.set(connection, skipped);
            }
            skipped.add(requestId);
            safeSinkEmit(sink, {
                type: 'hap-resource-response-capture-skipped',
                ...connectionInfo(connection),
                requestId,
                reason: 'concurrent-response-limit',
            });
            return;
        }
        response = {
            chunks: [],
            bytes: 0,
            capturedBytes: 0,
            truncated: false,
        };
        responses.set(requestId, response);
    }
    response.bytes += data.length;
    if (!response.truncated) {
        const remaining = MAX_RESOURCE_RESPONSE_BYTES - response.capturedBytes;
        if (data.length > remaining) {
            if (remaining > 0) {
                response.chunks.push(data.subarray(0, remaining));
                response.capturedBytes += remaining;
            }
            response.truncated = true;
        }
        else {
            response.chunks.push(data);
            response.capturedBytes += data.length;
        }
    }
    if (!details.responseComplete)
        return;

    responses.delete(requestId);
    const raw = Buffer.concat(response.chunks, response.capturedBytes);
    const marker = raw.indexOf(HTTP_HEADER_END);
    let statusLine: string | undefined;
    let statusCode: number | undefined;
    let contentType: string | undefined;
    let declaredContentLength: number | undefined;
    let transferEncoding: string | undefined;
    let wireBody: Buffer | undefined;
    let body: Buffer | undefined;
    let chunkedBodyComplete: boolean | undefined;
    if (marker >= 0) {
        const lines = raw.subarray(0, marker).toString('latin1').split('\r\n');
        statusLine = lines.shift();
        const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})(?:\s|$)/.exec(statusLine || '');
        if (statusMatch)
            statusCode = Number.parseInt(statusMatch[1], 10);
        for (const line of lines) {
            const colon = line.indexOf(':');
            if (colon <= 0)
                continue;
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (name === 'content-type')
                contentType = value;
            else if (name === 'content-length' && /^\d+$/.test(value))
                declaredContentLength = Number.parseInt(value, 10);
            else if (name === 'transfer-encoding')
                transferEncoding = value;
        }
        wireBody = raw.subarray(marker + HTTP_HEADER_END.length);
        const chunked = transferEncoding
            ?.split(',')
            .some(value => value.trim().toLowerCase() === 'chunked');
        if (chunked && !response.truncated) {
            body = decodeChunkedBody(wireBody);
            chunkedBodyComplete = body !== undefined;
        }
        else {
            body = wireBody;
        }
    }

    const jpeg = body
        && !response.truncated
        && body.length >= 2
        && body[0] === 0xff
        && body[1] === 0xd8
        ? inspectHapTraceJpeg(body)
        : undefined;
    safeSinkEmit(sink, {
        type: 'hap-resource-response',
        ...connectionInfo(connection),
        requestId,
        bytes: response.bytes,
        capturedBytes: response.capturedBytes,
        truncated: response.truncated,
        headerComplete: marker >= 0,
        statusLine,
        statusCode,
        contentType,
        declaredContentLength,
        transferEncoding,
        wireBodyBytes: wireBody?.length,
        chunkedBodyComplete,
        bodyBytes: body?.length,
        bodySha256: body && !response.truncated ? sha256(body) : undefined,
        contentLengthMatches: body && declaredContentLength !== undefined
            ? body.length === declaredContentLength
            : undefined,
        jpeg,
    });
}

export function traceHapResponseBoundary(
    connection: Record<PropertyKey, any>,
    details: {
        requestId?: string;
        method?: string;
        url?: string;
        data?: Buffer;
        responseComplete?: boolean;
        allRequestsComplete?: boolean;
        fatal?: string;
    },
) {
    try {
        const sink = installedSink;
        if (!emitConnection(connection, sink))
            return;
        if (details.url === '/resource') {
            captureHapResourceResponse(connection, sink, {
                requestId: details.requestId,
                data: details.data,
                responseComplete: details.responseComplete,
            });
        }
        safeSinkEmit(sink, {
            type: details.fatal ? 'hap-response-framing-error' : 'hap-response-boundary',
            ...connectionInfo(connection),
            requestId: details.requestId,
            method: details.method,
            url: details.url,
            bytes: details.data?.length,
            sha256: details.data && details.url !== '/resource'
                ? sha256(details.data)
                : undefined,
            responseComplete: details.responseComplete,
            allRequestsComplete: details.allRequestsComplete,
            fatal: details.fatal,
            handlingRequest: connection.handlingRequest,
        });
    }
    catch {
        // Diagnostics must never alter HAP framing, encryption, or delivery.
    }
}

type PatchableHapConnection = {
    prototype: Record<PropertyKey, any>;
};

export function installHapWireTrace(
    Connection: PatchableHapConnection = HAPConnection as unknown as PatchableHapConnection,
    sink: HapWireTraceSink = socketTraceSink,
) {
    const prototype = Connection.prototype;
    const installed = prototype[HAP_WIRE_TRACE_PATCH] as {
        version?: string;
        sink?: HapWireTraceSink;
    } | undefined;
    if (installed?.version === HAP_WIRE_TRACE_VERSION) {
        installedSink = sink;
        installed.sink = sink;
        return true;
    }

    const originalAuthenticated = prototype.connectionAuthenticated;
    const originalEncrypt = prototype.encrypt;
    const originalDecrypt = prototype.decrypt;
    const originalRequest = prototype.handleHttpServerRequest;
    const originalListening = prototype.onHttpServerListening;
    const originalSocketClose = prototype.onTCPSocketClose;
    const originalClose = prototype.close;
    if (typeof originalAuthenticated !== 'function'
        || typeof originalEncrypt !== 'function'
        || typeof originalDecrypt !== 'function'
        || typeof originalRequest !== 'function'
        || typeof originalListening !== 'function'
        || typeof originalSocketClose !== 'function'
        || typeof originalClose !== 'function')
        return false;

    installedSink = sink;
    prototype.connectionAuthenticated = function (...args: any[]) {
        const result = Reflect.apply(originalAuthenticated, this, args);
        emitConnection(this, installedSink);
        return result;
    };
    prototype.encrypt = function (data: Buffer, ...args: any[]) {
        if (!Buffer.isBuffer(data) || !emitConnection(this, installedSink))
            return Reflect.apply(originalEncrypt, this, [data, ...args]);
        const encryption = this.encryption;
        const counterStart = encryption?.accessoryToControllerCount;
        const encryptedActive = Buffer.isBuffer(encryption?.accessoryToControllerKey)
            && encryption.accessoryToControllerKey.length > 0
            && encryption.controllerToAccessoryCount > 0;
        let wire: Buffer;
        try {
            wire = Reflect.apply(originalEncrypt, this, [data, ...args]);
        }
        catch (error) {
            safeSinkEmit(installedSink, {
                type: 'hap-encrypt-error',
                ...connectionInfo(this),
                encryptedActive,
                counterStart,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        try {
            safeSinkEmit(installedSink, {
                type: 'hap-encrypt',
                ...connectionInfo(this),
                encryptedActive,
                counterStart,
                counterEnd: encryption?.accessoryToControllerCount,
                plaintextBytes: data.length,
                plaintextSha256: sha256(data),
                firstLine: firstProtocolLine(data),
                wireBytes: Buffer.isBuffer(wire) ? wire.length : undefined,
                wireSha256: Buffer.isBuffer(wire) ? sha256(wire) : undefined,
                recordLengths: Buffer.isBuffer(wire) && encryptedActive
                    ? getHapRecordLengths(wire)
                    : undefined,
                handlingRequest: this.handlingRequest,
            });
        }
        catch {
        }
        return wire;
    };
    prototype.decrypt = function (wire: Buffer, ...args: any[]) {
        if (!Buffer.isBuffer(wire) || !emitConnection(this, installedSink))
            return Reflect.apply(originalDecrypt, this, [wire, ...args]);
        const encryption = this.encryption;
        const counterStart = encryption?.controllerToAccessoryCount;
        const incompleteBytesBefore = encryption?.incompleteFrame?.length || 0;
        let plaintext: Buffer;
        try {
            plaintext = Reflect.apply(originalDecrypt, this, [wire, ...args]);
        }
        catch (error) {
            safeSinkEmit(installedSink, {
                type: 'hap-decrypt-error',
                ...connectionInfo(this),
                counterStart,
                wireBytes: wire.length,
                wireSha256: sha256(wire),
                incompleteBytesBefore,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
        try {
            safeSinkEmit(installedSink, {
                type: 'hap-decrypt',
                ...connectionInfo(this),
                counterStart,
                counterEnd: encryption?.controllerToAccessoryCount,
                wireBytes: wire.length,
                wireSha256: sha256(wire),
                plaintextBytes: Buffer.isBuffer(plaintext) ? plaintext.length : undefined,
                plaintextSha256: Buffer.isBuffer(plaintext) ? sha256(plaintext) : undefined,
                firstLine: Buffer.isBuffer(plaintext) ? firstProtocolLine(plaintext) : undefined,
                incompleteBytesBefore,
                incompleteBytesAfter: encryption?.incompleteFrame?.length || 0,
            });
        }
        catch {
        }
        return plaintext;
    };
    prototype.handleHttpServerRequest = function (
        request: Record<PropertyKey, any>,
        ...args: any[]
    ) {
        if (emitConnection(this, installedSink)) {
            try {
                const state = stateFor(this);
                const requestId = `${state.id}-${++state.requestSequence}`;
                request[HAP_WIRE_TRACE_REQUEST_ID] = requestId;
                safeSinkEmit(installedSink, {
                    type: 'hap-http-request',
                    ...connectionInfo(this),
                    requestId,
                    method: request?.method,
                    url: request?.url,
                    contentLength: request?.headers?.['content-length'],
                    handlingRequest: this.handlingRequest,
                });

                if (request?.url === '/resource' && typeof request.on === 'function') {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    let capturedBytes = 0;
                    let truncated = false;
                    request.on('data', (incoming: Buffer) => {
                        try {
                            const chunk = Buffer.isBuffer(incoming)
                                ? incoming
                                : Buffer.from(incoming);
                            bytes += chunk.length;
                            if (truncated)
                                return;
                            const remaining = MAX_RESOURCE_REQUEST_BYTES
                                - capturedBytes;
                            if (chunk.length > remaining) {
                                if (remaining > 0) {
                                    chunks.push(chunk.subarray(0, remaining));
                                    capturedBytes += remaining;
                                }
                                truncated = true;
                            }
                            else {
                                chunks.push(chunk);
                                capturedBytes += chunk.length;
                            }
                        }
                        catch {
                            truncated = true;
                        }
                    });
                    request.once('end', () => {
                        try {
                            const body = Buffer.concat(chunks);
                            let resource: Record<string, unknown> | undefined;
                            if (!truncated) {
                                try {
                                    const parsed = JSON.parse(body.toString('utf8'));
                                    resource = {
                                        resourceType: parsed?.['resource-type'],
                                        aid: parsed?.aid,
                                        width: parsed?.['image-width'],
                                        height: parsed?.['image-height'],
                                        reason: parsed?.reason,
                                    };
                                }
                                catch {
                                }
                            }
                            safeSinkEmit(installedSink, {
                                type: 'hap-resource-request',
                                ...connectionInfo(this),
                                requestId,
                                bytes,
                                capturedBytes: body.length,
                                sha256: sha256(body),
                                truncated,
                                ...resource,
                            });
                        }
                        catch {
                        }
                    });
                }
            }
            catch {
            }
        }
        return Reflect.apply(originalRequest, this, [request, ...args]);
    };
    prototype.onHttpServerListening = function (...args: any[]) {
        const result = Reflect.apply(originalListening, this, args);
        try {
            const httpSocket = this.httpSocket;
            if (httpSocket && typeof httpSocket.once === 'function') {
                httpSocket.once('connect', () => emitConnection(this, installedSink));
            }
        }
        catch {
        }
        return result;
    };
    prototype.close = function (...args: any[]) {
        const state = stateFor(this);
        if (!state.closeRequested && emitConnection(this, installedSink)) {
            state.closeRequested = true;
            safeSinkEmit(installedSink, {
                type: 'hap-close-requested',
                ...connectionInfo(this),
            });
        }
        return Reflect.apply(originalClose, this, args);
    };
    prototype.onTCPSocketClose = function (...args: any[]) {
        if (emitConnection(this, installedSink)) {
            safeSinkEmit(installedSink, {
                type: 'hap-connection-closed',
                ...connectionInfo(this),
            });
        }
        return Reflect.apply(originalSocketClose, this, args);
    };
    prototype[HAP_WIRE_TRACE_PATCH] = {
        version: HAP_WIRE_TRACE_VERSION,
        sink,
    };
    return true;
}
