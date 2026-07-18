import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectHapTraceJpeg } from '../src/hap-wire-trace';
import { ensureHapSnapshotJfif } from '../src/types/camera/camera-snapshot-jpeg';

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const JFIF_APP0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01, 0x00,
    0x00, 0x01, 0x00, 0x01,
    0x00, 0x00,
]);

function bareJpeg() {
    return Buffer.concat([
        SOI,
        // A structurally valid DQT segment followed by an empty scan. The
        // normalizer only changes interchange metadata, never codec bytes.
        Buffer.from([0xff, 0xdb, 0x00, 0x04, 0x01, 0x02]),
        Buffer.from([0xff, 0xda, 0x00, 0x02]),
        EOI,
    ]);
}

test('bare JPEG receives one canonical JFIF APP0 segment after SOI', () => {
    const source = bareJpeg();
    const normalized = ensureHapSnapshotJfif(source);

    assert.notStrictEqual(normalized, source);
    assert.equal(normalized.length, source.length + JFIF_APP0.length);
    assert.deepEqual(normalized.subarray(0, 2), SOI);
    assert.deepEqual(normalized.subarray(2, 2 + JFIF_APP0.length), JFIF_APP0);
    assert.deepEqual(normalized.subarray(2 + JFIF_APP0.length), source.subarray(2));
    assert.equal(inspectHapTraceJpeg(normalized).jfif, true);
    assert.equal(inspectHapTraceJpeg(normalized).firstMarker, '0xe0');
});

test('normalization is idempotent and zero-copy when JFIF already exists', () => {
    const normalized = ensureHapSnapshotJfif(bareJpeg());

    assert.strictEqual(ensureHapSnapshotJfif(normalized), normalized);
});

test('existing JFIF is recognized even when another APP marker precedes it', () => {
    const exif = Buffer.from([
        0xff, 0xe1, 0x00, 0x08,
        0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
    ]);
    const source = Buffer.concat([SOI, exif, JFIF_APP0, EOI]);

    assert.strictEqual(ensureHapSnapshotJfif(source), source);
});

test('non-JFIF APP0 metadata is preserved behind the inserted JFIF segment', () => {
    const jfxx = Buffer.from([
        0xff, 0xe0, 0x00, 0x08,
        0x4a, 0x46, 0x58, 0x58, 0x00, 0x10,
    ]);
    const source = Buffer.concat([SOI, jfxx, EOI]);
    const normalized = ensureHapSnapshotJfif(source);

    assert.deepEqual(normalized.subarray(2, 2 + JFIF_APP0.length), JFIF_APP0);
    const originalApp0Offset = 2 + JFIF_APP0.length;
    assert.deepEqual(
        normalized.subarray(originalApp0Offset, originalApp0Offset + jfxx.length),
        jfxx,
    );
    assert.deepEqual(normalized.subarray(originalApp0Offset + jfxx.length), EOI);
});

test('non-JPEG and malformed marker headers are left untouched', () => {
    const inputs = [
        Buffer.from('not a jpeg'),
        Buffer.from([0xff, 0xd8, 0xff]),
        Buffer.from([0xff, 0xd8, 0xff, 0xda]),
        Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01]),
        Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]),
        Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]),
    ];

    for (const input of inputs)
        assert.strictEqual(ensureHapSnapshotJfif(input), input);
});
