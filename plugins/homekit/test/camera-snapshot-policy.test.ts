import assert from 'node:assert/strict';
import test from 'node:test';
import {
    compactSnapshotError,
    isEventSnapshotReason,
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
