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
