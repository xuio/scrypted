import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
    getHapRecordLengths,
    HapWireTraceEvent,
    HapWireTraceSink,
    inspectHapTraceJpeg,
    installHapWireTrace,
    SocketHapWireTraceSink,
    traceHapResponseBoundary,
} from '../src/hap-wire-trace';

class MemorySink implements HapWireTraceSink {
    events: { event: HapWireTraceEvent; sensitive: boolean }[] = [];
    readyGeneration = 0;

    emit(event: HapWireTraceEvent, sensitive = false) {
        this.events.push({ event, sensitive });
        return true;
    }

    isActive() {
        return true;
    }

    includeKeys() {
        return true;
    }

    runId() {
        return 'test-run';
    }

    generation() {
        return this.readyGeneration;
    }
}

function makeLayeredBuffer(data: Buffer, counter: { value: number }) {
    const chunks: Buffer[] = [];
    for (let offset = 0; offset < data.length;) {
        const length = Math.min(0x400, data.length - offset);
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16LE(length);
        chunks.push(
            prefix,
            Buffer.alloc(length, counter.value++ & 0xff),
            Buffer.alloc(16, 0xa5),
        );
        offset += length;
    }
    return Buffer.concat(chunks);
}

class FakeSocket extends EventEmitter {
    localAddress = '192.168.10.11';
    localPort = 42006;
    remoteAddress = '192.168.10.115';
    remotePort = 58201;
    writableLength = 0;
    bytesWritten = 0;
    bytesRead = 0;
    destroyed = false;

    write(data: Buffer, callback?: () => void) {
        this.writableLength += data.length;
        this.bytesWritten += data.length;
        queueMicrotask(() => {
            this.writableLength -= data.length;
            callback?.call(this);
        });
        return false;
    }

    destroy() {
        this.destroyed = true;
    }
}

function makeTraceControl() {
    return {
        version: 1,
        runId: 'test-run-reconnect',
        socketPath: '/tmp/scrypted-homekit-hap-trace-test.sock',
        token: 'a'.repeat(64),
        expiresAt: Date.now() + 60_000,
        includeKeys: true,
    };
}

class FakeCollectorTransport {
    writes: string[] = [];
    destroyed = false;
    throwOnWrite = false;
    throwOnDestroy = false;

    write(data: string | Buffer) {
        if (this.throwOnWrite)
            throw new Error('collector transport failed');
        this.writes.push(data.toString());
        return true;
    }

    destroy() {
        this.destroyed = true;
        if (this.throwOnDestroy)
            throw new Error('collector destroy failed');
    }
}

test('record parser accepts complete HAP records and rejects partial framing', () => {
    const counter = { value: 0 };
    const wire = makeLayeredBuffer(Buffer.alloc(2_100), counter);
    assert.deepEqual(getHapRecordLengths(wire), [1024, 1024, 52]);
    assert.equal(getHapRecordLengths(wire.subarray(0, -1)), undefined);

    const oversized = Buffer.alloc(18);
    oversized.writeUInt16LE(0x401);
    assert.equal(getHapRecordLengths(oversized), undefined);
});

test('JPEG inspection records the envelope and baseline dimensions', () => {
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([
            0xff, 0xc0,
            0x00, 0x11,
            0x08,
            0x02, 0xd0,
            0x05, 0x00,
            0x03,
            0x01, 0x11, 0x00,
            0x02, 0x11, 0x00,
            0x03, 0x11, 0x00,
        ]),
        Buffer.from([0xff, 0xd9]),
    ]);
    const inspected = inspectHapTraceJpeg(jpeg);
    assert.equal(inspected.soi, true);
    assert.equal(inspected.eoi, true);
    assert.equal(inspected.width, 1280);
    assert.equal(inspected.height, 720);
    assert.equal(inspected.components, 3);
    assert.equal(inspected.sof, '0xc0');
    assert.equal(inspected.firstMarker, '0xc0');
    assert.equal(inspected.jfif, false);
    assert.equal(inspected.exif, false);
    assert.equal(inspected.iccProfile, false);
    assert.equal(inspected.adobe, false);
});

test('JPEG inspection records common interchange metadata markers', () => {
    const jpeg = Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        Buffer.from([
            0xff, 0xe0, 0x00, 0x10,
            0x4a, 0x46, 0x49, 0x46, 0x00,
            0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
            0xff, 0xe1, 0x00, 0x08,
            0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
            0xff, 0xe2, 0x00, 0x10,
            0x49, 0x43, 0x43, 0x5f, 0x50, 0x52, 0x4f, 0x46, 0x49, 0x4c, 0x45, 0x00,
            0x01, 0x01,
            0xff, 0xee, 0x00, 0x07,
            0x41, 0x64, 0x6f, 0x62, 0x65,
        ]),
        Buffer.from([0xff, 0xd9]),
    ]);
    const inspected = inspectHapTraceJpeg(jpeg);
    assert.equal(inspected.firstMarker, '0xe0');
    assert.equal(inspected.jfif, true);
    assert.equal(inspected.exif, true);
    assert.equal(inspected.iccProfile, true);
    assert.equal(inspected.adobe, true);
});

test('a new collector-ready generation re-exports current session keys once', () => {
    const sink = new MemorySink();
    sink.readyGeneration = 1;

    class GenerationConnection {
        state = 2;
        handlingRequest = true;
        tcpSocket = new FakeSocket();
        encryption = {
            accessoryToControllerKey: Buffer.alloc(32, 1),
            controllerToAccessoryKey: Buffer.alloc(32, 2),
            accessoryToControllerCount: 7,
            controllerToAccessoryCount: 11,
        };

        connectionAuthenticated() {
        }

        encrypt(data: Buffer) {
            return Buffer.from(data);
        }

        decrypt(data: Buffer) {
            return Buffer.from(data);
        }

        handleHttpServerRequest() {
        }

        onHttpServerListening() {
        }

        onTCPSocketClose() {
        }

        close() {
        }
    }

    assert.equal(installHapWireTrace(GenerationConnection as any, sink), true);
    const connection = new GenerationConnection() as any;
    connection.connectionAuthenticated();
    let keyEvents = sink.events.filter(entry => entry.event.type === 'hap-session-keys');
    assert.equal(keyEvents.length, 1);
    assert.equal(keyEvents[0].event.accessoryToControllerCount, 7);
    assert.equal(keyEvents[0].event.controllerToAccessoryCount, 11);

    connection.encryption.accessoryToControllerCount = 19;
    connection.encryption.controllerToAccessoryCount = 23;
    sink.readyGeneration = 2;
    connection.encrypt(Buffer.from('first record after reconnect'));
    keyEvents = sink.events.filter(entry => entry.event.type === 'hap-session-keys');
    assert.equal(keyEvents.length, 2);
    assert.equal(keyEvents[1].event.accessoryToControllerCount, 19);
    assert.equal(keyEvents[1].event.controllerToAccessoryCount, 23);

    connection.encrypt(Buffer.from('same generation'));
    assert.equal(
        sink.events.filter(entry => entry.event.type === 'hap-session-keys').length,
        2,
    );
});

test('retry scheduling preserves queued key evidence and reconnects without another HAP event', async () => {
    const sink = new SocketHapWireTraceSink();
    const internal = sink as any;
    const transport = new FakeCollectorTransport();
    const sensitive = `${JSON.stringify({ type: 'hap-session-keys', connectionId: 'camera-1' })}\n`;
    const normal = `${JSON.stringify({ type: 'hap-encrypt', connectionId: 'camera-1' })}\n`;
    assert.equal(internal.queue(normal, false), true);
    assert.equal(internal.queue(sensitive, true), true);
    internal.control = makeTraceControl();
    internal.socket = new FakeCollectorTransport();
    internal.ready = true;
    internal.retryDelayMs = 10;
    let reconnects = 0;
    internal.connect = () => {
        reconnects++;
        internal.socket = transport;
        internal.ready = true;
        internal.flush();
    };
    internal.refreshControl = () => internal.connect();

    internal.disconnect(false, true);
    assert.equal(internal.queued.length, 1);
    assert.equal(internal.sensitiveQueued.length, 1);
    await new Promise(resolve => setTimeout(resolve, 40));

    assert.equal(reconnects, 1);
    assert.deepEqual(transport.writes, [sensitive, normal]);
    assert.equal(internal.queuedBytes, 0);
    internal.disconnect(false, false);
});

test('a non-retry disconnect cancels pending reconnect backoff', async () => {
    const sink = new SocketHapWireTraceSink();
    const internal = sink as any;
    internal.control = makeTraceControl();
    internal.retryDelayMs = 10;
    let reconnects = 0;
    internal.connect = () => reconnects++;

    internal.disconnect(false, true);
    assert.ok(internal.retryTimer);
    internal.disconnect(false, false);
    assert.equal(internal.retryTimer, undefined);
    assert.equal(internal.nextConnectAttempt, 0);
    assert.equal(internal.retryDelayMs, 250);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(reconnects, 0);
});

test('a lost collector advances generation before backoff traffic is queued', () => {
    const sink = new SocketHapWireTraceSink();
    const internal = sink as any;
    internal.control = makeTraceControl();
    internal.refreshControl = () => {};
    internal.connect = () => {};
    internal.flush = () => {};

    class ReconnectConnection {
        state = 2;
        handlingRequest = true;
        tcpSocket = new FakeSocket();
        encryption = {
            accessoryToControllerKey: Buffer.alloc(32, 1),
            controllerToAccessoryKey: Buffer.alloc(32, 2),
            accessoryToControllerCount: 3,
            controllerToAccessoryCount: 5,
        };

        connectionAuthenticated() {
        }

        encrypt(data: Buffer) {
            this.encryption.accessoryToControllerCount++;
            return Buffer.from(data);
        }

        decrypt(data: Buffer) {
            return Buffer.from(data);
        }

        handleHttpServerRequest() {
        }

        onHttpServerListening() {
        }

        onTCPSocketClose() {
        }

        close() {
        }
    }

    assert.equal(installHapWireTrace(ReconnectConnection as any, sink), true);
    const connection = new ReconnectConnection() as any;
    connection.connectionAuthenticated();
    assert.equal(internal.sensitiveQueued.length, 1);

    // Model the first key record having reached the original collector.
    internal.sensitiveQueued.splice(0);
    internal.queued.splice(0);
    internal.sensitiveQueuedBytes = 0;
    internal.queuedBytes = 0;
    internal.socket = new FakeCollectorTransport();
    internal.ready = true;
    internal.disconnect(false, true);
    assert.equal(sink.generation(), 1);

    connection.encrypt(Buffer.from('record queued during reconnect backoff'));
    assert.equal(internal.sensitiveQueued.length, 1);
    const keyEvent = JSON.parse(internal.sensitiveQueued[0].line);
    assert.equal(keyEvent.type, 'hap-session-keys');
    assert.equal(keyEvent.accessoryToControllerCount, 3);
    assert.equal(keyEvent.controllerToAccessoryCount, 5);
    assert.ok(internal.queued.some((entry: { line: string }) =>
        JSON.parse(entry.line).type === 'hap-encrypt'));

    // Repeated disconnected cleanup must not create phantom generations.
    internal.disconnect(false, true);
    assert.equal(sink.generation(), 1);
    internal.disconnect(false, false);
});

test('normal queue pressure preserves session keys and emits a bounded drop marker', () => {
    const sink = new SocketHapWireTraceSink();
    const internal = sink as any;
    const sensitive = `${JSON.stringify({
        type: 'hap-session-keys',
        connectionId: 'camera-priority',
        accessoryToControllerKey: 'a'.repeat(44),
        controllerToAccessoryKey: 'b'.repeat(44),
    })}\n`;
    assert.equal(internal.queue(sensitive, true), true);
    for (let i = 0; i < 400; i++) {
        internal.queue(`${JSON.stringify({
            type: 'hap-encrypt',
            sequence: i,
            payload: 'x'.repeat(4_096),
        })}\n`, false);
    }

    assert.equal(internal.sensitiveQueued.length, 1);
    assert.equal(internal.sensitiveQueued[0].line, sensitive);
    assert.ok(internal.droppedEvents > 0);
    assert.ok(internal.droppedBytes > 0);
    assert.ok(internal.queuedBytes <= 512 * 1024);

    const transport = new FakeCollectorTransport();
    internal.control = makeTraceControl();
    internal.socket = transport;
    internal.ready = true;
    internal.flush();

    const marker = JSON.parse(transport.writes[0]);
    assert.equal(marker.type, 'hap-trace-dropped');
    assert.ok(marker.droppedEvents > 0);
    assert.ok(marker.droppedBytes > 0);
    assert.equal(transport.writes[1], sensitive);
    assert.equal(internal.queuedBytes, 0);
    assert.equal(internal.droppedEvents, 0);
    assert.equal(internal.droppedBytes, 0);
    internal.disconnect(false, false);
});

test('socket trace diagnostics absorb serialization and transport failures', () => {
    const serializationSink = new SocketHapWireTraceSink();
    const serializationInternal = serializationSink as any;
    serializationInternal.refreshControl = () => {};
    serializationInternal.connect = () => {};
    serializationInternal.flush = () => {};
    serializationInternal.control = makeTraceControl();
    const circular: HapWireTraceEvent = { type: 'circular-diagnostic' };
    circular.circular = circular;
    assert.doesNotThrow(() => {
        assert.equal(serializationSink.emit(circular), false);
    });
    serializationInternal.disconnect(false, false);

    const transportSink = new SocketHapWireTraceSink();
    const transportInternal = transportSink as any;
    const transport = new FakeCollectorTransport();
    transport.throwOnWrite = true;
    transport.throwOnDestroy = true;
    transportInternal.control = makeTraceControl();
    transportInternal.socket = transport;
    transportInternal.ready = true;
    assert.equal(transportInternal.queue('{"type":"queued"}\n', false), true);
    assert.doesNotThrow(() => transportInternal.flush());
    assert.equal(transportInternal.ready, false);
    assert.equal(transportInternal.socket, undefined);
    assert.equal(transportInternal.queued.length, 1);
    assert.ok(transportInternal.queuedBytes > 0);
    transportInternal.disconnect(false, false);
});

test('wire trace correlates resource requests, encrypted records, keys, and socket writes', async () => {
    const sink = new MemorySink();

    class FakeConnection {
        sessionID = 'hap-session';
        state = 2;
        handlingRequest = true;
        localAddress = '192.168.10.11';
        remoteAddress = '192.168.10.115';
        remotePort = 58201;
        internalHttpServerAddress = '127.0.0.1';
        internalHttpServerPort = 51111;
        httpSocket = Object.assign(new EventEmitter(), {
            localAddress: '127.0.0.1',
            localPort: 51112,
        });
        tcpSocket = new FakeSocket();
        encryption = {
            accessoryToControllerKey: Buffer.alloc(32, 1),
            controllerToAccessoryKey: Buffer.alloc(32, 2),
            accessoryToControllerCount: 0,
            controllerToAccessoryCount: 1,
            incompleteFrame: undefined as Buffer | undefined,
        };
        private outboundCounter = { value: 0 };

        connectionAuthenticated() {
            this.state = 2;
        }

        encrypt(data: Buffer) {
            const wire = makeLayeredBuffer(data, this.outboundCounter);
            this.encryption.accessoryToControllerCount = this.outboundCounter.value;
            return wire;
        }

        decrypt(data: Buffer) {
            this.encryption.controllerToAccessoryCount++;
            return data;
        }

        handleHttpServerRequest() {
        }

        onHttpServerListening() {
        }

        onTCPSocketClose() {
            this.state = 5;
        }

        close() {
            this.state = 4;
        }
    }

    assert.equal(installHapWireTrace(FakeConnection as any, sink), true);
    const connection = new FakeConnection() as any;
    connection.connectionAuthenticated('controller');

    const request = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/resource',
        headers: {
            'content-length': '88',
        },
    });
    connection.handleHttpServerRequest(request);
    const body = Buffer.from(JSON.stringify({
        'resource-type': 'image',
        aid: 1,
        'image-width': 1280,
        'image-height': 720,
        reason: 0,
    }));
    request.emit('data', body);
    request.emit('end');

    const plaintext = Buffer.alloc(2_100, 0x41);
    const wire = connection.encrypt(plaintext);
    let callbackThis: unknown;
    connection.tcpSocket.write(wire, function (this: unknown) {
        callbackThis = this;
    });
    await new Promise(resolve => setImmediate(resolve));

    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const response = Buffer.concat([
        Buffer.from(
            'HTTP/1.1 200 OK\r\n'
            + 'Content-Type: image/jpeg\r\n'
            + `Content-Length: ${jpeg.length}\r\n\r\n`,
        ),
        jpeg,
    ]);
    traceHapResponseBoundary(connection, {
        requestId: 'resource-response-1',
        method: 'POST',
        url: '/resource',
        data: response.subarray(0, 19),
    });
    traceHapResponseBoundary(connection, {
        requestId: 'resource-response-1',
        method: 'POST',
        url: '/resource',
        data: response.subarray(19),
        responseComplete: true,
        allRequestsComplete: true,
    });

    const byType = new Map<string, HapWireTraceEvent[]>();
    for (const { event } of sink.events) {
        const events = byType.get(event.type) || [];
        events.push(event);
        byType.set(event.type, events);
    }

    assert.equal(byType.get('hap-session-keys')?.length, 1);
    assert.equal(byType.get('hap-http-request')?.length, 1);
    const resource = byType.get('hap-resource-request')?.[0];
    assert.equal(resource?.width, 1280);
    assert.equal(resource?.height, 720);
    assert.equal(resource?.reason, 0);
    assert.equal(resource?.truncated, false);
    assert.deepEqual(
        byType.get('hap-encrypt')?.[0]?.recordLengths,
        [1024, 1024, 52],
    );
    assert.equal(byType.get('hap-socket-write')?.[0]?.accepted, false);
    assert.equal(byType.get('hap-socket-write-complete')?.length, 1);
    const resourceResponse = byType.get('hap-resource-response')?.[0];
    assert.equal(resourceResponse?.statusCode, 200);
    assert.equal(resourceResponse?.contentLengthMatches, true);
    assert.equal(resourceResponse?.bodySha256, createHash('sha256').update(jpeg).digest('hex'));
    assert.deepEqual(resourceResponse?.jpeg, inspectHapTraceJpeg(jpeg));
    assert.strictEqual(callbackThis, connection.tcpSocket);
    assert.ok(sink.events.some(entry => entry.sensitive
        && entry.event.type === 'hap-session-keys'));
});

test('diagnostic sink failures cannot break HAP traffic', () => {
    const throwingSink: HapWireTraceSink = {
        emit() {
            throw new Error('collector failed');
        },
        isActive() {
            return true;
        },
        includeKeys() {
            return false;
        },
        runId() {
            return 'throwing-sink-run';
        },
    };

    class NoThrowConnection {
        state = 2;
        handlingRequest = true;
        tcpSocket = new FakeSocket();
        encryption = {
            accessoryToControllerKey: Buffer.alloc(32, 1),
            controllerToAccessoryKey: Buffer.alloc(32, 2),
            accessoryToControllerCount: 0,
            controllerToAccessoryCount: 1,
        };

        connectionAuthenticated() {
        }

        encrypt(data: Buffer) {
            return Buffer.from(data);
        }

        decrypt(data: Buffer) {
            return Buffer.from(data);
        }

        handleHttpServerRequest() {
        }

        onHttpServerListening() {
        }

        onTCPSocketClose() {
        }

        close() {
        }
    }

    assert.equal(installHapWireTrace(NoThrowConnection as any, throwingSink), true);
    const connection = new NoThrowConnection() as any;
    assert.doesNotThrow(() => connection.connectionAuthenticated());
    assert.deepEqual(connection.encrypt(Buffer.from('response')), Buffer.from('response'));
    assert.deepEqual(connection.decrypt(Buffer.from('request')), Buffer.from('request'));

    const request = Object.assign(new EventEmitter(), {
        method: 'POST',
        url: '/resource',
        headers: {},
    });
    assert.doesNotThrow(() => connection.handleHttpServerRequest(request));
    assert.doesNotThrow(() => {
        request.emit('data', Buffer.from('{}'));
        request.emit('end');
    });
    assert.doesNotThrow(() => traceHapResponseBoundary(connection, {
        requestId: 'resource-no-throw',
        method: 'POST',
        url: '/resource',
        data: Buffer.from('HTTP/1.1 500 Error\r\nContent-Length: 0\r\n\r\n'),
        responseComplete: true,
        allRequestsComplete: true,
    }));
});
