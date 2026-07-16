import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createInitialVideoRtcpLatch, shouldWaitForInitialVideoRtcp } from '../src/types/camera/camera-streaming-rtcp';

test('local HomeKit streams do not wait for initial RTCP', () => {
    assert.equal(shouldWaitForInitialVideoRtcp(false, false, true), false);
});

test('slow, low-bandwidth, and bridged HomeKit streams retain the RTCP gate', () => {
    assert.equal(shouldWaitForInitialVideoRtcp(true, false, true), true);
    assert.equal(shouldWaitForInitialVideoRtcp(false, true, true), true);
    assert.equal(shouldWaitForInitialVideoRtcp(false, false, false), true);
});

test('initial RTCP arriving during PREPARE is latched for START', async () => {
    const videoReturn = new EventEmitter();
    const latch = createInitialVideoRtcpLatch(videoReturn, new Promise(() => { }));

    videoReturn.emit('message', Buffer.alloc(0));

    assert.equal(await latch, true);
    assert.equal(videoReturn.listenerCount('message'), 0);
});

test('initial RTCP arriving after START resolves the latch', async () => {
    const videoReturn = new EventEmitter();
    const latch = createInitialVideoRtcpLatch(videoReturn, new Promise(() => { }));

    queueMicrotask(() => videoReturn.emit('message', Buffer.alloc(0)));

    assert.equal(await latch, true);
    assert.equal(videoReturn.listenerCount('message'), 0);
});

test('session teardown removes a pending RTCP listener', async () => {
    const videoReturn = new EventEmitter();
    let stop: () => void;
    const stopped = new Promise<void>(resolve => stop = resolve);
    const latch = createInitialVideoRtcpLatch(videoReturn, stopped);

    stop();

    assert.equal(await latch, false);
    assert.equal(videoReturn.listenerCount('message'), 0);
});
