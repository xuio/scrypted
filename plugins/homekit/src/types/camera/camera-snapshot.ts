import sdk, { AudioSensor, Camera, Intercom, Logger, MotionSensor, ScryptedDevice, ScryptedInterface, VideoCamera } from "@scrypted/sdk";
import { SnapshotRequest, SnapshotRequestCallback } from "../../hap";
import type { HomeKitPlugin } from "../../main";
import { compactSnapshotError, isEventSnapshotReason } from "./camera-snapshot-policy";

const { systemManager, mediaManager } = sdk;

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

        const media = await device.takePicture({
            // Normalize strictly. HAP defines EVENT as numeric 1; unknown,
            // omitted, or string-valued reasons are ordinary previews.
            reason: isEventSnapshotReason(request.reason) ? 'event' : 'periodic',
            picture: {
                width: request.width,
                height: request.height,
            },
        });
        return await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
    };

    // Do not add a second image cache at the HAP boundary. Camera plugins retain
    // richer freshness and validation state; a generic cache cannot distinguish
    // a visually verified frame from a fail-open one, and must never let an
    // event result poison periodic dashboard previews.
    homekitPlugin.snapshotThrottles.set(device.id, takePicture);

    async function handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
        let jpeg: Buffer;
        try {
            // Event snapshots are used by HomeKit Secure Video.
            if (isEventSnapshotReason(request.reason))
                console.log('snapshot requested for reason:', request.reason);
            jpeg = await takePicture(request);
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
