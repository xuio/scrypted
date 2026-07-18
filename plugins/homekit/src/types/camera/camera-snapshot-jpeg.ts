const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JFIF_IDENTIFIER = Buffer.from('JFIF\0', 'ascii');

// JFIF 1.01, aspect ratio only, no thumbnail. The APP0 length includes its
// own two length bytes, so the 14-byte payload is encoded as 0x0010.
const JFIF_APP0 = Buffer.from([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01,
    0x00,
    0x00, 0x01,
    0x00, 0x01,
    0x00, 0x00,
]);

type JfifScanResult = 'present' | 'missing' | 'malformed';

function scanJfifApp0(jpeg: Buffer): JfifScanResult {
    if (jpeg.length < JPEG_SOI.length || !jpeg.subarray(0, 2).equals(JPEG_SOI))
        return 'malformed';

    let offset = 2;
    while (offset < jpeg.length) {
        if (jpeg[offset] !== 0xff)
            return 'malformed';
        while (offset < jpeg.length && jpeg[offset] === 0xff)
            offset++;
        if (offset >= jpeg.length)
            return 'malformed';

        const marker = jpeg[offset++];
        // EOI completes a header-only JPEG.
        if (marker === 0xd9)
            return 'missing';
        // Byte stuffing is valid only after SOS, not in the marker header.
        if (marker === 0x00)
            return 'malformed';
        // TEM and restart markers are the only stand-alone marker codes.
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7)
            continue;

        if (offset + 2 > jpeg.length)
            return 'malformed';
        const length = jpeg.readUInt16BE(offset);
        if (length < 2 || offset + length > jpeg.length)
            return 'malformed';
        // SOS begins entropy-coded data. JFIF is an interchange header and
        // must occur before it, but first require its length-bearing header to
        // be structurally complete.
        if (marker === 0xda)
            return 'missing';
        const payload = jpeg.subarray(offset + 2, offset + length);
        if (marker === 0xe0
            && payload.length >= JFIF_IDENTIFIER.length
            && payload.subarray(0, JFIF_IDENTIFIER.length).equals(JFIF_IDENTIFIER))
            return 'present';
        offset += length;
    }

    return 'malformed';
}

/**
 * Ensure HomeKit receives a conventional JFIF interchange header without
 * decoding or re-encoding the image. Existing JFIF JPEGs retain buffer
 * identity. Inputs whose marker header cannot be parsed are left untouched so
 * this compatibility normalization cannot turn corruption into new framing.
 */
export function ensureHapSnapshotJfif(jpeg: Buffer): Buffer {
    const scan = scanJfifApp0(jpeg);
    if (scan !== 'missing')
        return jpeg;

    const normalized = Buffer.allocUnsafe(jpeg.length + JFIF_APP0.length);
    jpeg.copy(normalized, 0, 0, 2);
    JFIF_APP0.copy(normalized, 2);
    jpeg.copy(normalized, 2 + JFIF_APP0.length, 2);
    return normalized;
}
