import assert from 'node:assert/strict';
import test from 'node:test';
import { EarlyAudioBuffer } from '../src/early-audio-buffer';

test('buffers early packets and flushes them in order before forwarding live packets', () => {
    const buffer = new EarlyAudioBuffer();
    const first = Buffer.from([1]);
    const second = Buffer.from([2]);
    const received: Buffer[] = [];

    buffer.push(first);
    buffer.push(second);
    first[0] = 9;

    assert.equal(buffer.bufferedPackets, 2);
    assert.equal(buffer.bufferedBytes, 2);
    assert.equal(buffer.setReady(packet => received.push(packet)), true);
    assert.equal(buffer.bufferedPackets, 0);
    assert.equal(buffer.bufferedBytes, 0);

    const live = Buffer.from([3]);
    buffer.push(live);
    assert.deepEqual(received.map(packet => [...packet]), [[1], [2], [3]]);
    assert.equal(received[2], live);
});

test('packet and byte caps evict the oldest buffered packets', () => {
    const packetCapped = new EarlyAudioBuffer({
        maxPackets: 2,
        maxBytes: 100,
    });
    const packetReceived: Buffer[] = [];

    packetCapped.push(Buffer.from([1]));
    packetCapped.push(Buffer.from([2]));
    packetCapped.push(Buffer.from([3]));
    packetCapped.setReady(packet => packetReceived.push(packet));

    assert.deepEqual(packetReceived.map(packet => [...packet]), [[2], [3]]);
    assert.equal(packetCapped.droppedPackets, 1);

    const byteCapped = new EarlyAudioBuffer({
        maxPackets: 10,
        maxBytes: 4,
    });
    const byteReceived: Buffer[] = [];

    byteCapped.push(Buffer.from([1, 1]));
    byteCapped.push(Buffer.from([2, 2]));
    byteCapped.push(Buffer.from([3, 3]));
    byteCapped.setReady(packet => byteReceived.push(packet));

    assert.deepEqual(byteReceived.map(packet => [...packet]), [[2, 2], [3, 3]]);
    assert.equal(byteCapped.droppedPackets, 1);
});

test('oversized and empty packets are rejected without exceeding limits', () => {
    const buffer = new EarlyAudioBuffer({
        maxPackets: 2,
        maxBytes: 2,
    });

    assert.equal(buffer.push(Buffer.alloc(0)), false);
    assert.equal(buffer.push(Buffer.alloc(3)), false);
    assert.equal(buffer.bufferedPackets, 0);
    assert.equal(buffer.bufferedBytes, 0);
    assert.equal(buffer.droppedPackets, 2);
});

test('packets older than the startup age bound are discarded before the bridge flush', () => {
    let now = 0;
    const buffer = new EarlyAudioBuffer({
        maxAgeMs: 1000,
        now: () => now,
    });
    const received: Buffer[] = [];

    buffer.push(Buffer.from([1]));
    now = 750;
    buffer.push(Buffer.from([2]));
    now = 1001;
    buffer.setReady(packet => received.push(packet));

    assert.deepEqual(received.map(packet => [...packet]), [[2]]);
    assert.equal(buffer.droppedPackets, 1);
    assert.equal(buffer.expiredPackets, 1);
});

test('close clears startup state and prevents later flush or forwarding', () => {
    const buffer = new EarlyAudioBuffer();
    const received: Buffer[] = [];

    buffer.push(Buffer.from([1]));
    buffer.close();

    assert.equal(buffer.bufferedPackets, 0);
    assert.equal(buffer.bufferedBytes, 0);
    assert.equal(buffer.push(Buffer.from([2])), false);
    assert.equal(buffer.setReady(packet => received.push(packet)), false);
    assert.deepEqual(received, []);
});
