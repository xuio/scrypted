export const HOMEKIT_SNAPSHOT_DELIVERY_GUARD_KEY = 'snapshotDeliveryGuard';
export const HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS = 300;
export const HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS = 75;
export const HOMEKIT_SNAPSHOT_DELIVERY_MAX_QUEUE = 64;
export const HOMEKIT_SNAPSHOT_DELIVERY_MAX_HOLD_MS = 1_000;

export interface SnapshotDeliveryGuardOwner {
    id: string;
    generation: number;
}

export interface SnapshotDeliveryGuardOptions {
    enabled: boolean;
    reason: unknown;
    startedAtNs: bigint;
    readyAtNs: bigint;
    owner: SnapshotDeliveryGuardOwner;
    floorMs?: number;
    spacingMs?: number;
    nowNs?: () => bigint;
    sleep?: (delayMs: number) => Promise<void>;
}

export interface SnapshotDeliveryGuardTrace {
    applied: boolean;
    handoffAtNs: bigint;
    requestElapsedMs: number;
    readyDelayMs: number;
    floorMs: number;
    floorSlackMs?: number;
    spacingMs: number;
    previousHandoffDeltaMs?: number;
    spacingSlackMs?: number;
    queueAhead: number;
    plannedSleepMs: number;
    timerWaits: number;
    failedOpen: boolean;
    failedOpenReason?: 'clock' | 'timer' | 'queue-cap' | 'max-hold' | 'owner-released' | 'coordinator-closed';
}

function monotonicNowNs() {
    return process.hrtime.bigint();
}

function sleep(delayMs: number) {
    return new Promise<void>(resolve => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
    });
}

function nsToMs(value: bigint) {
    return Number(value) / 1_000_000;
}

function durationMs(value: number | undefined, fallback: number) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(0, value!);
}

function msToNs(value: number) {
    return BigInt(Math.ceil(value * 1_000_000));
}

function maxNs(a: bigint, b: bigint) {
    return a > b ? a : b;
}

/** The A/B defaults on when the setting has never been written. */
export function isSnapshotDeliveryGuardEnabled(value: string | null | undefined) {
    return value !== 'false';
}

/**
 * A single coordinator instance is shared by every camera in the HomeKit
 * plugin process. Only numeric HAP periodic requests (reason=0) enter this
 * lane. Event/HKSV and unknown reasons remain synchronous after source-ready.
 */
export class SnapshotDeliveryGuardCoordinator {
    private tail = Promise.resolve();
    private pending = 0;
    private lastHandoffAtNs?: bigint;
    private ownerGenerations = new Map<string, number>();
    private ownerWaiters = new Map<string, Set<() => void>>();
    private closed = false;

    constructor(
        private readonly maxQueue = HOMEKIT_SNAPSHOT_DELIVERY_MAX_QUEUE,
        private readonly maxHoldMs = HOMEKIT_SNAPSHOT_DELIVERY_MAX_HOLD_MS,
    ) {
    }

    createOwner(id: string): SnapshotDeliveryGuardOwner {
        const generation = (this.ownerGenerations.get(id) || 0) + 1;
        this.ownerGenerations.set(id, generation);
        this.wakeOwner(id);
        return { id, generation };
    }

    private isOwnerCurrent(owner: SnapshotDeliveryGuardOwner) {
        return this.ownerGenerations.get(owner.id) === owner.generation;
    }

    private wakeOwner(id: string) {
        const waiters = this.ownerWaiters.get(id);
        this.ownerWaiters.delete(id);
        for (const wake of waiters || [])
            wake();
    }

    releaseOwner(owner: SnapshotDeliveryGuardOwner | string) {
        const id = typeof owner === 'string' ? owner : owner.id;
        const current = this.ownerGenerations.get(id);
        if (current === undefined)
            return;
        if (typeof owner !== 'string' && current !== owner.generation)
            return;
        this.ownerGenerations.set(id, current + 1);
        this.wakeOwner(id);
    }

    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const id of [...this.ownerWaiters.keys()])
            this.wakeOwner(id);
        this.ownerGenerations.clear();
    }

    private async waitForTimerOrOwnerRelease(
        owner: SnapshotDeliveryGuardOwner,
        delayMs: number,
        wait: (delayMs: number) => Promise<void>,
    ) {
        let wake: (() => void) | undefined;
        const ownerReleased = new Promise<void>(resolve => wake = resolve);
        let waiters = this.ownerWaiters.get(owner.id);
        if (!waiters) {
            waiters = new Set();
            this.ownerWaiters.set(owner.id, waiters);
        }
        waiters.add(wake!);
        try {
            await Promise.race([wait(delayMs), ownerReleased]);
        }
        finally {
            waiters.delete(wake!);
            if (!waiters.size)
                this.ownerWaiters.delete(owner.id);
        }
    }

    private immediateTrace(options: SnapshotDeliveryGuardOptions): SnapshotDeliveryGuardTrace {
        const floorMs = durationMs(options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS);
        const spacingMs = durationMs(options.spacingMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
        let handoffAtNs = options.readyAtNs;
        try {
            handoffAtNs = (options.nowNs || monotonicNowNs)();
        }
        catch {
            // A diagnostic guard must never prevent snapshot delivery.
        }
        return {
            applied: false,
            handoffAtNs,
            requestElapsedMs: Math.max(0, nsToMs(handoffAtNs - options.startedAtNs)),
            readyDelayMs: Math.max(0, nsToMs(handoffAtNs - options.readyAtNs)),
            floorMs,
            spacingMs,
            queueAhead: 0,
            plannedSleepMs: 0,
            timerWaits: 0,
            failedOpen: false,
        };
    }

    private async run(
        options: SnapshotDeliveryGuardOptions,
        queueAhead: number,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ) {
        const nowNs = options.nowNs || monotonicNowNs;
        const wait = options.sleep || sleep;
        const floorMs = durationMs(options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS);
        const spacingMs = durationMs(options.spacingMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
        const floorAtNs = options.startedAtNs + msToNs(floorMs);
        let plannedSleepMs = 0;
        let timerWaits = 0;
        let failedOpen = false;
        let failedOpenReason: SnapshotDeliveryGuardTrace['failedOpenReason'];
        const maxHoldAtNs = options.readyAtNs + msToNs(this.maxHoldMs);

        try {
            // Recheck after every timer: timers may wake early, and the previous
            // global handoff is only known once this request owns the lane.
            while (true) {
                const now = nowNs();
                if (this.closed) {
                    failedOpen = true;
                    failedOpenReason = 'coordinator-closed';
                    break;
                }
                if (!this.isOwnerCurrent(options.owner)) {
                    failedOpen = true;
                    failedOpenReason = 'owner-released';
                    break;
                }
                const spacingAtNs = this.lastHandoffAtNs === undefined
                    ? now
                    : this.lastHandoffAtNs + msToNs(spacingMs);
                const releaseAtNs = maxNs(floorAtNs, spacingAtNs);
                if (now >= maxHoldAtNs) {
                    failedOpen = true;
                    failedOpenReason = 'max-hold';
                    break;
                }
                if (now >= releaseAtNs)
                    break;
                const waitUntilNs = releaseAtNs < maxHoldAtNs ? releaseAtNs : maxHoldAtNs;
                const delayMs = Math.ceil(nsToMs(waitUntilNs - now));
                plannedSleepMs += delayMs;
                timerWaits++;
                await this.waitForTimerOrOwnerRelease(options.owner, delayMs, wait);
            }
        }
        catch {
            // Fail open if a custom clock or timer fails. Production's
            // monotonic clock and setTimeout are not expected to reject.
            failedOpen = true;
            failedOpenReason = 'timer';
        }

        let handoffAtNs = options.readyAtNs;
        try {
            handoffAtNs = nowNs();
        }
        catch {
            failedOpen = true;
            failedOpenReason ||= 'clock';
        }
        const previousHandoffAtNs = this.lastHandoffAtNs;
        const requestElapsedMs = Math.max(0, nsToMs(handoffAtNs - options.startedAtNs));
        const previousHandoffDeltaMs = previousHandoffAtNs === undefined
            ? undefined
            : Math.max(0, nsToMs(handoffAtNs - previousHandoffAtNs));
        const trace: SnapshotDeliveryGuardTrace = {
            applied: true,
            handoffAtNs,
            requestElapsedMs,
            readyDelayMs: Math.max(0, nsToMs(handoffAtNs - options.readyAtNs)),
            floorMs,
            floorSlackMs: requestElapsedMs - floorMs,
            spacingMs,
            previousHandoffDeltaMs,
            spacingSlackMs: previousHandoffDeltaMs === undefined
                ? undefined
                : previousHandoffDeltaMs - spacingMs,
            queueAhead,
            plannedSleepMs,
            timerWaits,
            failedOpen,
            failedOpenReason,
        };

        // There is deliberately no retry around the callback. Record the lane
        // timestamp after it returns (or throws), which makes the 75 ms spacing
        // stricter than start-to-start: the next callback cannot begin until
        // at least 75 ms after this callback and its synchronous trace work.
        try {
            deliver(trace);
        }
        finally {
            try {
                this.lastHandoffAtNs = nowNs();
            }
            catch {
                this.lastHandoffAtNs = handoffAtNs;
            }
        }
    }

    deliver(
        options: SnapshotDeliveryGuardOptions,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ): Promise<void> | undefined {
        // Be strict: only HAP's numeric periodic reason is guarded. This keeps
        // event/HKSV and malformed reasons off all promise/timer scheduling.
        if (!options.enabled || options.reason !== 0) {
            deliver(this.immediateTrace(options));
            return;
        }

        if (this.closed || !this.isOwnerCurrent(options.owner) || this.pending >= this.maxQueue) {
            const trace = this.immediateTrace(options);
            trace.applied = true;
            trace.failedOpen = true;
            trace.queueAhead = this.pending;
            trace.failedOpenReason = this.closed
                ? 'coordinator-closed'
                : !this.isOwnerCurrent(options.owner)
                    ? 'owner-released'
                    : 'queue-cap';
            deliver(trace);
            return;
        }

        const queueAhead = this.pending++;
        const previous = this.tail;
        const completion = previous
            .then(() => this.run(options, queueAhead, deliver))
            .finally(() => {
                this.pending--;
            });
        // A callback exception is returned to its caller, but cannot poison the
        // process-wide lane or cause a second callback attempt.
        this.tail = completion.then(() => undefined, () => undefined);
        return completion;
    }
}
