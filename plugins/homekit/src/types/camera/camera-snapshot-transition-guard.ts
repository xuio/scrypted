export const HOMEKIT_SNAPSHOT_TRANSITION_GUARD_KEY = 'snapshotTransitionGuard';
export const HOMEKIT_SNAPSHOT_TRANSITION_GUARD_MS = 300;

export type SnapshotStreamTransitionKind = 'start' | 'stop';

export interface SnapshotStreamTransition {
    kind: SnapshotStreamTransitionKind;
    atNs: bigint;
}

export interface SnapshotTransitionGuardOptions {
    enabled: boolean;
    periodic: boolean;
    readyAtNs: bigint;
    transition?: SnapshotStreamTransition;
    latestTransition?: () => SnapshotStreamTransition | undefined;
    guardMs?: number;
    nowNs?: () => bigint;
    sleep?: (delayMs: number) => Promise<void>;
}

export interface SnapshotTransitionGuardTrace {
    guardReleasedAtNs: bigint;
    guardDelayMs: number;
    guardPlannedMs: number;
    nearestTransition?: SnapshotStreamTransitionKind;
    transitionDeltaMs?: number;
}

interface SnapshotTransitionGuardPlan {
    guardPlannedMs: number;
    nearestTransition?: SnapshotStreamTransitionKind;
    transitionDeltaMs?: number;
}

function monotonicNowNs() {
    return process.hrtime.bigint();
}

function sleep(delayMs: number) {
    return new Promise<void>(resolve => setTimeout(resolve, delayMs));
}

function nsToMs(value: bigint) {
    return Number(value) / 1_000_000;
}

function readLatestTransition(options: SnapshotTransitionGuardOptions) {
    try {
        return options.latestTransition?.() || options.transition;
    }
    catch {
        // A diagnostic guard must never prevent an otherwise valid snapshot.
        return options.transition;
    }
}

function planSnapshotTransitionGuard(
    options: SnapshotTransitionGuardOptions,
    nowNs: bigint,
): SnapshotTransitionGuardPlan {
    const transition = readLatestTransition(options);
    const transitionDeltaMs = transition
        ? nsToMs(nowNs - transition.atNs)
        : undefined;
    const guardMs = Math.max(0, options.guardMs ?? HOMEKIT_SNAPSHOT_TRANSITION_GUARD_MS);
    const guardPlannedMs = options.enabled
        && options.periodic
        && transitionDeltaMs !== undefined
        && transitionDeltaMs >= 0
        && transitionDeltaMs < guardMs
        ? Math.ceil(guardMs - transitionDeltaMs)
        : 0;
    return {
        guardPlannedMs,
        nearestTransition: transition?.kind,
        transitionDeltaMs,
    };
}

function finishSnapshotTransitionGuard(
    options: SnapshotTransitionGuardOptions,
    plan: SnapshotTransitionGuardPlan,
    guardPlannedMs: number,
): SnapshotTransitionGuardTrace {
    const guardReleasedAtNs = (options.nowNs || monotonicNowNs)();
    return {
        guardReleasedAtNs,
        guardDelayMs: guardPlannedMs > 0
            ? Math.max(0, nsToMs(guardReleasedAtNs - options.readyAtNs))
            : 0,
        guardPlannedMs,
        nearestTransition: plan.nearestTransition,
        transitionDeltaMs: plan.transitionDeltaMs,
    };
}

async function waitForGuardWindow(
    options: SnapshotTransitionGuardOptions,
    initialPlan: SnapshotTransitionGuardPlan,
) {
    const nowNs = options.nowNs || monotonicNowNs;
    const wait = options.sleep || sleep;
    let plan = initialPlan;
    let guardPlannedMs = 0;

    while (plan.guardPlannedMs > 0) {
        guardPlannedMs += plan.guardPlannedMs;
        try {
            await wait(plan.guardPlannedMs);
        }
        catch {
            // Fail open: the guard is diagnostic and callback delivery is the
            // primary contract. The production timer does not reject, but a
            // custom scheduler must not strand HomeKit either.
            break;
        }
        // START/STOP may have changed while the timer yielded. Re-read it and
        // remain outside the quiet window after the newest transition.
        plan = planSnapshotTransitionGuard(options, nowNs());
    }

    return finishSnapshotTransitionGuard(options, plan, guardPlannedMs);
}

/**
 * Keep a periodic snapshot completion out of the short Home live-view state
 * transition where macOS has been observed rebinding an already-released
 * snapshot slot. This deliberately does not refresh, cache, or alter the image.
 * Event snapshots are never delayed.
 */
export async function waitForSnapshotTransitionGuard(
    options: SnapshotTransitionGuardOptions,
): Promise<SnapshotTransitionGuardTrace> {
    const nowNs = options.nowNs || monotonicNowNs;
    const plan = planSnapshotTransitionGuard(options, nowNs());
    if (plan.guardPlannedMs === 0)
        return finishSnapshotTransitionGuard(options, plan, 0);
    return waitForGuardWindow(options, plan);
}

/** A narrow delivery wrapper keeps the success callback structurally single-shot.
 *  Its synchronous no-guard path preserves existing callback timing when the
 *  setting is off and guarantees that event snapshots do not even pay an extra
 *  promise turn. */
export function deliverSnapshotWithTransitionGuard(
    options: SnapshotTransitionGuardOptions,
    deliver: (trace: SnapshotTransitionGuardTrace) => void,
): Promise<void> | undefined {
    const nowNs = options.nowNs || monotonicNowNs;
    const plan = planSnapshotTransitionGuard(options, nowNs());
    if (plan.guardPlannedMs === 0) {
        deliver(finishSnapshotTransitionGuard(options, plan, 0));
        return;
    }
    return waitForGuardWindow(options, plan).then(trace => {
        deliver(trace);
    });
}
