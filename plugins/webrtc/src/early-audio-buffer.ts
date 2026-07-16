import { performance } from 'perf_hooks';

export const DEFAULT_EARLY_AUDIO_MAX_PACKETS = 64;
export const DEFAULT_EARLY_AUDIO_MAX_BYTES = 256 * 1024;
export const DEFAULT_EARLY_AUDIO_MAX_AGE_MS = 1000;

export interface EarlyAudioBufferOptions {
    maxPackets?: number;
    maxBytes?: number;
    maxAgeMs?: number;
    now?: () => number;
}

/**
 * Holds the short RTP prefix that can arrive after the upstream RTSP PLAY but
 * before FFmpeg connects to the local audio-only RTSP bridge. Once ready, new
 * packets are forwarded directly without copying.
 */
export class EarlyAudioBuffer {
    private pending: { packet: Buffer; queuedAt: number }[] = [];
    private pendingBytes = 0;
    private sink: (packet: Buffer) => void;
    private closed = false;
    private dropped = 0;
    private expired = 0;
    private readonly maxPackets: number;
    private readonly maxBytes: number;
    private readonly maxAgeMs: number;
    private readonly now: () => number;

    constructor(options: EarlyAudioBufferOptions = {}) {
        this.maxPackets = options.maxPackets ?? DEFAULT_EARLY_AUDIO_MAX_PACKETS;
        this.maxBytes = options.maxBytes ?? DEFAULT_EARLY_AUDIO_MAX_BYTES;
        this.maxAgeMs = options.maxAgeMs ?? DEFAULT_EARLY_AUDIO_MAX_AGE_MS;
        this.now = options.now ?? (() => performance.now());
        if (!Number.isInteger(this.maxPackets) || this.maxPackets <= 0
            || !Number.isInteger(this.maxBytes) || this.maxBytes <= 0
            || !Number.isFinite(this.maxAgeMs) || this.maxAgeMs <= 0) {
            throw new Error('Invalid early audio buffer limits.');
        }
    }

    get bufferedPackets() {
        return this.pending.length;
    }

    get bufferedBytes() {
        return this.pendingBytes;
    }

    get droppedPackets() {
        return this.dropped;
    }

    get expiredPackets() {
        return this.expired;
    }

    private evictStale(now: number) {
        while (this.pending.length && now - this.pending[0].queuedAt > this.maxAgeMs) {
            const stale = this.pending.shift();
            this.pendingBytes -= stale.packet.length;
            this.dropped++;
            this.expired++;
        }
    }

    push(packet: Buffer) {
        if (this.closed)
            return false;

        if (this.sink) {
            this.sink(packet);
            return true;
        }

        if (!packet.length || packet.length > this.maxBytes) {
            this.dropped++;
            return false;
        }

        const now = this.now();
        this.evictStale(now);
        const copy = Buffer.from(packet);
        while (this.pending.length
            && (this.pending.length >= this.maxPackets || this.pendingBytes + copy.length > this.maxBytes)) {
            const dropped = this.pending.shift();
            this.pendingBytes -= dropped.packet.length;
            this.dropped++;
        }

        if (this.pending.length >= this.maxPackets || this.pendingBytes + copy.length > this.maxBytes) {
            this.dropped++;
            return false;
        }

        this.pending.push({
            packet: copy,
            queuedAt: now,
        });
        this.pendingBytes += copy.length;
        return true;
    }

    setReady(sink: (packet: Buffer) => void) {
        if (this.closed)
            return false;
        if (this.sink)
            throw new Error('Early audio buffer is already ready.');

        this.evictStale(this.now());
        this.sink = sink;
        const pending = this.pending;
        this.pending = [];
        this.pendingBytes = 0;
        for (const { packet } of pending) {
            if (this.closed)
                break;
            sink(packet);
        }
        return true;
    }

    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.sink = undefined;
        this.pending = [];
        this.pendingBytes = 0;
    }
}
