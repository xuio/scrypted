import assert from 'node:assert/strict';
import test from 'node:test';
import { createHomeKitStreamTiming, FirstCompleteDecodableIdrTracker } from '../src/types/camera/camera-streaming-timing';
import {
    HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE,
    getHomeKitReplayBootstrapBytesPerSecond,
    HOMEKIT_REPLAY_BOOTSTRAP_RATE_CHOICES,
} from '../src/types/camera/homekit-replay-bootstrap';

function packet(payload: number[], timestamp: number, marker = false) {
    return {
        header: {
            marker,
            timestamp,
        },
        payload: Buffer.from(payload),
    };
}

test('complete IDR timing requires SPS, PPS, IDR start, and its exact marker', () => {
    const tracker = new FirstCompleteDecodableIdrTracker();

    assert.equal(tracker.observe(packet([0x65], 100, true)), undefined);
    assert.equal(tracker.observe(packet([0x67], 101)), undefined);
    assert.equal(tracker.observe(packet([0x68], 101)), undefined);
    assert.equal(tracker.observe(packet([0x7c, 0x85], 102)), undefined);
    assert.equal(tracker.observe(packet([0x7c, 0x05], 102)), undefined);
    assert.equal(tracker.observe(packet([0x41], 103, true)), undefined);
    assert.equal(tracker.observe(packet([0x7c, 0x45], 102, true)), 'complete');
    assert.equal(tracker.observe(packet([0x41], 104, true)), undefined);
});

test('STAP-A codec info followed by a single-packet IDR is decodable', () => {
    const tracker = new FirstCompleteDecodableIdrTracker();
    const codecInfo = [
        0x78,
        0, 1, 0x67,
        0, 1, 0x68,
    ];

    assert.equal(tracker.observe(packet(codecInfo, 200)), undefined);
    assert.equal(tracker.observe(packet([0x65], 201, true)), 'complete');
});

test('IDR timing stops at the packet cap and reports one incomplete milestone', () => {
    const logs: any[][] = [];
    const timing = createHomeKitStreamTiming({
        log(...args: any[]) {
            logs.push(args);
        },
    } as Console, () => undefined, {
        maxVideoPackets: 3,
    });

    assert.equal(timing.onVideoRtpSent(packet([0x41], 1, true)), false);
    assert.equal(timing.onVideoRtpSent(packet([0x41], 2, true)), false);
    assert.equal(timing.onVideoRtpSent(packet([0x41], 3, true)), true);
    assert.equal(timing.onVideoRtpSent(packet([0x41], 4, true)), true);
    assert.equal(logs.length, 1);
    assert.equal(logs[0][0], 'HomeKit complete decodable IDR was not observed; timing stopped.');
    assert.deepEqual(logs[0][1], {
        videoPacketsObserved: 3,
    });
});

test('direct FFmpeg SRTP timing unavailability is explicit and logged once per track', () => {
    const logs: any[][] = [];
    const timing = createHomeKitStreamTiming({
        log(...args: any[]) {
            logs.push(args);
        },
    } as Console, () => undefined);

    assert.equal(timing.onVideoTimingUnavailable('FFmpeg sends video using direct SRTP.'), true);
    assert.equal(timing.onVideoRtpSent(packet([0x65], 1, true)), true);
    assert.equal(timing.onAudioTimingUnavailable('AAC-ELD is sent by FFmpeg using direct SRTP.'), true);
    assert.equal(timing.onAudioRtpSent(), true);
    assert.deepEqual(logs, [
        [
            'HomeKit complete decodable IDR timing unavailable.',
            {
                reason: 'FFmpeg sends video using direct SRTP.',
            },
        ],
        [
            'HomeKit first audio RTP timing unavailable.',
            {
                reason: 'AAC-ELD is sent by FFmpeg using direct SRTP.',
            },
        ],
    ]);
});

test('HomeKit replay bootstrap choices map only to supported policies and rates', () => {
    assert.deepEqual(HOMEKIT_REPLAY_BOOTSTRAP_RATE_CHOICES, [
        'Default',
        'Adaptive (High auto / Medium 8 Mbit/s)',
        '8 Mbit/s',
        '10 Mbit/s',
        '12 Mbit/s',
    ]);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond('Default'), undefined);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond(HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE, 'local'), undefined);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond(HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE, 'medium-resolution'), 1_000_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond(HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE, 'remote'), 1_000_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond(HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE, 'low-resolution'), 1_000_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond(HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE, 'remote-recorder'), undefined);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond('8 Mbit/s'), 1_000_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond('10 Mbit/s'), 1_250_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond('12 Mbit/s'), 1_500_000);
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond('20 Mbit/s'), undefined);
});
