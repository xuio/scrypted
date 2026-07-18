import assert from 'node:assert/strict';
import test from 'node:test';
import {
    getHapSnapshotSourcePicture,
    HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT,
    HAP_PERIODIC_SNAPSHOT_MAX_WIDTH,
} from '../src/types/camera/camera-snapshot-source-size';

test('ordinary 16:9 periodic previews are capped at 320x180', () => {
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 1280,
        height: 720,
        reason: 0,
    }), {
        width: HAP_PERIODIC_SNAPSHOT_MAX_WIDTH,
        height: HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT,
    });
});

test('event snapshots retain the exact requested dimensions', () => {
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 1280,
        height: 720,
        reason: 1,
    }), {
        width: 1280,
        height: 720,
    });
});

test('periodic caps preserve landscape, portrait, and ultrawide aspect ratios', () => {
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 1280,
        height: 960,
        reason: 0,
    }), { width: 240, height: 180 });
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 1080,
        height: 1920,
        reason: 0,
    }), { width: 101, height: 180 });
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 1920,
        height: 480,
        reason: 0,
    }), { width: 320, height: 80 });
});

test('small previews are not upscaled and malformed reasons remain periodic', () => {
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 240,
        height: 135,
        reason: 0,
    }), { width: 240, height: 135 });
    assert.deepEqual(getHapSnapshotSourcePicture({
        width: 640,
        height: 360,
        reason: 'event',
    }), { width: 320, height: 180 });
});
