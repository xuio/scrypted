import { createHash } from 'node:crypto';

/**
 * HAP defines snapshot reasons as numeric values: periodic=0 and event=1.
 * Treat every unknown or malformed value as periodic so it keeps the camera's
 * resilient preview path instead of accidentally requesting a fresh event.
 */
export function isEventSnapshotReason(reason: unknown) {
    return reason === 1;
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

export interface SnapshotJpegSummary {
    isBuffer: boolean;
    bytes: number;
    sha256?: string;
    valid: boolean;
    complete: boolean;
    width?: number;
    height?: number;
    sof?: string;
    components?: number;
    exactDimensions?: boolean;
}

/**
 * Inspect the exact bytes handed to HAP without decoding or copying them.
 * The bounded marker walk rejects truncated/junk envelopes and reports the SOF
 * type so production traces can distinguish baseline from progressive JPEGs.
 */
export function summarizeSnapshotJpeg(
    value: unknown,
    expectedWidth?: unknown,
    expectedHeight?: unknown,
): SnapshotJpegSummary {
    if (!Buffer.isBuffer(value)) {
        return {
            isBuffer: false,
            bytes: 0,
            valid: false,
            complete: false,
        };
    }

    const jpeg = value;
    const summary: SnapshotJpegSummary = {
        isBuffer: true,
        bytes: jpeg.length,
        sha256: createHash('sha256').update(jpeg).digest('hex').slice(0, 16),
        valid: false,
        complete: false,
    };
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8)
        return summary;

    let sawScan = false;
    for (let offset = 2; offset + 1 < jpeg.length;) {
        if (jpeg[offset] !== 0xff)
            return summary;
        while (offset < jpeg.length && jpeg[offset] === 0xff)
            offset++;
        if (offset >= jpeg.length)
            return summary;
        const marker = jpeg[offset++];
        if (marker === 0xd9)
            break;
        if (marker === 0xda) {
            sawScan = true;
            break;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7))
            continue;
        if (offset + 1 >= jpeg.length)
            return summary;
        const segmentLength = jpeg.readUInt16BE(offset);
        if (segmentLength < 2 || offset + segmentLength > jpeg.length)
            return summary;
        const isSof = marker >= 0xc0 && marker <= 0xcf
            && ![0xc4, 0xc8, 0xcc].includes(marker);
        if (isSof) {
            if (segmentLength < 8)
                return summary;
            summary.height = jpeg.readUInt16BE(offset + 3);
            summary.width = jpeg.readUInt16BE(offset + 5);
            summary.components = jpeg[offset + 7];
            summary.sof = `0x${marker.toString(16).padStart(2, '0')}`;
        }
        offset += segmentLength;
    }

    const eoiStart = Math.max(2, jpeg.length - 64);
    for (let offset = jpeg.length - 2; offset >= eoiStart; offset--) {
        if (jpeg[offset] === 0xff && jpeg[offset + 1] === 0xd9) {
            summary.complete = true;
            break;
        }
    }
    summary.valid = sawScan
        && summary.complete
        && !!summary.width
        && !!summary.height;

    const width = typeof expectedWidth === 'number' && Number.isFinite(expectedWidth) && expectedWidth > 0
        ? Math.round(expectedWidth)
        : undefined;
    const height = typeof expectedHeight === 'number' && Number.isFinite(expectedHeight) && expectedHeight > 0
        ? Math.round(expectedHeight)
        : undefined;
    if (width || height) {
        summary.exactDimensions = summary.valid
            && (!width || summary.width === width)
            && (!height || summary.height === height);
    }
    return summary;
}

export interface SnapshotVisualMetrics {
    mean: number;
    p99: number;
    darkFraction: number;
    stddev: number;
    meanGradient: number;
}

export function snapshotVisualMetricsFromGray(gray: Buffer): SnapshotVisualMetrics {
    if (gray.length !== 64 * 64)
        throw new Error(`snapshot visual probe returned ${gray.length} bytes`);
    let sum = 0;
    let dark = 0;
    for (const value of gray) {
        sum += value;
        if (value < 16)
            dark++;
    }
    const mean = sum / gray.length;
    let variance = 0;
    let gradient = 0;
    let gradientSamples = 0;
    for (let y = 0; y < 64; y++) {
        for (let x = 0; x < 64; x++) {
            const index = y * 64 + x;
            const value = gray[index];
            variance += (value - mean) ** 2;
            if (x) {
                gradient += Math.abs(value - gray[index - 1]);
                gradientSamples++;
            }
            if (y) {
                gradient += Math.abs(value - gray[index - 64]);
                gradientSamples++;
            }
        }
    }
    const sorted = [...gray].sort((a, b) => a - b);
    return {
        mean,
        p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
        darkFraction: dark / gray.length,
        stddev: Math.sqrt(variance / gray.length),
        meanGradient: gradientSamples ? gradient / gradientSamples : 0,
    };
}

export function isVisuallyBlankSnapshot(metrics: SnapshotVisualMetrics) {
    return metrics.p99 <= 16
        && metrics.darkFraction >= 0.995
        && metrics.stddev <= 2
        && metrics.meanGradient <= 2;
}
