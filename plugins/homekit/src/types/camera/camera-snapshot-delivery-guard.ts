export const HOMEKIT_SNAPSHOT_DELIVERY_GUARD_KEY = 'snapshotDeliveryGuard';
export const HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS = 300;
export const HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS = 2_700;
export const HOMEKIT_SNAPSHOT_DELIVERY_BURST_DETECT_MS = 250;
export const HOMEKIT_SNAPSHOT_DELIVERY_BURST_JOIN_MS = 700;
export const HOMEKIT_SNAPSHOT_DELIVERY_BURST_OWNERS = 3;
export const HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS = 75;
export const HOMEKIT_SNAPSHOT_DELIVERY_MAX_QUEUE = 64;
export const HOMEKIT_SNAPSHOT_DELIVERY_MAX_HOLD_MS = 3_500;

export interface SnapshotDeliveryGuardOwner {
    id: string;
    generation: number;
}

export interface SnapshotDeliveryGuardRegistrationOptions {
    enabled: boolean;
    reason: unknown;
    startedAtNs: bigint;
    owner: SnapshotDeliveryGuardOwner;
    floorMs?: number;
    isolatedFloorMs?: number;
    spacingMs?: number;
    burstDetectMs?: number;
    burstJoinMs?: number;
    burstOwners?: number;
    nowNs?: () => bigint;
    sleep?: (delayMs: number) => Promise<void>;
}

export interface SnapshotDeliveryGuardReadyOptions {
    readyAtNs: bigint;
}

export type SnapshotDeliveryGuardClassification = 'bypass' | 'burst' | 'isolated';

export interface SnapshotDeliveryGuardTrace {
    applied: boolean;
    classification: SnapshotDeliveryGuardClassification;
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
    eligibilityWaitMs: number;
    cohortOwnerCount?: number;
    cohortSpanMs?: number;
    failedOpen: boolean;
    failedOpenReason?: 'clock' | 'timer' | 'queue-cap' | 'max-hold' | 'owner-released' | 'coordinator-closed';
}

export interface SnapshotDeliveryGuardTicket {
    deliver(
        options: SnapshotDeliveryGuardReadyOptions,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ): Promise<void> | undefined;
    cancel(): void;
}

interface SnapshotDeliveryCohort {
    firstAtNs: bigint;
    lastAtNs: bigint;
    detectAtNs: bigint;
    joinUntilNs: bigint;
    owners: Set<string>;
    tickets: Set<SnapshotDeliveryGuardTicketImpl>;
    burst: boolean;
}

interface EligibilityResult {
    classification: Exclude<SnapshotDeliveryGuardClassification, 'bypass'>;
    floorMs: number;
    eligibilityAtNs: bigint;
    plannedSleepMs: number;
    timerWaits: number;
    failedOpen: boolean;
    failedOpenReason?: SnapshotDeliveryGuardTrace['failedOpenReason'];
    cohortOwnerCount: number;
    cohortSpanMs: number;
}

function monotonicNowNs() {
    return process.hrtime.bigint();
}

function nsToMs(value: bigint) {
    return Number(value) / 1_000_000;
}

function durationMs(value: number | undefined, fallback: number) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(0, value!);
}

function positiveInteger(value: number | undefined, fallback: number) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.floor(value!));
}

function msToNs(value: number) {
    return BigInt(Math.ceil(value * 1_000_000));
}

/** The measured mitigation defaults on when the setting has never been written. */
export function isSnapshotDeliveryGuardEnabled(value: string | null | undefined) {
    return value !== 'false';
}

class SnapshotDeliveryGuardTicketImpl implements SnapshotDeliveryGuardTicket {
    delivered = false;
    cancelled = false;
    finalized = false;
    counted = false;
    queueAheadAtRegistration = 0;
    failedOpenReason?: SnapshotDeliveryGuardTrace['failedOpenReason'];
    cohort?: SnapshotDeliveryCohort;
    readonly wakeListeners = new Set<() => void>();

    constructor(
        readonly coordinator: SnapshotDeliveryGuardCoordinator,
        readonly options: SnapshotDeliveryGuardRegistrationOptions,
        readonly bypass: boolean,
    ) {
    }

    wake() {
        for (const wake of [...this.wakeListeners])
            wake();
    }

    deliver(
        options: SnapshotDeliveryGuardReadyOptions,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ): Promise<void> | undefined {
        if (this.cancelled || this.delivered)
            return;
        this.delivered = true;
        return this.coordinator.deliverTicket(this, options, deliver);
    }

    cancel() {
        if (this.cancelled || this.delivered)
            return;
        this.cancelled = true;
        this.coordinator.cancelTicket(this);
    }
}

/**
 * Periodic requests register before their image source is awaited. That makes
 * burst classification describe Home's request arrivals instead of camera
 * capture completion order. A request from at least three distinct cameras in
 * 250 ms is a visible-grid burst and keeps the 300 ms path. Other requests are
 * held until 2.7 s, just beyond macOS Home's observed snapshot invalidation.
 *
 * Eligibility waits are independent. Only callbacks that are already eligible
 * enter the short process-wide lane used for 75 ms handoff spacing, so an
 * isolated/offscreen request can never head-of-line block a visible grid.
 */
export class SnapshotDeliveryGuardCoordinator {
    private handoffTail = Promise.resolve();
    private registeredPending = 0;
    private handoffPending = 0;
    private lastHandoffAtNs?: bigint;
    private currentCohort?: SnapshotDeliveryCohort;
    private ownerGenerations = new Map<string, number>();
    private ownerTickets = new Map<string, Set<SnapshotDeliveryGuardTicketImpl>>();
    private closed = false;

    constructor(
        private readonly maxQueue = HOMEKIT_SNAPSHOT_DELIVERY_MAX_QUEUE,
        private readonly maxHoldMs = HOMEKIT_SNAPSHOT_DELIVERY_MAX_HOLD_MS,
    ) {
    }

    createOwner(id: string): SnapshotDeliveryGuardOwner {
        const generation = (this.ownerGenerations.get(id) || 0) + 1;
        this.invalidateOwner(id, 'owner-released');
        this.ownerGenerations.set(id, generation);
        return { id, generation };
    }

    private isOwnerCurrent(owner: SnapshotDeliveryGuardOwner) {
        return this.ownerGenerations.get(owner.id) === owner.generation;
    }

    private invalidateOwner(
        id: string,
        reason: Extract<SnapshotDeliveryGuardTrace['failedOpenReason'], 'owner-released' | 'coordinator-closed'>,
    ) {
        const tickets = this.ownerTickets.get(id);
        this.ownerTickets.delete(id);
        for (const ticket of [...tickets || []]) {
            ticket.failedOpenReason ||= reason;
            this.finishRegistration(ticket);
            ticket.wake();
        }
    }

    releaseOwner(owner: SnapshotDeliveryGuardOwner | string) {
        const id = typeof owner === 'string' ? owner : owner.id;
        const current = this.ownerGenerations.get(id);
        if (current === undefined)
            return;
        if (typeof owner !== 'string' && current !== owner.generation)
            return;
        this.ownerGenerations.set(id, current + 1);
        this.invalidateOwner(id, 'owner-released');
    }

    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const id of [...this.ownerTickets.keys()])
            this.invalidateOwner(id, 'coordinator-closed');
        this.ownerGenerations.clear();
        this.currentCohort = undefined;
    }

    private selectCohort(options: SnapshotDeliveryGuardRegistrationOptions) {
        const detectMs = durationMs(options.burstDetectMs, HOMEKIT_SNAPSHOT_DELIVERY_BURST_DETECT_MS);
        const joinMs = Math.max(
            detectMs,
            durationMs(options.burstJoinMs, HOMEKIT_SNAPSHOT_DELIVERY_BURST_JOIN_MS),
        );
        const arrivalAtNs = options.startedAtNs;
        let cohort = this.currentCohort;
        const canJoin = cohort && (cohort.burst
            ? arrivalAtNs <= cohort.joinUntilNs
            : arrivalAtNs <= cohort.detectAtNs);
        if (!canJoin) {
            cohort = {
                firstAtNs: arrivalAtNs,
                lastAtNs: arrivalAtNs,
                detectAtNs: arrivalAtNs + msToNs(detectMs),
                joinUntilNs: arrivalAtNs + msToNs(joinMs),
                owners: new Set(),
                tickets: new Set(),
                burst: false,
            };
            this.currentCohort = cohort;
        }

        cohort.lastAtNs = arrivalAtNs > cohort.lastAtNs ? arrivalAtNs : cohort.lastAtNs;
        cohort.owners.add(options.owner.id);
        const burstOwners = positiveInteger(options.burstOwners, HOMEKIT_SNAPSHOT_DELIVERY_BURST_OWNERS);
        if (!cohort.burst
            && arrivalAtNs <= cohort.detectAtNs
            && cohort.owners.size >= burstOwners) {
            cohort.burst = true;
            for (const ticket of cohort.tickets)
                ticket.wake();
        }
        return cohort;
    }

    register(options: SnapshotDeliveryGuardRegistrationOptions): SnapshotDeliveryGuardTicket {
        // Be strict: only HAP's numeric periodic reason participates. Event,
        // HKSV, disabled, malformed, and string-valued reasons bypass without
        // entering a promise, timer, cohort, or queue.
        if (!options.enabled || options.reason !== 0)
            return new SnapshotDeliveryGuardTicketImpl(this, options, true);

        const ticket = new SnapshotDeliveryGuardTicketImpl(this, options, false);
        if (this.closed || !this.isOwnerCurrent(options.owner) || this.registeredPending >= this.maxQueue) {
            ticket.queueAheadAtRegistration = this.registeredPending;
            ticket.failedOpenReason = this.closed
                ? 'coordinator-closed'
                : !this.isOwnerCurrent(options.owner)
                    ? 'owner-released'
                    : 'queue-cap';
            return ticket;
        }

        ticket.counted = true;
        this.registeredPending++;
        ticket.cohort = this.selectCohort(options);
        ticket.cohort.tickets.add(ticket);
        let ownerTickets = this.ownerTickets.get(options.owner.id);
        if (!ownerTickets) {
            ownerTickets = new Set();
            this.ownerTickets.set(options.owner.id, ownerTickets);
        }
        ownerTickets.add(ticket);
        return ticket;
    }

    cancelTicket(ticket: SnapshotDeliveryGuardTicketImpl) {
        this.finishRegistration(ticket);
        ticket.wake();
    }

    private finishRegistration(ticket: SnapshotDeliveryGuardTicketImpl) {
        if (ticket.finalized)
            return;
        ticket.finalized = true;
        const cohort = ticket.cohort;
        cohort?.tickets.delete(ticket);
        // A source/lifecycle failure before the detection window closes must
        // not promote two unrelated live requests into a three-camera burst.
        // Successful owners remain as historical cohort diagnostics. Once
        // promoted, a cohort never rolls back; that would race eligible work.
        if (cohort && !cohort.burst
            && (ticket.cancelled || ticket.failedOpenReason)
            && ![...cohort.tickets].some(existing => existing.options.owner.id === ticket.options.owner.id))
            cohort.owners.delete(ticket.options.owner.id);
        const ownerTickets = this.ownerTickets.get(ticket.options.owner.id);
        ownerTickets?.delete(ticket);
        if (ownerTickets && !ownerTickets.size)
            this.ownerTickets.delete(ticket.options.owner.id);
        if (ticket.counted) {
            ticket.counted = false;
            this.registeredPending--;
        }
    }

    private lifecycleFailure(ticket: SnapshotDeliveryGuardTicketImpl) {
        if (ticket.failedOpenReason)
            return ticket.failedOpenReason;
        if (this.closed)
            return 'coordinator-closed' as const;
        if (!this.isOwnerCurrent(ticket.options.owner))
            return 'owner-released' as const;
    }

    private waitForWake(ticket: SnapshotDeliveryGuardTicketImpl, delayMs: number) {
        const customSleep = ticket.options.sleep;
        if (customSleep) {
            let wake: (() => void) | undefined;
            const interrupted = new Promise<void>(resolve => wake = resolve);
            ticket.wakeListeners.add(wake!);
            return Promise.race([customSleep(delayMs), interrupted]).finally(() => {
                ticket.wakeListeners.delete(wake!);
            });
        }

        return new Promise<void>((resolve, reject) => {
            let settled = false;
            let timer: NodeJS.Timeout | undefined;
            const finish = () => {
                if (settled)
                    return;
                settled = true;
                if (timer)
                    clearTimeout(timer);
                ticket.wakeListeners.delete(finish);
                resolve();
            };
            ticket.wakeListeners.add(finish);
            try {
                timer = setTimeout(finish, delayMs);
                timer.unref?.();
            }
            catch (error) {
                ticket.wakeListeners.delete(finish);
                reject(error);
            }
        });
    }

    private immediateTrace(
        ticket: SnapshotDeliveryGuardTicketImpl,
        readyAtNs: bigint,
        applied: boolean,
        failedOpenReason = ticket.failedOpenReason,
    ): SnapshotDeliveryGuardTrace {
        const nowNs = ticket.options.nowNs || monotonicNowNs;
        let handoffAtNs = readyAtNs;
        try {
            handoffAtNs = nowNs();
        }
        catch {
            failedOpenReason ||= 'clock';
        }
        const classification = ticket.bypass ? 'bypass' : ticket.cohort?.burst ? 'burst' : 'isolated';
        const floorMs = classification === 'burst'
            ? durationMs(ticket.options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS)
            : classification === 'isolated'
                ? durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS)
                : 0;
        const cohort = ticket.cohort;
        return {
            applied,
            classification,
            handoffAtNs,
            requestElapsedMs: Math.max(0, nsToMs(handoffAtNs - ticket.options.startedAtNs)),
            readyDelayMs: Math.max(0, nsToMs(handoffAtNs - readyAtNs)),
            floorMs,
            spacingMs: durationMs(ticket.options.spacingMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS),
            queueAhead: failedOpenReason === 'queue-cap' ? ticket.queueAheadAtRegistration : 0,
            plannedSleepMs: 0,
            timerWaits: 0,
            eligibilityWaitMs: 0,
            cohortOwnerCount: cohort?.owners.size,
            cohortSpanMs: cohort ? Math.max(0, nsToMs(cohort.lastAtNs - cohort.firstAtNs)) : undefined,
            failedOpen: !!failedOpenReason,
            failedOpenReason,
        };
    }

    private async waitForEligibility(
        ticket: SnapshotDeliveryGuardTicketImpl,
        readyAtNs: bigint,
    ): Promise<EligibilityResult> {
        const nowNs = ticket.options.nowNs || monotonicNowNs;
        const cohort = ticket.cohort!;
        const maxHoldAtNs = readyAtNs + msToNs(this.maxHoldMs);
        let plannedSleepMs = 0;
        let timerWaits = 0;
        const withCohortTrace = (
            result: Omit<EligibilityResult, 'cohortOwnerCount' | 'cohortSpanMs'>,
        ): EligibilityResult => ({
            ...result,
            cohortOwnerCount: cohort.owners.size,
            cohortSpanMs: Math.max(0, nsToMs(cohort.lastAtNs - cohort.firstAtNs)),
        });

        while (true) {
            const lifecycleFailure = this.lifecycleFailure(ticket);
            if (lifecycleFailure) {
                return withCohortTrace({
                    classification: cohort.burst ? 'burst' : 'isolated',
                    floorMs: cohort.burst
                        ? durationMs(ticket.options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS)
                        : durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS),
                    eligibilityAtNs: readyAtNs,
                    plannedSleepMs,
                    timerWaits,
                    failedOpen: true,
                    failedOpenReason: lifecycleFailure,
                });
            }

            let now: bigint;
            try {
                now = nowNs();
            }
            catch {
                return withCohortTrace({
                    classification: cohort.burst ? 'burst' : 'isolated',
                    floorMs: cohort.burst
                        ? durationMs(ticket.options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS)
                        : durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS),
                    eligibilityAtNs: readyAtNs,
                    plannedSleepMs,
                    timerWaits,
                    failedOpen: true,
                    failedOpenReason: 'clock',
                });
            }

            if (now >= maxHoldAtNs) {
                return withCohortTrace({
                    classification: cohort.burst ? 'burst' : 'isolated',
                    floorMs: cohort.burst
                        ? durationMs(ticket.options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS)
                        : durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS),
                    eligibilityAtNs: now,
                    plannedSleepMs,
                    timerWaits,
                    failedOpen: true,
                    failedOpenReason: 'max-hold',
                });
            }

            if (!cohort.burst && now < cohort.detectAtNs) {
                const waitUntilNs = cohort.detectAtNs < maxHoldAtNs ? cohort.detectAtNs : maxHoldAtNs;
                const delayMs = Math.ceil(nsToMs(waitUntilNs - now));
                plannedSleepMs += delayMs;
                timerWaits++;
                try {
                    await this.waitForWake(ticket, delayMs);
                }
                catch {
                    return withCohortTrace({
                        classification: 'isolated',
                        floorMs: durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS),
                        eligibilityAtNs: now,
                        plannedSleepMs,
                        timerWaits,
                        failedOpen: true,
                        failedOpenReason: 'timer',
                    });
                }
                continue;
            }

            const classification = cohort.burst ? 'burst' : 'isolated';
            const floorMs = classification === 'burst'
                ? durationMs(ticket.options.floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS)
                : durationMs(ticket.options.isolatedFloorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS);
            const eligibleAtNs = ticket.options.startedAtNs + msToNs(floorMs);
            if (now >= eligibleAtNs) {
                return withCohortTrace({
                    classification,
                    floorMs,
                    eligibilityAtNs: now,
                    plannedSleepMs,
                    timerWaits,
                    failedOpen: false,
                });
            }

            const waitUntilNs = eligibleAtNs < maxHoldAtNs ? eligibleAtNs : maxHoldAtNs;
            const delayMs = Math.ceil(nsToMs(waitUntilNs - now));
            plannedSleepMs += delayMs;
            timerWaits++;
            try {
                await this.waitForWake(ticket, delayMs);
            }
            catch {
                return withCohortTrace({
                    classification,
                    floorMs,
                    eligibilityAtNs: now,
                    plannedSleepMs,
                    timerWaits,
                    failedOpen: true,
                    failedOpenReason: 'timer',
                });
            }
        }
    }

    private async runHandoff(
        ticket: SnapshotDeliveryGuardTicketImpl,
        readyAtNs: bigint,
        eligibility: EligibilityResult,
        queueAhead: number,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ) {
        const nowNs = ticket.options.nowNs || monotonicNowNs;
        const spacingMs = durationMs(ticket.options.spacingMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
        const maxHoldAtNs = readyAtNs + msToNs(this.maxHoldMs);
        let plannedSleepMs = eligibility.plannedSleepMs;
        let timerWaits = eligibility.timerWaits;
        let failedOpen = eligibility.failedOpen;
        let failedOpenReason = eligibility.failedOpenReason;

        while (!failedOpen) {
            const lifecycleFailure = this.lifecycleFailure(ticket);
            if (lifecycleFailure) {
                failedOpen = true;
                failedOpenReason = lifecycleFailure;
                break;
            }
            let now: bigint;
            try {
                now = nowNs();
            }
            catch {
                failedOpen = true;
                failedOpenReason = 'clock';
                break;
            }
            if (now >= maxHoldAtNs) {
                failedOpen = true;
                failedOpenReason = 'max-hold';
                break;
            }
            const spacingAtNs = this.lastHandoffAtNs === undefined
                ? now
                : this.lastHandoffAtNs + msToNs(spacingMs);
            if (now >= spacingAtNs)
                break;
            const waitUntilNs = spacingAtNs < maxHoldAtNs ? spacingAtNs : maxHoldAtNs;
            const delayMs = Math.ceil(nsToMs(waitUntilNs - now));
            plannedSleepMs += delayMs;
            timerWaits++;
            try {
                await this.waitForWake(ticket, delayMs);
            }
            catch {
                failedOpen = true;
                failedOpenReason = 'timer';
            }
        }

        let handoffAtNs = readyAtNs;
        try {
            handoffAtNs = nowNs();
        }
        catch {
            failedOpen = true;
            failedOpenReason ||= 'clock';
        }
        const previousHandoffAtNs = this.lastHandoffAtNs;
        const requestElapsedMs = Math.max(0, nsToMs(handoffAtNs - ticket.options.startedAtNs));
        const previousHandoffDeltaMs = previousHandoffAtNs === undefined
            ? undefined
            : Math.max(0, nsToMs(handoffAtNs - previousHandoffAtNs));
        const trace: SnapshotDeliveryGuardTrace = {
            applied: true,
            classification: eligibility.classification,
            handoffAtNs,
            requestElapsedMs,
            readyDelayMs: Math.max(0, nsToMs(handoffAtNs - readyAtNs)),
            floorMs: eligibility.floorMs,
            floorSlackMs: requestElapsedMs - eligibility.floorMs,
            spacingMs,
            previousHandoffDeltaMs,
            spacingSlackMs: previousHandoffDeltaMs === undefined
                ? undefined
                : previousHandoffDeltaMs - spacingMs,
            queueAhead,
            plannedSleepMs,
            timerWaits,
            eligibilityWaitMs: Math.max(0, nsToMs(eligibility.eligibilityAtNs - readyAtNs)),
            cohortOwnerCount: eligibility.cohortOwnerCount,
            cohortSpanMs: eligibility.cohortSpanMs,
            failedOpen,
            failedOpenReason,
        };

        // Record the lane timestamp after synchronous callback and trace work.
        // A callback exception is returned to its caller but is never retried.
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

    /** @internal Called only by SnapshotDeliveryGuardTicketImpl. */
    deliverTicket(
        ticket: SnapshotDeliveryGuardTicketImpl,
        options: SnapshotDeliveryGuardReadyOptions,
        deliver: (trace: SnapshotDeliveryGuardTrace) => void,
    ): Promise<void> | undefined {
        const readyAtNs = options.readyAtNs;
        if (ticket.bypass || ticket.failedOpenReason) {
            const applied = !ticket.bypass;
            try {
                deliver(this.immediateTrace(ticket, readyAtNs, applied));
            }
            finally {
                this.finishRegistration(ticket);
            }
            return;
        }

        const completion = (async () => {
            const eligibility = await this.waitForEligibility(ticket, readyAtNs);
            if (eligibility.failedOpen) {
                const trace = this.immediateTrace(
                    ticket,
                    readyAtNs,
                    true,
                    eligibility.failedOpenReason,
                );
                trace.classification = eligibility.classification;
                trace.floorMs = eligibility.floorMs;
                trace.floorSlackMs = trace.requestElapsedMs - eligibility.floorMs;
                trace.plannedSleepMs = eligibility.plannedSleepMs;
                trace.timerWaits = eligibility.timerWaits;
                trace.eligibilityWaitMs = trace.readyDelayMs;
                trace.cohortOwnerCount = eligibility.cohortOwnerCount;
                trace.cohortSpanMs = eligibility.cohortSpanMs;
                deliver(trace);
                return;
            }

            // Eligibility is deliberately complete before this global lane.
            const queueAhead = this.handoffPending++;
            const previous = this.handoffTail;
            const handoff = previous.then(() => this.runHandoff(
                ticket,
                readyAtNs,
                eligibility,
                queueAhead,
                deliver,
            )).finally(() => {
                this.handoffPending--;
            });
            this.handoffTail = handoff.then(() => undefined, () => undefined);
            await handoff;
        })().finally(() => {
            this.finishRegistration(ticket);
        });
        return completion;
    }
}
