import { isEventSnapshotReason } from './camera-snapshot-policy';

export const HAP_PERIODIC_SNAPSHOT_MAX_WIDTH = 320;
export const HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT = 180;

export interface HapSnapshotSourceRequest {
    width: number;
    height: number;
    reason?: unknown;
}

/**
 * Bound only ordinary Home dashboard previews to a small source JPEG. Event
 * snapshots retain the exact HAP dimensions used by HKSV and notifications.
 * Requests already inside the bound are not enlarged.
 */
export function getHapSnapshotSourcePicture(request: HapSnapshotSourceRequest) {
    const picture = {
        width: request.width,
        height: request.height,
    };
    if (isEventSnapshotReason(request.reason)
        || !Number.isFinite(request.width)
        || !Number.isFinite(request.height)
        || request.width <= 0
        || request.height <= 0
        || request.width <= HAP_PERIODIC_SNAPSHOT_MAX_WIDTH
            && request.height <= HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT)
        return picture;

    // Pin the limiting edge and derive the other dimension from the original
    // ratio. Integer JPEG dimensions necessarily round by at most half a pixel.
    if (request.width * HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT
        >= request.height * HAP_PERIODIC_SNAPSHOT_MAX_WIDTH) {
        return {
            width: HAP_PERIODIC_SNAPSHOT_MAX_WIDTH,
            height: Math.max(1, Math.min(
                HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT,
                Math.round(request.height * HAP_PERIODIC_SNAPSHOT_MAX_WIDTH / request.width),
            )),
        };
    }

    return {
        width: Math.max(1, Math.min(
            HAP_PERIODIC_SNAPSHOT_MAX_WIDTH,
            Math.round(request.width * HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT / request.height),
        )),
        height: HAP_PERIODIC_SNAPSHOT_MAX_HEIGHT,
    };
}
