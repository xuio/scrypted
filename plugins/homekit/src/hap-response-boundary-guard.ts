import { HAPConnection, HAPConnectionState } from './hap';
import {
    getHapTraceRequestId,
    traceHapResponseBoundary,
} from './hap-wire-trace';

const RESPONSE_BOUNDARY_GUARD = Symbol.for('@scrypted/homekit/response-boundary-guard');
const RESPONSE_BOUNDARY_GUARD_VERSION = '2026-07-16-v2';
const MAX_HTTP_HEADER_BYTES = 64 * 1024;
const MAX_CHUNK_LINE_BYTES = 8 * 1024;
const HTTP_HEADER_END = Buffer.from('\r\n\r\n');

export interface HapResponseRequest {
    id?: string;
    method?: string;
    url?: string;
}

type ResponseMode =
    | { type: 'headers'; pending: Buffer }
    | { type: 'fixed'; remaining: number }
    | { type: 'chunked'; tracker: ChunkedBodyTracker }
    | { type: 'none' };

interface CurrentResponse {
    request: HapResponseRequest;
    mode: ResponseMode;
    finalResponse: boolean;
}

interface PendingSlice {
    type: 'slice';
    input: Buffer;
    start: number;
    end: number;
    response: CurrentResponse;
    responseComplete: boolean;
    complete: boolean;
}

type PendingOutput = PendingSlice;

export interface HapResponseForwardChunk {
    buffer: Buffer;
    request: HapResponseRequest;
    responseComplete: boolean;
    complete: boolean;
}

export interface HapResponseForwardResult {
    chunks: HapResponseForwardChunk[];
    fatal?: string;
}

function parseNonNegativeInteger(value: string) {
    if (!/^\d+$/.test(value))
        return;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        return;
    return parsed;
}

function parseResponseHeaders(header: Buffer, method?: string): {
    mode: ResponseMode;
    finalResponse: boolean;
} {
    const text = header.toString('latin1');
    const lines = text.slice(0, -4).split('\r\n');
    const statusMatch = /^HTTP\/\d+\.\d+\s+(\d{3})(?:\s|$)/i.exec(lines.shift() || '');
    if (!statusMatch)
        throw new Error('invalid HTTP response status line');
    const status = Number(statusMatch[1]);
    const headers = new Map<string, string[]>();
    for (const line of lines) {
        const separator = line.indexOf(':');
        if (separator <= 0)
            throw new Error('invalid HTTP response header');
        const name = line.slice(0, separator).trim().toLowerCase();
        const value = line.slice(separator + 1).trim();
        const values = headers.get(name) || [];
        values.push(value);
        headers.set(name, values);
    }

    const informational = status >= 100 && status < 200 && status !== 101;
    const noBody = informational
        || status === 204
        || status === 304
        || method?.toUpperCase() === 'HEAD';
    if (noBody) {
        return {
            mode: { type: 'none' },
            finalResponse: !informational,
        };
    }

    const transferEncoding = (headers.get('transfer-encoding') || [])
        .flatMap(value => value.split(','))
        .map(value => value.trim().toLowerCase());
    if (transferEncoding.includes('chunked')) {
        return {
            mode: { type: 'chunked', tracker: new ChunkedBodyTracker() },
            finalResponse: true,
        };
    }

    const lengths = (headers.get('content-length') || [])
        .flatMap(value => value.split(','))
        .map(value => value.trim())
        .filter(Boolean);
    if (lengths.length) {
        const length = parseNonNegativeInteger(lengths[0]);
        if (length === undefined || lengths.some(value => parseNonNegativeInteger(value) !== length))
            throw new Error('invalid or conflicting HTTP Content-Length');
        return {
            mode: length
                ? { type: 'fixed', remaining: length }
                : { type: 'none' },
            finalResponse: true,
        };
    }

    throw new Error('HTTP response has no Content-Length or chunked framing');
}

class ChunkedBodyTracker {
    private phase: 'size' | 'data' | 'data-crlf' | 'trailers' = 'size';
    private line = '';
    private lineSawCr = false;
    private remaining = 0;
    private dataCrlfOffset = 0;

    private consumeLineByte(byte: number): string | undefined {
        if (this.lineSawCr) {
            if (byte !== 0x0a)
                throw new Error('invalid chunked response line ending');
            const line = this.line;
            this.line = '';
            this.lineSawCr = false;
            return line;
        }
        if (byte === 0x0d) {
            this.lineSawCr = true;
            return;
        }
        if (byte === 0x0a)
            throw new Error('invalid chunked response line ending');
        if (this.line.length >= MAX_CHUNK_LINE_BYTES)
            throw new Error('chunked response line too long');
        this.line += String.fromCharCode(byte);
    }

    consume(data: Buffer, offset: number): { consumed: number; complete: boolean } {
        const start = offset;
        while (offset < data.length) {
            if (this.phase === 'data') {
                const consumed = Math.min(this.remaining, data.length - offset);
                offset += consumed;
                this.remaining -= consumed;
                if (!this.remaining) {
                    this.phase = 'data-crlf';
                    this.dataCrlfOffset = 0;
                }
                continue;
            }

            if (this.phase === 'data-crlf') {
                const expected = this.dataCrlfOffset ? 0x0a : 0x0d;
                if (data[offset++] !== expected)
                    throw new Error('invalid chunked response data terminator');
                this.dataCrlfOffset++;
                if (this.dataCrlfOffset === 2)
                    this.phase = 'size';
                continue;
            }

            const line = this.consumeLineByte(data[offset++]);
            if (line === undefined)
                continue;
            if (this.phase === 'trailers') {
                if (!line.length)
                    return { consumed: offset - start, complete: true };
                continue;
            }

            const sizeText = line.split(';', 1)[0].trim();
            if (!/^[0-9a-f]+$/i.test(sizeText))
                throw new Error('invalid chunked response size');
            const size = Number.parseInt(sizeText, 16);
            if (!Number.isSafeInteger(size) || size < 0)
                throw new Error('invalid chunked response size');
            if (!size) {
                this.phase = 'trailers';
                continue;
            }
            this.remaining = size;
            this.phase = 'data';
        }
        return { consumed: offset - start, complete: false };
    }
}

/**
 * Tracks response boundaries on HAP-NodeJS' internal plaintext HTTP socket.
 * Chunks continue streaming immediately, but the connection remains in its
 * request-handling state until the complete HTTP message has been forwarded.
 */
export class HapResponseBoundaryFramer {
    private readonly requests: HapResponseRequest[] = [];
    private current?: CurrentResponse;
    private failed = false;

    enqueue(request?: string | HapResponseRequest) {
        if (this.failed)
            return;
        this.requests.push(typeof request === 'string'
            ? { method: request }
            : request || {});
    }

    private ensureCurrent() {
        if (!this.current) {
            this.current = {
                request: this.requests.shift() || {},
                mode: { type: 'headers', pending: Buffer.alloc(0) },
                finalResponse: true,
            };
        }
        return this.current;
    }

    private consumeHeaders(current: CurrentResponse, data: Buffer, offset: number) {
        const mode = current.mode;
        if (mode.type !== 'headers')
            throw new Error('response header parser is not active');
        let bodyOffset = -1;
        for (let prefix = Math.min(HTTP_HEADER_END.length - 1, mode.pending.length); prefix > 0; prefix--) {
            if (!mode.pending.subarray(mode.pending.length - prefix).equals(
                HTTP_HEADER_END.subarray(0, prefix),
            ))
                continue;
            const suffix = HTTP_HEADER_END.length - prefix;
            if (data.length - offset >= suffix
                && data.subarray(offset, offset + suffix).equals(
                    HTTP_HEADER_END.subarray(prefix),
                )) {
                bodyOffset = offset + suffix;
                break;
            }
        }
        if (bodyOffset < 0) {
            const marker = data.indexOf(HTTP_HEADER_END, offset);
            if (marker >= 0)
                bodyOffset = marker + HTTP_HEADER_END.length;
        }

        if (bodyOffset < 0) {
            const input = data.subarray(offset);
            if (mode.pending.length + input.length >= MAX_HTTP_HEADER_BYTES)
                throw new Error('HTTP response header too large');
            mode.pending = mode.pending.length
                ? Buffer.concat([mode.pending, input])
                : Buffer.from(input);
            return { consumed: input.length, complete: false };
        }

        const input = data.subarray(offset, bodyOffset);
        const header = mode.pending.length
            ? Buffer.concat([mode.pending, input])
            : input;
        const parsed = parseResponseHeaders(header, current.request.method);
        current.mode = parsed.mode;
        current.finalResponse = parsed.finalResponse;
        return {
            consumed: input.length,
            complete: parsed.mode.type === 'none',
        };
    }

    private consumeCurrent(current: CurrentResponse, data: Buffer, offset: number) {
        switch (current.mode.type) {
            case 'headers':
                return this.consumeHeaders(current, data, offset);
            case 'fixed': {
                const consumed = Math.min(current.mode.remaining, data.length - offset);
                current.mode.remaining -= consumed;
                return {
                    consumed,
                    complete: current.mode.remaining === 0,
                };
            }
            case 'chunked':
                return current.mode.tracker.consume(data, offset);
            case 'none':
                return { consumed: 0, complete: true };
        }
    }

    private appendOutput(
        outputs: PendingOutput[],
        current: CurrentResponse,
        input: Buffer,
        start: number,
        end: number,
    ) {
        if (end <= start)
            return;
        const last = outputs[outputs.length - 1];
        if (last?.type === 'slice'
            && last.input === input
            && last.response === current
            && last.end === start) {
            last.end = end;
            return;
        }
        outputs.push({
            type: 'slice',
            input,
            start,
            end,
            response: current,
            responseComplete: false,
            complete: false,
        });
    }

    private finishCurrent(outputs: PendingOutput[], current: CurrentResponse) {
        for (let index = outputs.length - 1; index >= 0; index--) {
            if (outputs[index].response !== current)
                continue;
            outputs[index].responseComplete = true;
            break;
        }
        // Events are safe only when every request already parsed on this HAP
        // connection has received its final response. A boundary between two
        // pipelined responses is valid HTTP framing, but the connection is
        // still handling requests and must retain queued characteristic events.
        if (current.finalResponse && this.requests.length === 0) {
            for (let index = outputs.length - 1; index >= 0; index--) {
                if (outputs[index].response !== current)
                    continue;
                outputs[index].complete = true;
                break;
            }
        }
        if (!current.finalResponse)
            this.requests.unshift(current.request);
        this.current = undefined;
    }

    push(data: Buffer): HapResponseForwardResult {
        if (this.failed)
            return { chunks: [], fatal: 'HTTP response boundary tracking is unavailable' };
        const outputs: PendingOutput[] = [];
        let offset = 0;
        try {
            while (offset < data.length) {
                const current = this.ensureCurrent();
                const start = offset;
                const result = this.consumeCurrent(current, data, offset);
                if (!result.consumed && !result.complete)
                    throw new Error('HTTP response parser made no progress');
                offset += result.consumed;
                this.appendOutput(outputs, current, data, start, offset);
                if (result.complete)
                    this.finishCurrent(outputs, current);
            }
        }
        catch (error) {
            this.current = undefined;
            this.requests.splice(0);
            this.failed = true;
            return {
                chunks: [],
                fatal: (error as Error)?.message || String(error),
            };
        }

        return {
            chunks: outputs.map(output => ({
                buffer: output.input.subarray(output.start, output.end),
                request: output.response.request,
                responseComplete: output.responseComplete,
                complete: output.complete,
            })),
        };
    }
}

type PatchableHapConnection = {
    prototype: Record<PropertyKey, any>;
};

function forwardHapResponseChunk(
    connection: Record<PropertyKey, any>,
    chunk: HapResponseForwardChunk,
) {
    const {
        buffer: data,
        complete,
        request,
        responseComplete,
    } = chunk;
    traceHapResponseBoundary(connection, {
        requestId: request.id,
        method: request.method,
        url: request.url,
        data,
        responseComplete,
        allRequestsComplete: complete,
    });
    const encrypted = connection.encrypt(data);
    connection.tcpSocket.write(
        encrypted,
        connection.handleTCPSocketWriteFulfilled.bind(connection),
    );
    if (!complete) {
        // HAP-NodeJS incorrectly clears this after every internal socket chunk.
        // Keep events queued until the full HTTP body has crossed the proxy.
        connection.handlingRequest = true;
        return;
    }

    connection.handlingRequest = false;
    if (connection.state === HAPConnectionState.TO_BE_TEARED_DOWN) {
        setTimeout(() => connection.close(), 10);
    }
    else if (connection.state < HAPConnectionState.TO_BE_TEARED_DOWN) {
        if (!connection.eventsTimer || connection.eventsQueuedForImmediateDelivery)
            connection.writeQueuedEventNotifications();
    }
}

export function installHapResponseBoundaryGuard(
    Connection: PatchableHapConnection = HAPConnection as unknown as PatchableHapConnection,
) {
    const prototype = Connection.prototype;
    const installed = prototype[RESPONSE_BOUNDARY_GUARD] as {
        originalRequest?: (...args: any[]) => any;
        originalResponse?: (...args: any[]) => any;
        version?: string;
    } | undefined;
    if (installed?.version === RESPONSE_BOUNDARY_GUARD_VERSION)
        return true;

    const originalRequest = installed?.originalRequest || prototype.handleHttpServerRequest;
    const originalResponse = installed?.originalResponse || prototype.handleHttpServerResponse;
    if (typeof originalRequest !== 'function'
        || typeof originalResponse !== 'function'
        || typeof prototype.encrypt !== 'function'
        || typeof prototype.handleTCPSocketWriteFulfilled !== 'function'
        || typeof prototype.writeQueuedEventNotifications !== 'function'
        || typeof prototype.close !== 'function')
        return false;

    const states = new WeakMap<object, HapResponseBoundaryFramer>();
    const stateFor = (connection: object) => {
        let state = states.get(connection);
        if (!state) {
            state = new HapResponseBoundaryFramer();
            states.set(connection, state);
        }
        return state;
    };

    prototype.handleHttpServerRequest = function (request: {
        method?: string;
        url?: string;
    }, ...args: any[]) {
        // Mirror HAP-NodeJS' own request eligibility. In particular, a
        // pipelined request arriving after an unpair operation has moved the
        // connection to TO_BE_TEARED_DOWN is ignored upstream and therefore
        // must not create a phantom response in the boundary tracker.
        if (this.state <= HAPConnectionState.AUTHENTICATED)
            stateFor(this).enqueue({
                id: getHapTraceRequestId(request),
                method: request?.method,
                url: request?.url,
            });
        return Reflect.apply(originalRequest, this, [request, ...args]);
    };
    prototype.handleHttpServerResponse = function (data: Buffer, ...args: any[]) {
        if (!Buffer.isBuffer(data))
            return Reflect.apply(originalResponse, this, [data, ...args]);
        const result = stateFor(this).push(data);
        if (result.fatal) {
            try {
                console.error(`HomeKit HAP response framing failed; closing the connection: ${result.fatal}`);
            }
            catch {
            }
            traceHapResponseBoundary(this, {
                fatal: result.fatal,
            });
            this.close();
            return;
        }
        for (const chunk of result.chunks)
            forwardHapResponseChunk(this, chunk);
    };
    prototype[RESPONSE_BOUNDARY_GUARD] = {
        originalRequest,
        originalResponse,
        version: RESPONSE_BOUNDARY_GUARD_VERSION,
    };
    return true;
}
