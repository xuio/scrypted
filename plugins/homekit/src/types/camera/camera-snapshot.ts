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
        const event = isEventSnapshotReason(request.reason);
        let deliveryGuardEnabled = true;
        try {
            deliveryGuardEnabled = isSnapshotDeliveryGuardEnabled(
                storage.getItem(HOMEKIT_SNAPSHOT_DELIVERY_GUARD_KEY),
            );
        }
        catch {
            // Storage failure disables the mitigation for this request so the
            // HAP callback remains strictly fail-open.
            deliveryGuardEnabled = false;
        }
        // Register before awaiting the camera. Cohorts must describe Home's
        // request arrival order, not the order in which JPEGs become ready.
        const deliveryTicket = homekitPlugin.snapshotDeliveryGuard.register({
            enabled: deliveryGuardEnabled,
            reason: request.reason,
            startedAtNs: started,
            owner: deliveryGuardOwner,
        });
        try {
            // Event snapshots are used by HomeKit Secure Video.
            if (event)
                console.log('snapshot requested for reason:', request.reason);
            jpeg = await takePicture(request);
        }
        catch (e) {
            deliveryTicket.cancel();
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
        let readyAtNs = started;
        try {
            readyAtNs = process.hrtime.bigint();
        }
        catch {
            // The registered ticket must still reach its fail-open delivery
            // boundary even if the diagnostic monotonic clock is unavailable.
        }
        let callbackInvoked = false;
        let transitionGuardEnabled = false;
        try {
            transitionGuardEnabled = storage.getItem(HOMEKIT_SNAPSHOT_TRANSITION_GUARD_KEY) === 'true';
        }
        catch {
            // Preserve fail-open delivery if storage is unavailable.
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
        let transitionTrace: SnapshotTransitionGuardTrace = {
            guardReleasedAtNs: readyAtNs,
            guardDelayMs: 0,
            guardPlannedMs: 0,
        };
        try {
            try {
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
            }
            catch {
                // This diagnostic guard is fail-open. In particular, never
                // strand the arrival ticket if a clock or future guard change
                // unexpectedly throws after the JPEG has already been read.
            }

            const pendingDelivery = deliveryTicket.deliver({
                readyAtNs,
            }, trace => {
                let callbackAtNs = readyAtNs;
                try {
                    callbackAtNs = process.hrtime.bigint();
                }
                catch {
                }
                // Mark the callback immediately before invoking user code so a
                // callback exception can never cause a second delivery below.
                callbackInvoked = true;
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
                                deliveryGuardClassification: trace.classification,
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
                                deliveryGuardEligibilityWaitMs: trace.eligibilityWaitMs,
                                deliveryGuardCohortOwnerCount: trace.cohortOwnerCount,
                                deliveryGuardCohortSpanMs: trace.cohortSpanMs,
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
            else if (!callbackInvoked)
                throw new Error('snapshot delivery guard returned without invoking the callback');
        }
        catch (e) {
            deliveryTicket.cancel();
            if (callbackInvoked)
                throw e;
            // Final fail-open boundary: a valid JPEG is preferable to a hung
            // HAP request if any post-capture diagnostic scheduler regresses.
            callbackInvoked = true;
            callback(null, jpeg);
        }
    }

    return handleSnapshotRequest;
}
