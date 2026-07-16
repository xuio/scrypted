import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { EventedHTTPServer } from '../src/hap';
import {
    HapResponseBoundaryFramer,
    installHapResponseBoundaryGuard,
} from '../src/hap-response-boundary-guard';

function collect(
    framer: HapResponseBoundaryFramer,
    parts: Buffer[],
) {
    const chunks = parts.flatMap(part => framer.push(part).chunks);
    return {
        chunks,
        data: Buffer.concat(chunks.map(chunk => chunk.buffer)),
    };
}

test('fixed-length resource responses remain guarded through the final body byte', () => {
    const body = Buffer.alloc(256 * 1024, 0x41);
    const response = Buffer.concat([
        Buffer.from(
            'HTTP/1.1 200 OK\r\n'
            + 'Content-Type: image/jpeg\r\n'
            + `Content-Length: ${body.length}\r\n`
            + '\r\n',
        ),
        body,
    ]);
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('POST');
    const result = collect(framer, [
        response.subarray(0, 64 * 1024),
        response.subarray(64 * 1024, 128 * 1024),
        response.subarray(128 * 1024),
    ]);

    assert.ok(result.data.equals(response));
    assert.ok(result.chunks.slice(0, -1).every(chunk => !chunk.complete));
    assert.equal(result.chunks.at(-1)?.complete, true);
});

test('chunked resource framing survives awkward one-byte boundaries and trailers', () => {
    const response = Buffer.from(
        'HTTP/1.1 200 OK\r\n'
        + 'Content-Type: image/jpeg\r\n'
        + 'Transfer-Encoding: chunked\r\n'
        + '\r\n'
        + '4;name=value\r\nWiki\r\n'
        + '5\r\npedia\r\n'
        + '0\r\nX-Trace: complete\r\n\r\n',
    );
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('POST');
    const result = collect(
        framer,
        [...response].map((_byte, index) => response.subarray(index, index + 1)),
    );

    assert.ok(result.data.equals(response));
    assert.equal(result.chunks.filter(chunk => chunk.complete).length, 1);
    assert.equal(result.chunks.at(-1)?.complete, true);
});

test('non-resource responses keep streaming before their HTTP body completes', () => {
    const first = Buffer.from(
        'HTTP/1.1 200 OK\r\nContent-Length: 8\r\n\r\n1234',
    );
    const second = Buffer.from('5678');
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('GET');

    const firstResult = framer.push(first);
    assert.ok(Buffer.concat(firstResult.chunks.map(chunk => chunk.buffer)).equals(first));
    assert.ok(firstResult.chunks.every(chunk => !chunk.complete));

    const secondResult = framer.push(second);
    assert.ok(Buffer.concat(secondResult.chunks.map(chunk => chunk.buffer)).equals(second));
    assert.equal(secondResult.chunks.at(-1)?.complete, true);
});

test('response headers may split at every boundary without delaying plaintext', () => {
    const response = Buffer.from(
        'HTTP/1.1 200 OK\r\n'
        + 'Content-Type: application/hap+json\r\n'
        + 'Content-Length: 2\r\n'
        + '\r\n'
        + '{}',
    );
    for (let split = 1; split < response.length; split++) {
        const framer = new HapResponseBoundaryFramer();
        framer.enqueue('GET');
        const first = framer.push(response.subarray(0, split));
        assert.equal(first.fatal, undefined, `failed at split ${split}`);
        assert.ok(
            Buffer.concat(first.chunks.map(chunk => chunk.buffer))
                .equals(response.subarray(0, split)),
            `first plaintext changed at split ${split}`,
        );
        const second = framer.push(response.subarray(split));
        assert.equal(second.fatal, undefined, `failed at split ${split}`);
        assert.ok(
            Buffer.concat(second.chunks.map(chunk => chunk.buffer))
                .equals(response.subarray(split)),
            `second plaintext changed at split ${split}`,
        );
        assert.equal(second.chunks.at(-1)?.complete, true, `not complete at split ${split}`);
    }
});

test('informational responses retain the request until its final response', () => {
    const informational = Buffer.from(
        'HTTP/1.1 100 Continue\r\n\r\n',
    );
    const final = Buffer.from(
        'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}',
    );
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('POST');

    const first = framer.push(informational);
    assert.equal(first.fatal, undefined);
    assert.ok(Buffer.concat(first.chunks.map(chunk => chunk.buffer)).equals(informational));
    assert.ok(first.chunks.every(chunk => !chunk.complete));

    const second = framer.push(final);
    assert.equal(second.fatal, undefined);
    assert.ok(Buffer.concat(second.chunks.map(chunk => chunk.buffer)).equals(final));
    assert.equal(second.chunks.at(-1)?.complete, true);
});

test('multiple response messages in one socket chunk keep distinct boundaries', () => {
    const first = Buffer.from(
        'HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\none',
    );
    const second = Buffer.from(
        'HTTP/1.1 204 No Content\r\n\r\n',
    );
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('GET');
    framer.enqueue('PUT');

    const result = framer.push(Buffer.concat([first, second]));
    assert.equal(result.fatal, undefined);
    assert.ok(Buffer.concat(result.chunks.map(chunk => chunk.buffer)).equals(
        Buffer.concat([first, second]),
    ));
    assert.equal(result.chunks.filter(chunk => chunk.complete).length, 2);
});

test('malformed response framing fails closed without forwarding ambiguous bytes', () => {
    const framer = new HapResponseBoundaryFramer();
    framer.enqueue('POST');
    const malformed = Buffer.from(
        'HTTP/1.1 200 OK\r\n'
        + 'Content-Length: 10\r\n'
        + 'Content-Length: 11\r\n'
        + '\r\n'
        + 'partial',
    );
    const result = framer.push(malformed);
    assert.deepEqual(result.chunks, []);
    assert.match(result.fatal || '', /Content-Length/);

    const later = framer.push(Buffer.from('more'));
    assert.deepEqual(later.chunks, []);
    assert.match(later.fatal || '', /unavailable/);
});

test('guard installation is idempotent and rejects an incompatible HAP API', () => {
    class CompatibleConnection {
        handleHttpServerRequest() { }
        handleHttpServerResponse() { }
        encrypt() { }
        handleTCPSocketWriteFulfilled() { }
        writeQueuedEventNotifications() { }
        close() { }
    }
    const firstRequest = CompatibleConnection.prototype.handleHttpServerRequest;
    assert.equal(installHapResponseBoundaryGuard(CompatibleConnection as any), true);
    const wrappedRequest = CompatibleConnection.prototype.handleHttpServerRequest;
    assert.notStrictEqual(wrappedRequest, firstRequest);
    assert.equal(installHapResponseBoundaryGuard(CompatibleConnection as any), true);
    assert.strictEqual(CompatibleConnection.prototype.handleHttpServerRequest, wrappedRequest);

    class IncompatibleConnection {
        handleHttpServerRequest() { }
        handleHttpServerResponse() { }
    }
    assert.equal(installHapResponseBoundaryGuard(IncompatibleConnection as any), false);
});

test('patched HAP connection encrypts every chunk but flushes events only at the response boundary', () => {
    class FakeConnection {
        handlingRequest = true;
        state = 1;
        eventsTimer = undefined;
        eventsQueuedForImmediateDelivery = true;
        encrypted: Buffer[] = [];
        written: Buffer[] = [];
        eventFlushes = 0;
        closed = false;
        tcpSocket = {
            write: (data: Buffer, callback: () => void) => {
                this.written.push(data);
                callback();
            },
        };

        handleHttpServerRequest() { }
        handleHttpServerResponse() {
            throw new Error('upstream response handler must not run');
        }
        encrypt(data: Buffer) {
            this.encrypted.push(data);
            return Buffer.concat([Buffer.from([this.encrypted.length]), data]);
        }
        handleTCPSocketWriteFulfilled() { }
        writeQueuedEventNotifications() {
            this.eventFlushes++;
        }
        close() {
            this.closed = true;
        }
    }
    assert.equal(installHapResponseBoundaryGuard(FakeConnection as any), true);
    const connection = new FakeConnection() as any;
    connection.handleHttpServerRequest({ method: 'POST', url: '/resource' });
    const body = Buffer.alloc(128 * 1024, 0x41);
    const response = Buffer.concat([
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n`),
        body,
    ]);

    connection.handleHttpServerResponse(response.subarray(0, 64 * 1024));
    assert.equal(connection.eventFlushes, 0);
    assert.equal(connection.handlingRequest, true);
    connection.handleHttpServerResponse(response.subarray(64 * 1024));

    assert.equal(connection.closed, false);
    assert.equal(connection.eventFlushes, 1);
    assert.equal(connection.handlingRequest, false);
    assert.ok(Buffer.concat(connection.encrypted).equals(response));
    assert.equal(connection.written.length, 2);
    assert.equal(connection.written[0][0], 1);
    assert.equal(connection.written[1][0], 2);
});

test('patched HAP connection closes instead of forwarding malformed response framing', () => {
    class FakeConnection {
        state = 1;
        tcpSocket = { write: () => assert.fail('malformed bytes were forwarded') };
        handleHttpServerRequest() { }
        handleHttpServerResponse() {
            assert.fail('known-broken upstream response handler ran');
        }
        encrypt() {
            assert.fail('malformed bytes were encrypted');
        }
        handleTCPSocketWriteFulfilled() { }
        writeQueuedEventNotifications() {
            assert.fail('events were flushed after a framing failure');
        }
        closed = false;
        close() {
            this.closed = true;
        }
    }
    assert.equal(installHapResponseBoundaryGuard(FakeConnection as any), true);
    const connection = new FakeConnection() as any;
    connection.handleHttpServerRequest({ method: 'POST', url: '/resource' });
    connection.handleHttpServerResponse(Buffer.from(
        'HTTP/1.1 200 OK\r\nContent-Length: invalid\r\n\r\n',
    ));
    assert.equal(connection.closed, true);
});

function httpResponseEnd(data: Buffer): number | undefined {
    const headerEnd = data.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0)
        return;
    const bodyStart = headerEnd + 4;
    const header = data.subarray(0, bodyStart).toString('latin1');
    const length = /^Content-Length:\s*(\d+)\s*$/im.exec(header);
    if (length)
        return bodyStart + Number(length[1]);
    if (!/^Transfer-Encoding:\s*chunked\s*$/im.test(header))
        return;

    let offset = bodyStart;
    while (true) {
        const lineEnd = data.indexOf(Buffer.from('\r\n'), offset);
        if (lineEnd < 0)
            return;
        const sizeText = data.subarray(offset, lineEnd).toString('ascii').split(';', 1)[0];
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size))
            return;
        offset = lineEnd + 2;
        if (!size) {
            // An empty trailer section is encoded as the CRLF immediately
            // following the zero-size line.
            if (data.length >= offset + 2
                && data[offset] === 0x0d
                && data[offset + 1] === 0x0a)
                return offset + 2;
            const trailersEnd = data.indexOf(Buffer.from('\r\n\r\n'), offset);
            if (trailersEnd >= 0)
                return trailersEnd + 4;
            return;
        }
        if (data.length < offset + size + 2)
            return;
        offset += size;
        if (data[offset] !== 0x0d || data[offset + 1] !== 0x0a)
            return;
        offset += 2;
    }
}

test('queued HAP events cannot be inserted into a multi-chunk JPEG response', async () => {
    assert.equal(installHapResponseBoundaryGuard(), true);
    const server = new EventedHTTPServer();
    let connection: any;
    server.on('connection-opened', value => {
        connection = value;
        value.enableEventNotifications(1, 2);
    });
    server.on('request', (_hapConnection, request, response) => {
        assert.equal(request.url, '/resource');
        const body = Buffer.concat([
            Buffer.alloc(128 * 1024, 0x41),
            Buffer.alloc(128 * 1024, 0x42),
        ]);
        response.writeHead(200, { 'Content-Type': 'image/jpeg' });
        connection.sendEvent(1, 2, true, true);
        response.end(body);
    });

    const listening = new Promise<{ port: number; address: string }>(resolve => {
        server.once('listening', (port, address) => resolve({ port, address }));
    });
    server.listen(0, '127.0.0.1');
    const { port } = await listening;

    const received: Buffer[] = [];
    const client = net.createConnection(port, '127.0.0.1');
    try {
        await new Promise<void>((resolve, reject) => {
            client.once('connect', resolve);
            client.once('error', reject);
        });
        const complete = new Promise<Buffer>((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('timed out waiting for HAP resource and event')),
                2000,
            );
            client.on('data', data => {
                received.push(data);
                const raw = Buffer.concat(received);
                if (raw.indexOf(Buffer.from('EVENT/1.0')) < 0)
                    return;
                clearTimeout(timeout);
                resolve(raw);
            });
        });
        client.write(
            'POST /resource HTTP/1.1\r\n'
            + 'Host: 127.0.0.1\r\n'
            + 'Content-Length: 2\r\n'
            + 'Connection: keep-alive\r\n'
            + '\r\n'
            + '{}',
        );

        const raw = await complete;
        const eventOffset = raw.indexOf(Buffer.from('EVENT/1.0'));
        const responseEnd = httpResponseEnd(raw);
        assert.notEqual(responseEnd, undefined, 'resource response did not complete');
        assert.ok(
            eventOffset >= responseEnd!,
            `event at ${eventOffset} was inserted before response end ${responseEnd}`,
        );
    }
    finally {
        client.destroy();
        server.stop();
    }
});
