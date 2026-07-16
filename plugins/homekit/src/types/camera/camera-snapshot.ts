import { spawn } from "node:child_process";
import sdk, { AudioSensor, Camera, Intercom, Logger, MotionSensor, ScryptedDevice, ScryptedInterface, VideoCamera } from "@scrypted/sdk";
import { CameraController, SnapshotRequest, SnapshotRequestCallback } from "../../hap";
import type { HomeKitPlugin } from "../../main";
import {
    compactSnapshotError,
    isEventSnapshotReason,
    isVisuallyBlankSnapshot,
    snapshotVisualMetricsFromGray,
    summarizeSnapshotJpeg,
} from "./camera-snapshot-policy";

const { systemManager, mediaManager } = sdk;
const visualQueue: Array<{
    camera: string;
    console: Console;
    jpeg: Buffer;
    sha256: string;
}> = [];
const visualSeen = new Set<string>();
const visualLastQueued = new Map<string, number>();
const delegateDiagnostics = new WeakMap<Buffer, Array<Record<string, unknown>>>();
let visualActive = 0;
const RESOURCE_DIAGNOSTICS = Symbol.for('@scrypted/homekit/resource-diagnostics');
const RESOURCE_DIAGNOSTICS_VERSION = '2026-07-16-v1';

function diagnosticReason(reason: unknown) {
    const type = reason === null ? 'null' : typeof reason;
    const value = reason === undefined
        ? 'omitted'
        : ['number', 'string', 'boolean'].includes(typeof reason)
            ? reason
            : String(reason).slice(0, 40);
    return {
        type,
        value,
        mode: isEventSnapshotReason(reason) ? 'event' : 'periodic',
    };
}

function writeDiagnostic(target: Console, prefix: string, record: Record<string, unknown>) {
    try {
        target.log(`${prefix} ${JSON.stringify(record)}`);
    }
    catch {
        // Diagnostics must never affect the HomeKit callback path.
    }
}

function inspectVisual(jpeg: Buffer): Promise<ReturnType<typeof snapshotVisualMetricsFromGray>> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | undefined;
        const chunks: Buffer[] = [];
        let bytes = 0;
        const finish = (error?: Error, metrics?: ReturnType<typeof snapshotVisualMetricsFromGray>) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            try {
                child?.kill('SIGKILL');
            }
            catch {
            }
            error ? reject(error) : resolve(metrics!);
        };
        const timer = setTimeout(() => finish(new Error('visual probe timed out')), 900);
        Promise.resolve(mediaManager.getFFmpegPath()).then(ffmpegPath => {
            if (settled)
                return;
            child = spawn(ffmpegPath, [
                '-hide_banner', '-loglevel', 'error',
                '-f', 'mjpeg', '-i', 'pipe:0',
                '-frames:v', '1',
                '-vf', 'scale=64:64:flags=area,format=gray',
                '-f', 'rawvideo', 'pipe:1',
            ], { stdio: ['pipe', 'pipe', 'ignore'] });
            child.stdout.on('data', data => {
                bytes += data.length;
                if (bytes > 8192) {
                    finish(new Error('visual probe output exceeded limit'));
                    return;
                }
                chunks.push(data);
            });
            child.on('error', error => finish(error));
            child.on('close', code => {
                if (settled)
                    return;
                if (code !== 0) {
                    finish(new Error(`visual probe exited ${code}`));
                    return;
                }
                try {
                    finish(undefined, snapshotVisualMetricsFromGray(Buffer.concat(chunks)));
                }
                catch (error) {
                    finish(error as Error);
                }
            });
            child.stdin.on('error', () => { });
            child.stdin.end(jpeg);
        }, error => finish(error as Error)).catch(error => finish(error as Error));
    });
}

function drainVisualQueue() {
    while (visualActive < 1 && visualQueue.length) {
        const task = visualQueue.shift()!;
        visualActive++;
        inspectVisual(task.jpeg).then(metrics => {
            writeDiagnostic(task.console, 'HKVISUAL', {
                at: new Date().toISOString(),
                camera: task.camera,
                sha256: task.sha256,
                blank: isVisuallyBlankSnapshot(metrics),
                mean: Number(metrics.mean.toFixed(2)),
                p99: metrics.p99,
                darkFraction: Number(metrics.darkFraction.toFixed(4)),
                stddev: Number(metrics.stddev.toFixed(2)),
                meanGradient: Number(metrics.meanGradient.toFixed(2)),
            });
        }, error => {
            writeDiagnostic(task.console, 'HKVISUAL', {
                at: new Date().toISOString(),
                camera: task.camera,
                sha256: task.sha256,
                error: compactSnapshotError(error),
            });
        }).finally(() => {
            visualActive--;
            drainVisualQueue();
        });
    }
}

function queueVisualDiagnostic(camera: string, target: Console, jpeg: Buffer, sha256?: string) {
    if (!sha256)
        return;
    const now = Date.now();
    const lastQueued = visualLastQueued.get(camera) || 0;
    if (now - lastQueued < 60_000)
        return;
    const key = `${camera}:${sha256}`;
    if (visualSeen.has(key))
        return;
    if (visualQueue.length >= 4) {
        writeDiagnostic(target, 'HKVISUAL', {
            at: new Date().toISOString(),
            camera,
            sha256,
            skipped: 'queue-full',
        });
        return;
    }
    visualLastQueued.set(camera, now);
    visualSeen.add(key);
    if (visualSeen.size > 128)
        visualSeen.delete(visualSeen.values().next().value!);
    visualQueue.push({ camera, console: target, jpeg, sha256 });
    drainVisualQueue();
}

/**
 * Observe the final CameraController result, including policy rejections that
 * happen before the Scrypted delegate is called. The original promise settles
 * before logging is scheduled, so tracing cannot delay encrypted /resource
 * responses.
 */
function installResourceDiagnostics() {
    const prototype = CameraController.prototype as any;
    const installed = prototype[RESOURCE_DIAGNOSTICS] as {
        original?: (...args: unknown[]) => Promise<Buffer>;
        version?: string;
    } | undefined;
    if (installed?.version === RESOURCE_DIAGNOSTICS_VERSION)
        return;
    const original = installed?.original || prototype.handleSnapshotRequest;
    if (typeof original !== 'function')
        return;
    const wrapped = async function (
        height: unknown,
        width: unknown,
        accessoryName: unknown,
        reason: unknown,
    ) {
        const started = Date.now();
        try {
            const jpeg = await Reflect.apply(original, this, [height, width, accessoryName, reason]);
            let delegate: Record<string, unknown> | undefined;
            if (Buffer.isBuffer(jpeg)) {
                const queued = delegateDiagnostics.get(jpeg);
                delegate = queued?.shift();
                if (!queued?.length)
                    delegateDiagnostics.delete(jpeg);
            }
            const elapsedMs = Date.now() - started;
            setImmediate(() => {
                const summary = summarizeSnapshotJpeg(jpeg, width, height);
                writeDiagnostic(console, 'HKRESOURCE', {
                    at: new Date().toISOString(),
                    camera: String(accessoryName || 'unknown').slice(0, 120),
                    reason: diagnosticReason(reason),
                    requested: { width, height },
                    elapsedMs,
                    outcome: 'jpeg',
                    ...summary,
                    delegate,
                });
                if (summary.valid && Buffer.isBuffer(jpeg))
                    queueVisualDiagnostic(String(accessoryName || 'unknown').slice(0, 120), console, jpeg, summary.sha256);
            });
            return jpeg;
        }
        catch (error) {
            const elapsedMs = Date.now() - started;
            setImmediate(() => writeDiagnostic(console, 'HKRESOURCE', {
                at: new Date().toISOString(),
                camera: String(accessoryName || 'unknown').slice(0, 120),
                reason: diagnosticReason(reason),
                requested: { width, height },
                elapsedMs,
                outcome: 'hap-error',
                hapStatus: typeof error === 'number' ? error : undefined,
                error: typeof error === 'number' ? undefined : compactSnapshotError(error),
            }));
            throw error;
        }
    };
    try {
        prototype.handleSnapshotRequest = wrapped;
        prototype[RESOURCE_DIAGNOSTICS] = {
            original,
            version: RESOURCE_DIAGNOSTICS_VERSION,
        };
    }
    catch (error) {
        writeDiagnostic(console, 'HKRESOURCE', {
            at: new Date().toISOString(),
            outcome: 'install-error',
            error: compactSnapshotError(error),
        });
    }
}

installResourceDiagnostics();

function recommendSnapshotPlugin(console: Console, log: Logger, message: string) {
    if (systemManager.getDeviceByName('@scrypted/snapshot'))
        return;
    console.log(message);
    log.a(message);
}

export function createSnapshotHandler(device: ScryptedDevice & VideoCamera & Camera & MotionSensor & AudioSensor & Intercom, storage: Storage, homekitPlugin: HomeKitPlugin, console: Console) {
    let requestSequence = 0;
    const capturePicture = async (request: SnapshotRequest) => {
        if (!device.interfaces.includes(ScryptedInterface.Camera))
            throw new Error('Camera does not provide native snapshots. Please install the Snapshot Plugin.');

        const takePictureStarted = Date.now();
        const media = await device.takePicture({
            // Normalize strictly. HAP defines EVENT as numeric 1; unknown,
            // omitted, or string-valued reasons are ordinary previews.
            reason: isEventSnapshotReason(request.reason) ? 'event' : 'periodic',
            picture: {
                width: request.width,
                height: request.height,
            },
        });
        const takePictureMs = Date.now() - takePictureStarted;
        const convertStarted = Date.now();
        const jpeg = await mediaManager.convertMediaObjectToBuffer(media, 'image/jpeg');
        return {
            jpeg,
            takePictureMs,
            convertMs: Date.now() - convertStarted,
            mediaMimeType: media?.mimeType,
        };
    };
    const takePicture = async (request: SnapshotRequest) => (await capturePicture(request)).jpeg;

    // Do not add a second image cache at the HAP boundary. Camera plugins retain
    // richer freshness and validation state; a generic cache cannot distinguish
    // a visually verified frame from a fail-open one, and must never let an
    // event result poison periodic dashboard previews.
    homekitPlugin.snapshotThrottles.set(device.id, takePicture);

    async function handleSnapshotRequest(request: SnapshotRequest, callback: SnapshotRequestCallback) {
        const requestId = `${process.pid}-${device.id}-${++requestSequence}`;
        const started = Date.now();
        let captured: Awaited<ReturnType<typeof capturePicture>>;
        try {
            captured = await capturePicture(request);
        }
        catch (e) {
            let callbackOutcome = 'ok';
            let callbackError: unknown;
            try {
                callback(e);
            }
            catch (error) {
                callbackError = error;
                callbackOutcome = `throw:${compactSnapshotError(error)}`;
            }
            setImmediate(() => {
                writeDiagnostic(console, 'HKDELEGATE', {
                    at: new Date().toISOString(),
                    requestId,
                    camera: device.name,
                    reason: diagnosticReason(request.reason),
                    requested: { width: request.width, height: request.height },
                    elapsedMs: Date.now() - started,
                    outcome: 'error',
                    error: compactSnapshotError(e),
                    callback: callbackOutcome,
                });
                try {
                    recommendSnapshotPlugin(console, homekitPlugin.log, `${device.name} encountered an error while retrieving a new snapshot. Consider installing the Snapshot Plugin to show the most recent snapshot. origin:/#/component/plugin/install/@scrypted/snapshot}`);
                }
                catch {
                }
            });
            if (callbackError)
                throw callbackError;
            return;
        }

        let callbackOutcome = 'ok';
        try {
            callback(null, captured.jpeg);
        }
        catch (callbackError) {
            callbackOutcome = `throw:${compactSnapshotError(callbackError)}`;
            writeDiagnostic(console, 'HKDELEGATE', {
                at: new Date().toISOString(),
                requestId,
                camera: device.name,
                reason: diagnosticReason(request.reason),
                requested: { width: request.width, height: request.height },
                elapsedMs: Date.now() - started,
                outcome: 'callback-error',
                error: compactSnapshotError(callbackError),
            });
            throw callbackError;
        }
        if (!Buffer.isBuffer(captured.jpeg))
            return;
        let queued = delegateDiagnostics.get(captured.jpeg);
        if (!queued) {
            queued = [];
            delegateDiagnostics.set(captured.jpeg, queued);
        }
        queued.push({
            requestId,
            camera: device.name,
            reason: diagnosticReason(request.reason),
            requested: { width: request.width, height: request.height },
            elapsedMs: Date.now() - started,
            takePictureMs: captured.takePictureMs,
            convertMs: captured.convertMs,
            mediaMimeType: captured.mediaMimeType,
            callback: callbackOutcome,
        });
    }

    return handleSnapshotRequest;
}
