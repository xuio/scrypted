import assert from 'node:assert/strict';
import test from 'node:test';
import {
    OpusRepacketizer,
    repacketizeOpusOrDrop,
    selectOpusEncoderFrameDurationMs,
} from '../src/types/camera/opus-repacketizer';

const toc = 19 << 3; // CELT, mono, 20 ms
const toc10 = 18 << 3; // CELT, mono, 10 ms
const toc60 = 3 << 3; // SILK, mono, 60 ms

function makePacket(payload: Buffer, sequenceNumber = 100): any {
    return {
        header: {
            sequenceNumber,
        },
        payload,
        clone() {
            return makePacket(Buffer.from(this.payload), this.header.sequenceNumber);
        },
    };
}

function makeCode0(frame: Buffer, sequenceNumber?: number, packetToc = toc) {
    return makePacket(Buffer.concat([
        Buffer.from([packetToc]),
        frame,
    ]), sequenceNumber);
}

test('decodes RFC 6716 two-byte VBR frame lengths', () => {
    const first = Buffer.alloc(300, 0xa1);
    const second = Buffer.alloc(17, 0xb2);
    const packet = makePacket(Buffer.concat([
        Buffer.from([toc | 0b10, 252, 12]),
        first,
        second,
    ]));

    const output = new OpusRepacketizer(20).repacketize(packet);

    assert.equal(output?.length, 2);
    assert.deepEqual(output?.[0].payload.subarray(2), first);
    assert.deepEqual(output?.[1].payload.subarray(2), second);
});

test('passes valid one- and two-frame packets through unchanged', () => {
    const oneFrame = makeCode0(Buffer.from([0xa1]));
    const twoFrame = makePacket(Buffer.from([
        toc | 0b10,
        1,
        0xa1,
        0xb2,
    ]));

    assert.equal(new OpusRepacketizer(20).repacketize(oneFrame)?.[0], oneFrame);
    assert.equal(new OpusRepacketizer(40).repacketize(twoFrame)?.[0], twoFrame);
});

test('encodes one- and two-byte VBR frame length boundaries', async t => {
    const cases = [
        { length: 251, encoded: [251] },
        { length: 252, encoded: [252, 0] },
        { length: 300, encoded: [252, 12] },
        { length: 1275, encoded: [255, 255] },
    ];

    for (const { length, encoded } of cases) {
        await t.test(`${length} bytes`, () => {
            const first = Buffer.alloc(length, 0xa1);
            const second = Buffer.from([0xb2]);
            const repacketizer = new OpusRepacketizer(40);

            assert.deepEqual(repacketizer.repacketize(makeCode0(first)), []);
            const output = repacketizer.repacketize(makeCode0(second));

            assert.equal(output?.length, 1);
            assert.deepEqual(
                output?.[0].payload.subarray(0, 2 + encoded.length),
                Buffer.from([toc | 0b11, 0b10000010, ...encoded]),
            );
            assert.deepEqual(output?.[0].payload.subarray(2 + encoded.length), Buffer.concat([first, second]));
        });
    }
});

test('accepts multi-byte padding lengths and excludes padding from frames', () => {
    const first = Buffer.from([0xa1, 0xa2]);
    const padding = Buffer.alloc(508);
    const padded = makePacket(Buffer.concat([
        Buffer.from([toc | 0b11, 0b01000001, 255, 255, 0]),
        first,
        padding,
    ]));
    const second = Buffer.from([0xb1]);
    const repacketizer = new OpusRepacketizer(40);

    assert.deepEqual(repacketizer.repacketize(padded), []);
    const output = repacketizer.repacketize(makeCode0(second));

    assert.equal(output?.length, 1);
    assert.deepEqual(output?.[0].payload.subarray(3), Buffer.concat([first, second]));
});

test('rejects malformed packet bounds', async t => {
    const malformed = [
        {
            name: 'missing TOC',
            payload: Buffer.alloc(0),
            message: /missing TOC byte/,
        },
        {
            name: 'truncated two-byte code 2 length',
            payload: Buffer.from([toc | 0b10, 252]),
            message: /truncated two-byte frame length/,
            targetPacketDurationMs: 40,
        },
        {
            name: 'uneven code 1 frames',
            payload: Buffer.from([toc | 0b01, 1]),
            message: /code 1 frame data is not evenly divisible/,
            targetPacketDurationMs: 40,
        },
        {
            name: 'code 2 length beyond payload',
            payload: Buffer.from([toc | 0b10, 10, 1, 2]),
            message: /code 2 frame length exceeds remaining payload/,
            targetPacketDurationMs: 40,
        },
        {
            name: 'implicit code 2 frame over 1275 bytes',
            payload: Buffer.concat([
                Buffer.from([toc | 0b10, 0]),
                Buffer.alloc(1276),
            ]),
            message: /frame length 1276 exceeds 1275 bytes/,
            targetPacketDurationMs: 40,
        },
        {
            name: 'missing code 3 frame count',
            payload: Buffer.from([toc | 0b11]),
            message: /missing the frame count byte/,
        },
        {
            name: 'zero code 3 frame count',
            payload: Buffer.from([toc | 0b11, 0b10000000]),
            message: /frame count must not be zero/,
        },
        {
            name: 'code 3 duration over 120 ms',
            payload: Buffer.from([toc | 0b11, 7]),
            message: /packet duration exceeds 120 ms/,
        },
        {
            name: 'truncated padding length',
            payload: Buffer.from([toc | 0b11, 0b01000001, 255]),
            message: /truncated padding length/,
        },
        {
            name: 'padding beyond payload',
            payload: Buffer.from([toc | 0b11, 0b01000001, 2, 1]),
            message: /padding exceeds remaining payload/,
            targetPacketDurationMs: 20,
        },
        {
            name: 'uneven code 3 CBR frames',
            payload: Buffer.from([toc | 0b11, 2, 1]),
            message: /CBR frame data is not evenly divisible/,
        },
        {
            name: 'truncated code 3 VBR length',
            payload: Buffer.from([toc | 0b11, 0b10000010, 252]),
            message: /truncated two-byte frame length/,
        },
        {
            name: 'code 3 VBR lengths beyond payload',
            payload: Buffer.from([toc | 0b11, 0b10000010, 5, 1]),
            message: /VBR frame lengths exceed remaining payload/,
        },
        {
            name: 'implicit frame over 1275 bytes',
            payload: Buffer.concat([
                Buffer.from([toc]),
                Buffer.alloc(1276),
            ]),
            message: /frame length 1276 exceeds 1275 bytes/,
        },
    ];

    for (const { name, payload, message, targetPacketDurationMs = 60 } of malformed) {
        await t.test(name, () => {
            assert.throws(
                () => new OpusRepacketizer(targetPacketDurationMs).repacketize(makePacket(payload)),
                message,
            );
        });
    }
});

test('a malformed packet does not corrupt queued frames', () => {
    const first = Buffer.from([0xa1, 0xa2]);
    const second = Buffer.from([0xb1, 0xb2]);
    const repacketizer = new OpusRepacketizer(40);

    assert.deepEqual(repacketizer.repacketize(makeCode0(first)), []);
    assert.throws(
        () => repacketizer.repacketize(makePacket(Buffer.from([
            toc | 0b11,
            0b10000010,
            5,
            1,
        ]))),
        /VBR frame lengths exceed remaining payload/,
    );
    assert.equal(repacketizer.depacketized.length, 1);

    const output = repacketizer.repacketize(makeCode0(second));
    assert.equal(output?.length, 1);
    assert.deepEqual(output?.[0].payload.subarray(3), Buffer.concat([first, second]));
});

test('incompatible TOC changes discard only the incomplete prior group', () => {
    const firstConfigFrame = Buffer.from([0xa1]);
    const secondConfigFrame = Buffer.from([0xb1]);
    const secondConfigNextFrame = Buffer.from([0xb2]);
    const firstToc = 18 << 3; // CELT, mono, 10 ms
    const secondToc = 14 << 3; // Hybrid, mono, 10 ms
    const repacketizer = new OpusRepacketizer(20);

    assert.deepEqual(repacketizer.repacketize(makeCode0(firstConfigFrame, undefined, firstToc)), []);
    assert.deepEqual(repacketizer.repacketize(makePacket(Buffer.concat([
        Buffer.from([secondToc]),
        secondConfigFrame,
    ]))), []);

    const output = repacketizer.repacketize(makePacket(Buffer.concat([
        Buffer.from([secondToc]),
        secondConfigNextFrame,
    ])));

    assert.equal(output?.length, 1);
    assert.equal(output?.[0].payload[0] & 0b11111100, secondToc);
    assert.deepEqual(output?.[0].payload.subarray(3), Buffer.concat([
        secondConfigFrame,
        secondConfigNextFrame,
    ]));
});

test('stereo changes cannot be combined with queued mono frames', () => {
    const monoFrame = Buffer.from([0xa1]);
    const stereoFrame = Buffer.from([0xb1]);
    const stereoNextFrame = Buffer.from([0xb2]);
    const stereoToc = toc | 0b100;
    const repacketizer = new OpusRepacketizer(40);

    assert.deepEqual(repacketizer.repacketize(makeCode0(monoFrame)), []);
    assert.deepEqual(repacketizer.repacketize(makePacket(Buffer.concat([
        Buffer.from([stereoToc]),
        stereoFrame,
    ]))), []);
    const output = repacketizer.repacketize(makePacket(Buffer.concat([
        Buffer.from([stereoToc]),
        stereoNextFrame,
    ])));

    assert.equal(output?.length, 1);
    assert.equal(output?.[0].payload[0] & 0b100, 0b100);
    assert.deepEqual(output?.[0].payload.subarray(3), Buffer.concat([
        stereoFrame,
        stereoNextFrame,
    ]));
});

test('malformed packets are dropped and reported at the sender boundary', () => {
    const errors: unknown[] = [];
    const malformed = makePacket(Buffer.from([toc | 0b10, 252]));
    const output = repacketizeOpusOrDrop(
        new OpusRepacketizer(40),
        malformed,
        error => errors.push(error),
    );

    assert.equal(output, undefined);
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /truncated two-byte frame length/);
});

test('sender-boundary error handling preserves valid packets', () => {
    const packet = makeCode0(Buffer.from([0xa1]));
    const errors: unknown[] = [];
    const output = repacketizeOpusOrDrop(
        new OpusRepacketizer(20),
        packet,
        error => errors.push(error),
    );

    assert.equal(output?.[0], packet);
    assert.deepEqual(errors, []);
});

test('selects encoder frame durations that exactly represent HomeKit packet times', () => {
    assert.equal(selectOpusEncoderFrameDurationMs(20), 20);
    assert.equal(selectOpusEncoderFrameDurationMs(30), 10);
    assert.equal(selectOpusEncoderFrameDurationMs(40), 40);
    assert.equal(selectOpusEncoderFrameDurationMs(60), 60);
});

test('supports 30 and 60 ms targets when the input TOC is representable', () => {
    const thirty = new OpusRepacketizer(30);
    assert.deepEqual(thirty.repacketize(makeCode0(Buffer.from([0xa1]), 100, toc10)), []);
    assert.deepEqual(thirty.repacketize(makeCode0(Buffer.from([0xb1]), 101, toc10)), []);
    const combined = thirty.repacketize(makeCode0(Buffer.from([0xc1]), 102, toc10));
    assert.equal(combined?.length, 1);
    assert.equal(combined?.[0].payload[1] & 0x3f, 3);

    const sixtyPacket = makeCode0(Buffer.from([0xd1]), 200, toc60);
    assert.equal(new OpusRepacketizer(60).repacketize(sixtyPacket)?.[0], sixtyPacket);
});

test('drops an input frame duration that cannot represent the target packet time', () => {
    const errors: unknown[] = [];
    const output = repacketizeOpusOrDrop(
        new OpusRepacketizer(30),
        makeCode0(Buffer.from([0xa1])),
        error => errors.push(error),
    );

    assert.equal(output, undefined);
    assert.match((errors[0] as Error).message, /30 ms target cannot be represented by 20 ms frames/);
});

test('output sequence numbers remain contiguous while coalescing input packets', () => {
    const repacketizer = new OpusRepacketizer(60);

    assert.deepEqual(repacketizer.repacketize(makeCode0(Buffer.from([1]), 100)), []);
    assert.deepEqual(repacketizer.repacketize(makeCode0(Buffer.from([2]), 101)), []);
    const first = repacketizer.repacketize(makeCode0(Buffer.from([3]), 102));
    assert.deepEqual(repacketizer.repacketize(makeCode0(Buffer.from([4]), 103)), []);
    assert.deepEqual(repacketizer.repacketize(makeCode0(Buffer.from([5]), 104)), []);
    const second = repacketizer.repacketize(makeCode0(Buffer.from([6]), 105));

    assert.equal(first?.[0].header.sequenceNumber, 100);
    assert.equal(second?.[0].header.sequenceNumber, 101);
});

test('output sequence numbers remain contiguous while splitting packets', () => {
    const repacketizer = new OpusRepacketizer(40);
    const fourFrames = makePacket(Buffer.from([
        toc | 0b11,
        4,
        1, 2, 3, 4,
    ]), 500);
    const split = repacketizer.repacketize(fourFrames);
    const next = makePacket(Buffer.from([
        toc | 0b01,
        5, 6,
    ]), 501);

    assert.deepEqual(split?.map(packet => packet.header.sequenceNumber), [500, 501]);
    assert.equal(repacketizer.repacketize(next)?.[0].header.sequenceNumber, 502);
});

test('dropped packets do not create output sequence gaps and wrapping is preserved', () => {
    const repacketizer = new OpusRepacketizer(20);
    const errors: unknown[] = [];
    const first = repacketizer.repacketize(makeCode0(Buffer.from([1]), 0xffff));
    const dropped = repacketizeOpusOrDrop(
        repacketizer,
        makePacket(Buffer.from([toc | 0b10, 252]), 0),
        error => errors.push(error),
    );
    const second = repacketizer.repacketize(makeCode0(Buffer.from([2]), 1));

    assert.equal(first?.[0].header.sequenceNumber, 0xffff);
    assert.equal(dropped, undefined);
    assert.equal(second?.[0].header.sequenceNumber, 0);
    assert.equal(errors.length, 1);
});

test('rejects invalid target packet durations', () => {
    assert.throws(() => new OpusRepacketizer(0), /greater than 0/);
    assert.throws(() => new OpusRepacketizer(121), /no more than 120/);
    assert.throws(() => new OpusRepacketizer(Number.NaN), /greater than 0/);
});
