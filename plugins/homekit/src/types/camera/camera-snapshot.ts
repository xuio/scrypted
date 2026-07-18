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
    HOMEKIT_SNAPSHOT_DELIVERY_GUARD_KEY,
    isSnapshotDeliveryGuardEnabled,
} from './camera-snapshot-delivery-guard';
import {
    deliverSnapshotWithTransitionGuard,
    HOMEKIT_SNAPSHOT_TRANSITION_GUARD_KEY,
    SnapshotStreamTransition,
    SnapshotTransitionGuardTrace,
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
    const deliveryGuardOwner = homekitPlugin.acquireSnapshotDeliveryGuardOwner(device.id);
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
            // Preserve fail-open delivery if storage is unavailable.
        }
        let deliveryGuardEnabled = true;
        try {
            deliveryGuardEnabled = isSnapshotDeliveryGuardEnabled(
                storage.getItem(HOMEKIT_SNAPSHOT_DELIVERY_GUARD_KEY),
            );
        }
        catch {
            // Storage failure disables this diagnostic for the request so the
            // snapshot callback remains fail-open.
            deliveryGuardEnabled = false;
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
        let transitionTrace!: SnapshotTransitionGuardTrace;
        const pendingTransition = deliverSnapshotWithTransitionGuard({
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
        }, trace => transitionTrace = trace);
        if (pendingTransition)
            await pendingTransition;

        const pendingDelivery = homekitPlugin.snapshotDeliveryGuard.deliver({
            enabled: deliveryGuardEnabled,
            reason: request.reason,
            startedAtNs: started,
            readyAtNs,
            owner: deliveryGuardOwner,
        }, trace => {
            // Sample immediately before the exactly-once HAP callback. Trace
            // emission stays synchronous but happens in finally, so it cannot
            // compress the process-wide spacing between actual handoffs.
            const callbackAtNs = process.hrtime.bigint();
            try {
                callback(null, jpeg);
            }
            finally {
                try {
                    if (hapTraceActive) {
                        emitHapWireTrace({
                            type: 'hap-snapshot-result',
                            deviceId: device.id,
                            camera: device.name,
                            requestedWidth: request.width,
                            requestedHeight: request.height,
                            reason: request.reason,
                            // Preserve elapsedMs as source/result-ready latency
                            // for existing analyzers. callbackElapsedMs is the
                            // actual HAP callback handoff.
                            elapsedMs: Number(readyAtNs - started) / 1_000_000,
                            readyElapsedMs: Number(readyAtNs - started) / 1_000_000,
                            callbackElapsedMs: Number(callbackAtNs - started) / 1_000_000,
                            transitionGuardEnabled,
                            transitionGuardDelayMs: transitionTrace.guardDelayMs,
                            transitionGuardPlannedMs: transitionTrace.guardPlannedMs,
                            nearestStreamTransition: transitionTrace.nearestTransition,
                            nearestStreamTransitionDeltaMs: transitionTrace.transitionDeltaMs,
                            deliveryGuardEnabled,
                            deliveryGuardApplied: trace.applied,
                            deliveryGuardRequestElapsedMs: trace.requestElapsedMs,
                            deliveryGuardFloorMs: trace.floorMs,
                            deliveryGuardFloorSlackMs: trace.floorSlackMs,
                            deliveryGuardSpacingMs: trace.spacingMs,
                            deliveryGuardPreviousHandoffDeltaMs: trace.previousHandoffDeltaMs,
                            deliveryGuardSpacingSlackMs: trace.spacingSlackMs,
                            deliveryGuardReadyDelayMs: trace.readyDelayMs,
                            deliveryGuardQueueAhead: trace.queueAhead,
                            deliveryGuardPlannedSleepMs: trace.plannedSleepMs,
                            deliveryGuardTimerWaits: trace.timerWaits,
                            deliveryGuardFailedOpen: trace.failedOpen,
                            deliveryGuardFailedOpenReason: trace.failedOpenReason,
                            ...jpegTrace,
                        });
                    }
                }
                catch {
                }
            }
        });
        if (pendingDelivery)
            await pendingDelivery;
    }

    return handleSnapshotRequest;
}
