import sdk, { AudioSensor, Camera, Intercom, Logger, MotionSensor, ScryptedDevice, ScryptedInterface, VideoCamera } from "@scrypted/sdk";
import { SnapshotRequest, SnapshotRequestCallback } from "../../hap";
import {
    emitHapWireTrace,
    inspectHapTraceJpeg,
    isHapWireTraceActive,
} from "../../hap-wire-trace";
import type { HomeKitPlugin } from "../../main";
import { compactSnapshotError, isEventSnapshotReason } from "./camera-snapshot-policy";
import {
    deliverSnapshotWithTransitionGuard,
    HOMEKIT_SNAPSHOT_TRANSITION_GUARD_KEY,
    SnapshotStreamTransition,
} from './camera-snapshot-transition-guard';

const { systemManager, mediaManager } = sdk;

function recommendSnapshotPlugin(console: Console, log: Logger, message: string) {
    if (systemManager.getDeviceByName('@scrypted/snapshot'))
        return;
    console.log(message);
    log.a(message);
}

export function createSnapshotHandler(
    device: ScryptedDevice & VideoCamera & Camera & MotionSensor & AudioSensor & Intercom,
    storage: Storage,
    homekitPlugin: HomeKitPlugin,
    console: Console,
    latestStreamTransition?: () => SnapshotStreamTransition | undefined,
) {
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
        const started = process.hrtime.bigint();
        try {
            // Event snapshots are used by HomeKit Secure Video.
            if (isEventSnapshotReason(request.reason))
                console.log('snapshot requested for reason:', request.reason);
            jpeg = await takePicture(request);
        }
        catch (e) {
            try {
                if (isHapWireTraceActive()) {
                    emitHapWireTrace({
                        type: 'hap-snapshot-error',
                        deviceId: device.id,
                        camera: device.name,
                        requestedWidth: request.width,
                        requestedHeight: request.height,
                        reason: request.reason,
                        elapsedMs: Number(process.hrtime.bigint() - started) / 1_000_000,
                        error: compactSnapshotError(e),
                    });
                }
            }
            catch {
            }
            console.error('snapshot error:', compactSnapshotError(e));
            recommendSnapshotPlugin(console, homekitPlugin.log, `${device.name} encountered an error while retrieving a new snapshot. Consider installing the Snapshot Plugin to show the most recent snapshot. origin:/#/component/plugin/install/@scrypted/snapshot}`);
            callback(e);
            return;
        }
        const readyAtNs = process.hrtime.bigint();
        const event = isEventSnapshotReason(request.reason);
        let transitionGuardEnabled = false;
        try {
            transitionGuardEnabled = storage.getItem(HOMEKIT_SNAPSHOT_TRANSITION_GUARD_KEY) === 'true';
        }
        catch {
            // This opt-in diagnostic must fail open and preserve snapshot
            // delivery if storage is temporarily unavailable.
        }
        let hapTraceActive = false;
        let jpegTrace: ReturnType<typeof inspectHapTraceJpeg> | undefined;
        try {
            hapTraceActive = isHapWireTraceActive();
            if (hapTraceActive)
                jpegTrace = inspectHapTraceJpeg(jpeg);
        }
        catch {
        }
        const pendingDelivery = deliverSnapshotWithTransitionGuard({
            enabled: transitionGuardEnabled,
            periodic: !event,
            readyAtNs,
            latestTransition: () => {
                try {
                    return latestStreamTransition?.();
                }
                catch {
                    return undefined;
                }
            },
        }, trace => {
            // Sample immediately before trace emission and the single callback
            // invocation. JPEG inspection is intentionally done before any
            // guard wait so callbackElapsedMs describes the actual handoff.
            const callbackAtNs = process.hrtime.bigint();
            try {
                if (hapTraceActive) {
                    emitHapWireTrace({
                        type: 'hap-snapshot-result',
                        deviceId: device.id,
                        camera: device.name,
                        requestedWidth: request.width,
                        requestedHeight: request.height,
                        reason: request.reason,
                        // Preserve elapsedMs as source/result-ready latency for
                        // existing analyzers; callbackElapsedMs includes the
                        // optional transition guard.
                        elapsedMs: Number(readyAtNs - started) / 1_000_000,
                        readyElapsedMs: Number(readyAtNs - started) / 1_000_000,
                        callbackElapsedMs: Number(callbackAtNs - started) / 1_000_000,
                        transitionGuardEnabled,
                        transitionGuardDelayMs: trace.guardDelayMs,
                        transitionGuardPlannedMs: trace.guardPlannedMs,
                        nearestStreamTransition: trace.nearestTransition,
                        nearestStreamTransitionDeltaMs: trace.transitionDeltaMs,
                        ...jpegTrace,
                    });
                }
            }
            catch {
            }
            // Keep callback execution outside the capture try/catch. If a HAP
            // callback itself throws, it must never be invoked a second time.
            callback(null, jpeg);
        });
        if (pendingDelivery)
            await pendingDelivery;
    }

    return handleSnapshotRequest;
}
