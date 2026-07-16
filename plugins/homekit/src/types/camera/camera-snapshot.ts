import sdk, { AudioSensor, Camera, Intercom, Logger, MotionSensor, ScryptedDevice, ScryptedInterface, VideoCamera } from "@scrypted/sdk";
import { ResourceRequestReason, SnapshotRequest, SnapshotRequestCallback } from "../../hap";
import type { HomeKitPlugin } from "../../main";
import { CameraSnapshotCache, compactSnapshotError } from "./camera-snapshot-cache";

const { systemManager, mediaManager } = sdk;
const PERIODIC_SNAPSHOT_TIMEOUT_MS = 6_000;
const EVENT_SNAPSHOT_TIMEOUT_MS = 5_000;

async function withSnapshotTimeout<T>(operation: Promise<T>, timeoutMs: number, request: SnapshotRequest) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
            () => reject(new Error(`snapshot timed out size=${request.width}x${request.height} after=${timeoutMs}ms`)),
            timeoutMs,
        );
    });

    try {
        return await Promise.race([operation, timeout]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}

function recommendSnapshotPlugin(console: Console, log: Logger, message: string) {
    if (systemManager.getDeviceByName('@scrypted/snapshot'))
        return;
    console.log(message);
    log.a(message);
}

export function createSnapshotHandler(device: ScryptedDevice & VideoCamera & Camera & MotionSensor & AudioSensor & Intercom, storage: Storage, homekitPlugin: HomeKitPlugin, console: Console) {
    const takePicture = async (request: SnapshotRequest) => {
        if (!device.interfaces.includes(ScryptedInterface.Camera))
            throw new Error('Camera does not provide native snapshots. Please install the Snapshot Plugin.');

        const requiresFresh = !!request.reason;
        const isEvent = request.reason === ResourceRequestReason.EVENT;
        const timeout = requiresFresh
            ? EVENT_SNAPSHOT_TIMEOUT_MS
            : PERIODIC_SNAPSHOT_TIMEOUT_MS;
        return await withSnapshotTimeout((async () => {
            const media = await device.takePicture({
                reason: isEvent ? 'event' : 'periodic',
                picture: {
                    width: request.width,
                    height: request.height,
                },
                // UniFi Direct owns a four-second periodic recovery budget.
                // Passing an explicit shorter timeout disables its final
                // exact-size fallback, so only freshness-sensitive requests
                // propagate a device deadline. The wrapper still bounds every
                // periodic capture/conversion at six seconds.
                ...(requiresFresh ? { timeout } : {}),
            });
            return await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        })(), timeout, request);
    }

    const snapshotCache = new CameraSnapshotCache(takePicture, {
        diagnostic: message => console.warn(message),
    });
    const getPicture = (request: SnapshotRequest) => request.reason
        ? snapshotCache.getFresh(request)
        : snapshotCache.getPeriodic(request);

    homekitPlugin.snapshotThrottles.set(device.id, getPicture);

    async function handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
        let jpeg: Buffer;
        try {
            // non zero reason is for homekit secure video... or something else.
            if (request.reason)
                console.log('snapshot requested for reason:', request.reason);
            jpeg = await getPicture(request);
        }
        catch (e) {
            console.error('snapshot error:', compactSnapshotError(e));
            recommendSnapshotPlugin(console, homekitPlugin.log, `${device.name} encountered an error while retrieving a new snapshot. Consider installing the Snapshot Plugin to show the most recent snapshot. origin:/#/component/plugin/install/@scrypted/snapshot}`);
            callback(e);
            return;
        }
        // Keep callback execution outside the capture try/catch. If a HAP
        // callback itself throws, it must never be invoked a second time.
        callback(null, jpeg);
    }

    return handleSnapshotRequest;
}
