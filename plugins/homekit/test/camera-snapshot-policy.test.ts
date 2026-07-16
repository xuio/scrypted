import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compactSnapshotError,
    isEventSnapshotReason,
    isVisuallyBlankSnapshot,
    snapshotVisualMetricsFromGray,
    summarizeSnapshotJpeg,
} from '../src/types/camera/camera-snapshot-policy';

test('only the numeric HAP event reason selects the fresh event lane', () => {
    assert.equal(isEventSnapshotReason(undefined), false);
    assert.equal(isEventSnapshotReason(0), false);
    assert.equal(isEventSnapshotReason(1), true);
    assert.equal(isEventSnapshotReason('1'), false);
    assert.equal(isEventSnapshotReason(2), false);
    assert.equal(isEventSnapshotReason(true), false);
});

test('snapshot errors are compact and redact credentials', () => {
    const compact = compactSnapshotError(new Error('failed https://user:pass@example.test/frame?token=secret\nnext'));
    assert.equal(compact, 'Error: failed [url] next');
    assert.equal(
        compactSnapshotError(new Error('request failed\nAuthorization: Bearer secret-token\nnext')),
        'Error: request failed Authorization: [redacted] next',
    );
});

function jpeg(width: number, height: number, sof = 0xc0) {
    return Buffer.from([
        0xff, 0xd8,
        0xff, sof, 0x00, 0x11, 0x08,
        height >> 8, height & 0xff,
        width >> 8, width & 0xff,
        0x03,
        0x01, 0x11, 0x00,
        0x02, 0x11, 0x00,
        0x03, 0x11, 0x00,
        0xff, 0xda, 0x00, 0x0c,
        0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
        0x11, 0x22, 0x33,
        0xff, 0xd9,
    ]);
}

test('snapshot diagnostics recognize complete exact-size baseline and progressive JPEGs', () => {
    const baseline = summarizeSnapshotJpeg(jpeg(1280, 720), 1280, 720);
    assert.equal(baseline.valid, true);
    assert.equal(baseline.complete, true);
    assert.equal(baseline.width, 1280);
    assert.equal(baseline.height, 720);
    assert.equal(baseline.components, 3);
    assert.equal(baseline.sof, '0xc0');
    assert.equal(baseline.exactDimensions, true);
    assert.match(baseline.sha256!, /^[0-9a-f]{16}$/);

    const progressive = summarizeSnapshotJpeg(jpeg(640, 360, 0xc2), 1280, 720);
    assert.equal(progressive.valid, true);
    assert.equal(progressive.sof, '0xc2');
    assert.equal(progressive.exactDimensions, false);
});

test('snapshot diagnostics reject non-buffers and truncated JPEGs', () => {
    assert.deepEqual(summarizeSnapshotJpeg('not a buffer'), {
        isBuffer: false,
        bytes: 0,
        valid: false,
        complete: false,
    });
    const truncated = jpeg(320, 180).subarray(0, -2);
    const summary = summarizeSnapshotJpeg(truncated, 320, 180);
    assert.equal(summary.valid, false);
    assert.equal(summary.complete, false);
});

test('snapshot visual metrics distinguish uniform black from textured dark images', () => {
    const black = snapshotVisualMetricsFromGray(Buffer.alloc(64 * 64, 0));
    assert.equal(isVisuallyBlankSnapshot(black), true);

    const textured = Buffer.alloc(64 * 64);
    for (let i = 0; i < textured.length; i++)
        textured[i] = i % 17;
    assert.equal(isVisuallyBlankSnapshot(snapshotVisualMetricsFromGray(textured)), false);
});
