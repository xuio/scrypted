import { createHash } from 'crypto';

const MIN_JPEG_BYTES = 256;

export const HOMEKIT_SNAPSHOT_FRESH_TTL_MS = 8_000;
export const HOMEKIT_SNAPSHOT_STALE_WAIT_MS = 350;
export const HOMEKIT_SNAPSHOT_COLD_WAIT_MS = 4_500;
export const HOMEKIT_SNAPSHOT_FRESH_WAIT_MS = 5_000;
export const HOMEKIT_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1_000;
export const HOMEKIT_SNAPSHOT_MAX_ENTRIES = 8;

export interface SnapshotDimensions {
    width: number;
    height: number;
}

export interface SizedSnapshotRequest extends SnapshotDimensions {
}

export interface CameraSnapshotCacheOptions {
    now?: () => number;
    freshTtlMs?: number;
    staleWaitMs?: number;
    coldWaitMs?: number;
    freshWaitMs?: number;
    maxAgeMs?: number;
    maxEntries?: number;
    diagnostic?: (message: string) => void;
}

interface SnapshotCacheEntry {
    jpeg: Buffer;
    capturedAt: number;
    generation: number;
}

type RefreshResult =
    | {
        ok: true;
        jpeg: Buffer;
        cacheable: boolean;
        cacheSkipReason?: string;
    }
    | {
        ok: false;
        error: unknown;
    };

const timeoutResult = Symbol('snapshot-timeout');

function isStartOfFrame(marker: number) {
    return marker >= 0xc0
        && marker <= 0xcf
        && marker !== 0xc4
        && marker !== 0xc8
        && marker !== 0xcc;
}

/**
 * Performs a deliberately small structural validation suitable for the
 * HomeKit snapshot boundary. It proves that the JPEG has a complete envelope,
 * a bounded marker table, an image frame, and a scan, and reports the encoded
 * dimensions for exact-size cache admission. Full visual/decode validation
 * remains the responsibility of the camera.
 */
export function getCompleteJpegDimensions(jpeg: Buffer): SnapshotDimensions | undefined {
    if (!Buffer.isBuffer(jpeg) || jpeg.length < MIN_JPEG_BYTES)
        return;
    if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
        return;
    if (jpeg[jpeg.length - 2] !== 0xff || jpeg[jpeg.length - 1] !== 0xd9)
        return;

    let offset = 2;
    let dimensions: SnapshotDimensions | undefined;

    while (offset < jpeg.length - 2) {
        if (jpeg[offset] !== 0xff)
            return;

        while (offset < jpeg.length - 2 && jpeg[offset] === 0xff)
            offset++;
        if (offset >= jpeg.length - 2)
            return;

        const marker = jpeg[offset++];
        if (marker === 0x00)
            return;
        if (marker === 0xd9)
            return;
        if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7)
            continue;

        if (offset + 2 > jpeg.length - 2)
            return;
        const segmentLength = jpeg.readUInt16BE(offset);
        if (segmentLength < 2)
            return;

        const segmentEnd = offset + segmentLength;
        if (segmentEnd > jpeg.length - 2)
            return;

        if (isStartOfFrame(marker)) {
            if (segmentLength < 8)
                return;
            const height = jpeg.readUInt16BE(offset + 3);
            const width = jpeg.readUInt16BE(offset + 5);
            if (!width || !height)
                return;
            dimensions = {
                width,
                height,
            };
        }

        if (marker === 0xda)
            return segmentEnd < jpeg.length - 2
                ? dimensions
                : undefined;

        offset = segmentEnd;
    }
}

export function compactSnapshotError(error: unknown) {
    let message: string;
    if (error instanceof Error)
        message = `${error.name}: ${error.message}`;
    else
        message = String(error);

    return message
        .replace(/\b(authorization)\s*[:=]\s*[^\r\n]*/gi, '$1: [redacted]')
        .replace(/\b(?:https?|rtsp):\/\/\S+/gi, '[url]')
        .replace(/\b(password|passwd|token|secret)\s*[:=]\s*\S+/gi, '$1=[redacted]')
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 180);
}

export class CameraSnapshotCache<Request extends SizedSnapshotRequest> {
    private readonly cache = new Map<string, SnapshotCacheEntry>();
    private readonly inflight = new Map<string, Promise<RefreshResult>>();
    private generation = 0;
    private readonly now: () => number;
    private readonly freshTtlMs: number;
    private readonly staleWaitMs: number;
    private readonly coldWaitMs: number;
    private readonly freshWaitMs: number;
    private readonly maxAgeMs: number;
    private readonly maxEntries: number;
    private readonly diagnostic?: (message: string) => void;

    constructor(
        private readonly capture: (request: Request) => Promise<Buffer>,
        options: CameraSnapshotCacheOptions = {},
    ) {
        this.now = options.now || Date.now;
        this.freshTtlMs = options.freshTtlMs ?? HOMEKIT_SNAPSHOT_FRESH_TTL_MS;
        this.staleWaitMs = options.staleWaitMs ?? HOMEKIT_SNAPSHOT_STALE_WAIT_MS;
        this.coldWaitMs = options.coldWaitMs ?? HOMEKIT_SNAPSHOT_COLD_WAIT_MS;
        this.freshWaitMs = options.freshWaitMs ?? HOMEKIT_SNAPSHOT_FRESH_WAIT_MS;
        this.maxAgeMs = options.maxAgeMs ?? HOMEKIT_SNAPSHOT_MAX_AGE_MS;
        this.maxEntries = options.maxEntries ?? HOMEKIT_SNAPSHOT_MAX_ENTRIES;
        this.diagnostic = options.diagnostic;

        if (this.maxEntries < 1)
            throw new Error('snapshot cache maxEntries must be positive');
    }

    private getKey(request: Request) {
        const { width, height } = request;
        if (!Number.isSafeInteger(width) || width <= 0
            || !Number.isSafeInteger(height) || height <= 0)
            throw new Error('snapshot request has invalid dimensions');
        return `${width}x${height}`;
    }

    private log(message: string) {
        try {
            this.diagnostic?.(message);
        }
        catch {
            // Diagnostics must never affect snapshot delivery.
        }
    }

    private getEntry(key: string) {
        const entry = this.cache.get(key);
        if (!entry)
            return;

        const age = Math.max(0, this.now() - entry.capturedAt);
        if (age > this.maxAgeMs) {
            this.cache.delete(key);
            return;
        }

        // Map insertion order doubles as the LRU list.
        this.cache.delete(key);
        this.cache.set(key, entry);
        return {
            entry,
            age,
        };
    }

    private remember(key: string, jpeg: Buffer, generation: number) {
        const existing = this.cache.get(key);
        if (existing?.generation > generation)
            return;

        this.cache.delete(key);
        this.cache.set(key, {
            jpeg,
            capturedAt: this.now(),
            generation,
        });

        while (this.cache.size > this.maxEntries) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined)
                break;
            this.cache.delete(oldest);
        }
    }

    private validate(request: Request, key: string, jpeg: Buffer) {
        const dimensions = getCompleteJpegDimensions(jpeg);
        if (!dimensions)
            throw new Error(`snapshot returned an incomplete JPEG size=${key}`);
        const cacheable = dimensions.width === request.width
            && dimensions.height === request.height;
        return {
            jpeg,
            cacheable,
            cacheSkipReason: cacheable
                ? undefined
                : `wrong-dimensions-actual=${dimensions.width}x${dimensions.height}`,
        };
    }

    private startRefresh(request: Request, mode: 'periodic' | 'fresh') {
        const key = this.getKey(request);

        // Event/fresh requests intentionally do not join a periodic capture:
        // the underlying camera must still see the event capture reason.
        const inflightKey = `${mode}:${key}`;
        const existing = this.inflight.get(inflightKey);
        if (existing)
            return existing;
        const generation = ++this.generation;

        const refresh = (async (): Promise<RefreshResult> => {
            try {
                const result = this.validate(request, key, await this.capture(request));
                if (result.cacheable)
                    this.remember(key, result.jpeg, generation);
                return {
                    ok: true,
                    ...result,
                };
            }
            catch (error) {
                return {
                    ok: false,
                    error,
                };
            }
        })();

        this.inflight.set(inflightKey, refresh);
        void refresh.then(() => {
            if (this.inflight.get(inflightKey) === refresh)
                this.inflight.delete(inflightKey);
        });
        return refresh;
    }

    private async settleWithin(refresh: Promise<RefreshResult>, timeoutMs: number) {
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<typeof timeoutResult>(resolve => {
            timer = setTimeout(() => resolve(timeoutResult), timeoutMs);
        });

        try {
            return await Promise.race([refresh, timeout]);
        }
        finally {
            if (timer)
                clearTimeout(timer);
        }
    }

    private logStaleFallback(key: string, cached: SnapshotCacheEntry, result: RefreshResult | typeof timeoutResult) {
        const age = Math.max(0, this.now() - cached.capturedAt);
        const cause = result === timeoutResult
            ? 'refresh-pending'
            : 'error' in result
                ? compactSnapshotError(result.error)
                : result.cacheSkipReason || 'refresh-unavailable';
        const hash = createHash('sha256').update(cached.jpeg).digest('hex').slice(0, 8);
        this.log(`HomeKit snapshot stale fallback size=${key} ageMs=${age} waitMs=${this.staleWaitMs} bytes=${cached.jpeg.length} hash=${hash} cause=${cause}`);
    }

    async getPeriodic(request: Request) {
        const key = this.getKey(request);
        const cached = this.getEntry(key);
        if (cached?.age <= this.freshTtlMs)
            return cached.entry.jpeg;

        const refresh = this.startRefresh(request, 'periodic');
        if (cached) {
            const result = await this.settleWithin(refresh, this.staleWaitMs);
            if (result !== timeoutResult && result.ok && result.cacheable)
                return result.jpeg;
            this.logStaleFallback(key, cached.entry, result);
            return cached.entry.jpeg;
        }

        const result = await this.settleWithin(refresh, this.coldWaitMs);
        if (result === timeoutResult)
            throw new Error(`snapshot timed out size=${key} after=${this.coldWaitMs}ms`);
        if ('error' in result)
            throw result.error;
        return result.jpeg;
    }

    async getFresh(request: Request) {
        const key = this.getKey(request);
        const result = await this.settleWithin(this.startRefresh(request, 'fresh'), this.freshWaitMs);
        if (result === timeoutResult)
            throw new Error(`snapshot timed out size=${key} after=${this.freshWaitMs}ms`);
        if ('error' in result)
            throw result.error;
        return result.jpeg;
    }
}
