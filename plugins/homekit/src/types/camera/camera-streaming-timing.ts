export interface HomeKitTimingRtpPacket {
    header: {
        marker: boolean;
        timestamp: number;
    };
    payload: Buffer;
}

const H264_NAL_FLAG_IDR = 1 << 0;
const H264_NAL_FLAG_SPS = 1 << 1;
const H264_NAL_FLAG_PPS = 1 << 2;

// At the maximum selectable 12 Mbit/s bootstrap rate, this is approximately
// 15 seconds of MTU-sized video packets. It also bounds malformed streams that
// never produce a complete decodable IDR without adding a session timer.
export const MAX_FIRST_IDR_TRACKING_PACKETS = 20_000;

function getH264NaluFlag(naluType: number) {
    if (naluType === 5)
        return H264_NAL_FLAG_IDR;
    if (naluType === 7)
        return H264_NAL_FLAG_SPS;
    if (naluType === 8)
        return H264_NAL_FLAG_PPS;
    return 0;
}

function getH264NaluFlags(payload: Buffer) {
    if (!payload.length)
        return 0;

    let flags = 0;
    const naluType = payload[0] & 0x1f;
    if (naluType === 24) {
        for (let offset = 1; offset + 2 <= payload.length;) {
            const length = payload.readUInt16BE(offset);
            offset += 2;
            if (!length || offset + length > payload.length)
                break;
            flags |= getH264NaluFlag(payload[offset] & 0x1f);
            offset += length;
        }
        return flags;
    }

    if (naluType === 28) {
        if (payload.length >= 2 && payload[1] & 0x80)
            flags |= getH264NaluFlag(payload[1] & 0x1f);
        return flags;
    }

    return getH264NaluFlag(naluType);
}

export type FirstIdrObservation = 'complete' | 'incomplete' | undefined;

/**
 * Tracks the first H264 access unit that can initialize a decoder: SPS and PPS
 * have both been sent, an IDR has started, and the marker ending that exact
 * access unit has been handed to the UDP socket.
 */
export class FirstCompleteDecodableIdrTracker {
    private seenSps = false;
    private seenPps = false;
    private idrTimestamp: number;
    private stopped = false;
    private packetsObserved = 0;

    constructor(private maxPackets = MAX_FIRST_IDR_TRACKING_PACKETS) {
        if (!Number.isInteger(maxPackets) || maxPackets <= 0)
            throw new RangeError('maxPackets must be a positive integer');
    }

    observe(packet: HomeKitTimingRtpPacket): FirstIdrObservation {
        if (this.stopped)
            return;

        this.packetsObserved++;
        const naluFlags = getH264NaluFlags(packet.payload);
        this.seenSps ||= !!(naluFlags & H264_NAL_FLAG_SPS);
        this.seenPps ||= !!(naluFlags & H264_NAL_FLAG_PPS);
        if (this.seenSps && this.seenPps && naluFlags & H264_NAL_FLAG_IDR)
            this.idrTimestamp = packet.header.timestamp;

        if (this.idrTimestamp === packet.header.timestamp && packet.header.marker) {
            this.stopped = true;
            return 'complete';
        }
        if (this.packetsObserved >= this.maxPackets) {
            this.stopped = true;
            return 'incomplete';
        }
    }

    get observedPackets() {
        return this.packetsObserved;
    }
}

export function createHomeKitStreamTiming(console: Console, getStartedAt: () => number | undefined, options?: {
    maxVideoPackets?: number;
}) {
    const firstIdr = new FirstCompleteDecodableIdrTracker(options?.maxVideoPackets);
    let firstIdrDone = false;
    let firstAudioSent = false;

    const logElapsed = (message: string, details?: Record<string, number | string>) => {
        const startedAt = getStartedAt();
        const elapsed = startedAt === undefined
            ? undefined
            : Math.round(performance.now() - startedAt);
        const fields = elapsed === undefined
            ? details
            : {
                streamingRequestElapsedMs: elapsed,
                ...details,
            };
        console.log(message, fields);
    };

    return {
        onVideoRtpSent(packet: HomeKitTimingRtpPacket) {
            if (firstIdrDone)
                return true;
            const observation = firstIdr.observe(packet);
            if (!observation)
                return false;
            firstIdrDone = true;
            if (observation === 'complete')
                logElapsed('HomeKit first complete decodable IDR sent.');
            else
                logElapsed('HomeKit complete decodable IDR was not observed; timing stopped.', {
                    videoPacketsObserved: firstIdr.observedPackets,
                });
            return true;
        },
        onVideoTimingUnavailable(reason: string) {
            if (firstIdrDone)
                return true;
            firstIdrDone = true;
            logElapsed('HomeKit complete decodable IDR timing unavailable.', {
                reason,
            });
            return true;
        },
        onAudioRtpSent() {
            if (firstAudioSent)
                return true;
            firstAudioSent = true;
            logElapsed('HomeKit first audio RTP packet sent.');
            return true;
        },
        onAudioTimingUnavailable(reason: string) {
            if (firstAudioSent)
                return true;
            firstAudioSent = true;
            logElapsed('HomeKit first audio RTP timing unavailable.', {
                reason,
            });
            return true;
        },
    };
}
