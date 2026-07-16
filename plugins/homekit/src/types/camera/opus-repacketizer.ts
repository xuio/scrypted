import type { RtpPacket } from "@koush/werift-src/packages/rtp/src/rtp/rtp";

// https://datatracker.ietf.org/doc/html/rfc6716

const MAX_OPUS_FRAME_LENGTH = 1275;
const MAX_OPUS_PACKET_DURATION_MS = 120;
const OPUS_ENCODER_FRAME_DURATIONS_MS = [60, 40, 20, 10, 5, 2.5] as const;

function malformedPacket(reason: string): never {
    throw new Error(`malformed Opus packet: ${reason}`);
}

function incompatiblePacket(reason: string): never {
    throw new Error(`incompatible Opus packet: ${reason}`);
}

function validateTargetPacketDurationMs(targetPacketDurationMs: number) {
    if (!Number.isFinite(targetPacketDurationMs)
        || targetPacketDurationMs <= 0
        || targetPacketDurationMs > MAX_OPUS_PACKET_DURATION_MS) {
        throw new RangeError(`targetPacketDurationMs must be greater than 0 and no more than ${MAX_OPUS_PACKET_DURATION_MS}`);
    }
}

/**
 * FFmpeg/libopus only accepts Opus-native frame durations. Prefer one frame
 * per requested HomeKit packet, falling back to the largest duration that can
 * be combined exactly (notably 3 x 10 ms for a 30 ms request).
 */
export function selectOpusEncoderFrameDurationMs(targetPacketDurationMs: number) {
    validateTargetPacketDurationMs(targetPacketDurationMs);
    const frameDurationMs = OPUS_ENCODER_FRAME_DURATIONS_MS.find(
        duration => Number.isInteger(targetPacketDurationMs / duration),
    );
    if (frameDurationMs === undefined)
        throw new RangeError(`target Opus packet duration ${targetPacketDurationMs} ms is not representable`);
    return frameDurationMs;
}

function decodeFrameLength(payload: Buffer, offset: number, limit: number) {
    if (offset >= limit)
        malformedPacket('truncated frame length');

    const first = payload[offset++];
    if (first < 252)
        return {
            frameLength: first,
            offset,
        };

    if (offset >= limit)
        malformedPacket('truncated two-byte frame length');

    const second = payload[offset++];
    return {
        frameLength: first + second * 4,
        offset,
    };
}

function encodeFrameLength(frameLength: number): number[] {
    if (!Number.isInteger(frameLength) || frameLength < 0 || frameLength > MAX_OPUS_FRAME_LENGTH)
        malformedPacket(`frame length ${frameLength} exceeds ${MAX_OPUS_FRAME_LENGTH} bytes`);

    if (frameLength < 252)
        return [frameLength];

    const first = 252 + (frameLength & 0b11);
    const second = (frameLength - first) / 4;
    return [first, second];
}

function getFrameDurationMs(toc: number) {
    const config = toc >> 3;
    if (config < 12)
        return [10, 20, 40, 60][config & 0b11];
    if (config < 16)
        return [10, 20][config & 0b1];
    return [2.5, 5, 10, 20][config & 0b11];
}

function validateFrameCount(toc: number, frameCount: number) {
    if (!frameCount)
        malformedPacket('frame count must not be zero');
    if (frameCount * getFrameDurationMs(toc) > MAX_OPUS_PACKET_DURATION_MS)
        malformedPacket('packet duration exceeds 120 ms');
}

function validateFrame(frame: Buffer) {
    if (frame.length > MAX_OPUS_FRAME_LENGTH)
        malformedPacket(`frame length ${frame.length} exceeds ${MAX_OPUS_FRAME_LENGTH} bytes`);
}

// INPUT (for single frame sample, see RFC for other 4 code values)

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// | config  |s|0|0|                                               |
// +-+-+-+-+-+-+-+-+                                               |
// |                    Compressed frame 1 (N-1 bytes)...          :
// :                                                               |
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+


// OUTPUT

// 0                   1                   2                   3
// 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// | config  |s|1|1|1|p|     M     | Padding length (Optional)     :
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// : N1 (1-2 bytes): N2 (1-2 bytes):     ...       :     N[M-1]    |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                                                               |
// :               Compressed frame 1 (N1 bytes)...                :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                                                               |
// :               Compressed frame 2 (N2 bytes)...                :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                                                               |
// :                              ...                              :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// |                                                               |
// :                     Compressed frame M...                     :
// |                                                               |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+
// :                  Opus Padding (Optional)...                   |
// +-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+-+


//                  Figure 6: A CBR Code 3 Packet

// In the VBR case, the (optional) padding length is followed by M-1
// frame lengths (indicated by "N1" to "N[M-1]" in Figure 7), each
// encoded in a one- or two-byte sequence as described above.  The
// packet MUST contain enough data for the M-1 lengths after removing
// the (optional) padding, and the sum of these lengths MUST be no
// larger than the number of bytes remaining in the packet after
// decoding them [R7].  The compressed data for all M frames follows,
// each frame consisting of the indicated number of bytes, with the
// final frame consuming any remaining bytes before the final padding,
// as illustrated in Figure 6.  The number of header bytes (TOC byte,
// frame count byte, padding length bytes, and frame length bytes), plus
// the signaled length of the first M-1 frames themselves, plus the
// signaled length of the padding MUST be no larger than N, the total
// size of the packet.

export class OpusRepacketizer {
    depacketized: Buffer[] = [];
    private depacketizedToc: number | undefined;
    private nextOutputSequenceNumber: number | undefined;

    constructor(public targetPacketDurationMs: number) {
        validateTargetPacketDurationMs(targetPacketDurationMs);
    }

    private assignOutputSequenceNumber(packet: RtpPacket) {
        if (this.nextOutputSequenceNumber === undefined)
            this.nextOutputSequenceNumber = packet.header.sequenceNumber & 0xffff;
        packet.header.sequenceNumber = this.nextOutputSequenceNumber;
        this.nextOutputSequenceNumber = (this.nextOutputSequenceNumber + 1) & 0xffff;
    }

    // Repacketize Opus frames to the exact packet duration requested by HomeKit.
    repacketize(packet: RtpPacket): RtpPacket[] | undefined {
        if (!packet.payload.length)
            malformedPacket('missing TOC byte');

        if (this.nextOutputSequenceNumber === undefined)
            this.nextOutputSequenceNumber = packet.header.sequenceNumber & 0xffff;

        const code = packet.payload[0] & 0b00000011;
        let offset: number;
        let packetFrames: Buffer[];

        // code 0: cbr, 1 packet
        // code 1: cbr, 2 packets
        // code 2: vbr, 2 packets
        // code 3: cbr/vbr signaled, variable packets

        if (code === 0) {
            // depacketize by stripping off the config byte
            packetFrames = [packet.payload.subarray(1)];
        }
        else if (code === 1) {
            // depacketize by dividing the remaining payload into two equal sized frames
            const remaining = packet.payload.length - 1;
            if (remaining % 2)
                malformedPacket('code 1 frame data is not evenly divisible');
            const frameLength = remaining / 2;
            packetFrames = [
                packet.payload.subarray(1, 1 + frameLength),
                packet.payload.subarray(1 + frameLength),
            ];
        }
        else if (code === 2) {
            offset = 1;
            // depacketize by dividing the remaining payload into two inequal sized frames
            const decoded = decodeFrameLength(packet.payload, offset, packet.payload.length);
            const frameLength = decoded.frameLength;
            offset = decoded.offset;
            const remaining = packet.payload.length - offset;
            if (frameLength > remaining)
                malformedPacket('code 2 frame length exceeds remaining payload');
            packetFrames = [
                packet.payload.subarray(offset, offset + frameLength),
                packet.payload.subarray(offset + frameLength),
            ];
        }
        else {
            // code 3 packet will have a frame count and padding indicator, and whether the packets
            // are equal size or not.
            if (packet.payload.length < 2)
                malformedPacket('code 3 packet is missing the frame count byte');
            const frameCountByte = packet.payload[1];
            const packetFrameCount = frameCountByte & 0b00111111;
            validateFrameCount(packet.payload[0], packetFrameCount);
            const vbr = frameCountByte & 0b10000000;
            const paddingIndicator = frameCountByte & 0b01000000;
            offset = 2;
            let padding = 0;
            if (paddingIndicator) {
                while (true) {
                    if (offset >= packet.payload.length)
                        malformedPacket('truncated padding length');
                    const paddingByte = packet.payload[offset++];
                    if (paddingByte === 255) {
                        padding += 254;
                        continue;
                    }
                    padding += paddingByte;
                    break;
                }
            }

            const dataEnd = packet.payload.length - padding;
            if (dataEnd < offset)
                malformedPacket('padding exceeds remaining payload');

            if (!vbr) {
                const remaining = dataEnd - offset;
                if (remaining % packetFrameCount)
                    malformedPacket('code 3 CBR frame data is not evenly divisible');
                const frameLength = remaining / packetFrameCount;
                packetFrames = [];
                for (let i = 0; i < packetFrameCount; i++) {
                    const start = offset + i * frameLength;
                    const end = start + frameLength;
                    packetFrames.push(packet.payload.subarray(start, end));
                }
            }
            else {
                const frameLengths: number[] = [];
                for (let i = 0; i < packetFrameCount - 1; i++) {
                    const decoded = decodeFrameLength(packet.payload, offset, dataEnd);
                    frameLengths.push(decoded.frameLength);
                    offset = decoded.offset;
                }
                const signaledLength = frameLengths.reduce((total, frameLength) => total + frameLength, 0);
                if (signaledLength > dataEnd - offset)
                    malformedPacket('code 3 VBR frame lengths exceed remaining payload');

                packetFrames = [];
                for (const frameLength of frameLengths) {
                    const start = offset;
                    offset += frameLength;
                    packetFrames.push(packet.payload.subarray(start, offset));
                }
                packetFrames.push(packet.payload.subarray(offset, dataEnd));
            }
        }

        packetFrames.forEach(validateFrame);
        validateFrameCount(packet.payload[0], packetFrames.length);

        const frameDurationMs = getFrameDurationMs(packet.payload[0]);
        const targetFrameCount = this.targetPacketDurationMs / frameDurationMs;
        if (!Number.isInteger(targetFrameCount)) {
            incompatiblePacket(
                `${this.targetPacketDurationMs} ms target cannot be represented by ${frameDurationMs} ms frames`,
            );
        }
        validateFrameCount(packet.payload[0], targetFrameCount);

        const packetToc = packet.payload[0] & 0b11111100;
        if (this.depacketized.length && this.depacketizedToc !== packetToc) {
            // Opus packets may change mode, bandwidth, frame duration, or
            // channel count in-band. Frames with different TOC parameters
            // cannot share a repacketized packet, so discard only the
            // incomplete group from the prior configuration.
            this.depacketized = [];
            this.depacketizedToc = undefined;
        }

        if (targetFrameCount === packetFrames.length && !this.depacketized.length) {
            this.assignOutputSequenceNumber(packet);
            return [packet];
        }

        // Only mutate the queue after the entire packet has been validated.
        if (!this.depacketized.length)
            this.depacketizedToc = packetToc;
        this.depacketized.push(...packetFrames);

        if (this.depacketized.length < targetFrameCount)
            return [];

        const ret: RtpPacket[] = [];
        while (true) {
            if (this.depacketized.length < targetFrameCount) {
                if (!this.depacketized.length)
                    this.depacketizedToc = undefined;
                return ret;
            }

            const depacketized = this.depacketized.slice(0, targetFrameCount);
            this.depacketized = this.depacketized.slice(targetFrameCount);

            // reuse the config and stereo indicator, but change the code to 3.
            const toc = this.depacketizedToc! | 0b00000011;
            // vbr | padding indicator | packet count
            const frameCountByte = 0b10000000 | targetFrameCount;

            const newHeader: number[] = [toc, frameCountByte];

            // M-1 length bytes
            for (const data of depacketized.slice(0, -1))
                newHeader.push(...encodeFrameLength(data.length));

            const headerBuffer = Buffer.from(newHeader);
            const payload = Buffer.concat([headerBuffer, ...depacketized]);

            const newPacket = packet.clone();
            this.assignOutputSequenceNumber(newPacket);
            newPacket.payload = payload;
            ret.push(newPacket);
        }
    }
}

export function repacketizeOpusOrDrop(
    repacketizer: Pick<OpusRepacketizer, 'repacketize'>,
    packet: RtpPacket,
    onMalformedPacket: (error: unknown) => void,
) {
    try {
        return repacketizer.repacketize(packet);
    }
    catch (e) {
        onMalformedPacket(e);
        return undefined;
    }
}
