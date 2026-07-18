import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS,
    HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS,
    HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS,
    isSnapshotDeliveryGuardEnabled,
    SnapshotDeliveryGuardCoordinator,
    SnapshotDeliveryGuardOwner,
    SnapshotDeliveryGuardTicket,
    SnapshotDeliveryGuardTrace,
} from '../src/types/camera/camera-snapshot-delivery-guard';

const MS = 1_000_000n;

class ManualClock {
    now = 0n;
    sleepers: Array<{ deadline: bigint; resolve: () => void }> = [];

    nowNs = () => this.now;

    sleep = (delayMs: number) => new Promise<void>(resolve => {
        this.sleepers.push({
            deadline: this.now + BigInt(delayMs) * MS,
            resolve,
        });
    });

    set(ms: number) {
        this.now = BigInt(ms) * MS;
    }

    async flush() {
        for (let index = 0; index < 20; index++)
            await Promise.resolve();
    }

    async advanceTo(ms: number) {
        const next = BigInt(ms) * MS;
        assert.ok(next >= this.now, 'manual clock cannot move backwards');
        this.now = next;
        for (let round = 0; round < 20; round++) {
            const due = this.sleepers.filter(entry => entry.deadline <= this.now);
            this.sleepers = this.sleepers.filter(entry => entry.deadline > this.now);
            for (const entry of due)
                entry.resolve();
            await this.flush();
            if (!this.sleepers.some(entry => entry.deadline <= this.now))
                break;
        }
    }
}

function registration(
    coordinator: SnapshotDeliveryGuardCoordinator,
    owner: SnapshotDeliveryGuardOwner,
    clock: ManualClock,
    startedAtMs: number,
    overrides: Record<string, unknown> = {},
): SnapshotDeliveryGuardTicket {
    return coordinator.register({
        enabled: true,
        reason: 0,
        startedAtNs: BigInt(startedAtMs) * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
        ...overrides,
    });
}

function ready(
    ticket: SnapshotDeliveryGuardTicket,
    readyAtMs: number,
    traces: SnapshotDeliveryGuardTrace[],
) {
    return ticket.deliver({ readyAtNs: BigInt(readyAtMs) * MS }, trace => traces.push(trace))!;
}

test('a lone periodic request is handed off after Home invalidation at 2.7 seconds', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = new ManualClock();
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = ready(registration(coordinator, owner, clock, 0), 10, traces);

    await clock.advanceTo(2_699);
    assert.equal(traces.length, 0);
    await clock.advanceTo(2_700);
    await pending;

    assert.equal(traces.length, 1);
    assert.equal(traces[0].classification, 'isolated');
    assert.equal(traces[0].floorMs, HOMEKIT_SNAPSHOT_DELIVERY_ISOLATED_FLOOR_MS);
    assert.equal(traces[0].handoffAtNs, 2_700n * MS);
    assert.equal(traces[0].failedOpen, false);
});

test('three distinct cameras promote a visible-grid burst to the 300ms path', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const owners = ['a', 'b', 'c'].map(id => coordinator.createOwner(id));
    const tickets: SnapshotDeliveryGuardTicket[] = [];
    for (const [index, owner] of owners.entries()) {
        clock.set(index);
        tickets.push(registration(coordinator, owner, clock, index));
    }
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = tickets.map(ticket => ready(ticket, 2, traces));

    await clock.advanceTo(299);
    assert.equal(traces.length, 0);
    await clock.advanceTo(300);
    assert.equal(traces.length, 1);
    await clock.advanceTo(375);
    assert.equal(traces.length, 2);
    await clock.advanceTo(450);
    await Promise.all(pending);

    assert.deepEqual(traces.map(trace => trace.classification), ['burst', 'burst', 'burst']);
    assert.deepEqual(traces.map(trace => trace.handoffAtNs), [300n * MS, 375n * MS, 450n * MS]);
    assert.equal(traces[0].floorMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS);
    assert.equal(traces[1].previousHandoffDeltaMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
    assert.equal(traces[2].previousHandoffDeltaMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
});

test('promotion racing pending detection timers still delivers each ticket exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const first = registration(coordinator, coordinator.createOwner('a'), clock, 0);
    clock.set(10);
    const second = registration(coordinator, coordinator.createOwner('b'), clock, 10);
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = [ready(first, 10, traces), ready(second, 10, traces)];
    await clock.flush();

    clock.set(100);
    const third = registration(coordinator, coordinator.createOwner('c'), clock, 100);
    pending.push(ready(third, 100, traces));
    await clock.flush();
    await clock.advanceTo(300);
    await clock.advanceTo(375);
    await clock.advanceTo(450);
    await Promise.all(pending);

    assert.equal(traces.length, 3);
    assert.ok(traces.every(trace => trace.classification === 'burst'));
});

test('a waiting isolated request does not head-of-line block a later burst', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const isolatedOwner = coordinator.createOwner('isolated');
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const isolated = ready(registration(coordinator, isolatedOwner, clock, 0), 5, traces);
    await clock.advanceTo(300); // close the first fixed detection window

    const burstTickets: SnapshotDeliveryGuardTicket[] = [];
    for (const [offset, id] of [0, 1, 2].entries()) {
        clock.set(300 + offset);
        const owner = coordinator.createOwner(`burst-${id}`);
        burstTickets.push(registration(coordinator, owner, clock, 300 + offset));
    }
    const burst = burstTickets.map(ticket => ready(ticket, 302, traces));

    await clock.advanceTo(600);
    assert.equal(traces.length, 1);
    assert.equal(traces[0].classification, 'burst');
    await clock.advanceTo(675);
    await clock.advanceTo(750);
    await Promise.all(burst);
    assert.equal(traces.filter(trace => trace.classification === 'isolated').length, 0);

    await clock.advanceTo(2_700);
    await isolated;
    assert.equal(traces.at(-1)?.classification, 'isolated');
});

test('late cameras may join a promoted burst through the fixed 700ms window', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const first = [0, 40, 100].map((startedAt, index) => {
        clock.set(startedAt);
        return registration(coordinator, coordinator.createOwner(`first-${index}`), clock, startedAt);
    });
    clock.set(650);
    const late = registration(coordinator, coordinator.createOwner('late'), clock, 650);
    clock.set(701);
    const after = registration(coordinator, coordinator.createOwner('after'), clock, 701);
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = [
        ...first.map(ticket => ready(ticket, 701, traces)),
        ready(late, 701, traces),
        ready(after, 701, traces),
    ];

    await clock.flush();
    await clock.advanceTo(776);
    await clock.advanceTo(851);
    await clock.advanceTo(950);
    assert.equal(traces.filter(trace => trace.classification === 'burst').length, 4);
    assert.equal(traces.some(trace => trace.classification === 'isolated'), false);
    await clock.advanceTo(3_401);
    await Promise.all(pending);
    assert.equal(traces.at(-1)?.classification, 'isolated');
});

test('cohort detection and join windows are fixed rather than rolling', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const tickets = [0, 200, 400].map((startedAt, index) => {
        clock.set(startedAt);
        return registration(coordinator, coordinator.createOwner(`fixed-${index}`), clock, startedAt);
    });
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = tickets.map(ticket => ready(ticket, 400, traces));

    await clock.advanceTo(2_700);
    await clock.advanceTo(2_900);
    await clock.advanceTo(3_100);
    await Promise.all(pending);
    assert.equal(traces.length, 3);
    assert.ok(traces.every(trace => trace.classification === 'isolated'));
});

test('a request at the 700ms boundary joins but one millisecond later does not', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const burst = [0, 1, 2, 700].map((startedAt, index) => {
        clock.set(startedAt);
        return registration(coordinator, coordinator.createOwner(`boundary-${index}`), clock, startedAt);
    });
    clock.set(701);
    const isolated = registration(coordinator, coordinator.createOwner('after-boundary'), clock, 701);
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = [
        ...burst.map(ticket => ready(ticket, 701, traces)),
        ready(isolated, 701, traces),
    ];

    await clock.flush();
    await clock.advanceTo(776);
    await clock.advanceTo(851);
    await clock.advanceTo(1_000);
    assert.equal(traces.filter(trace => trace.classification === 'burst').length, 4);
    await clock.advanceTo(3_401);
    await Promise.all(pending);
    assert.equal(traces.at(-1)?.classification, 'isolated');
});

test('repeated requests from one owner and requests from only two owners stay isolated', async () => {
    for (const ownerIds of [['a', 'a', 'a'], ['a', 'b', 'a', 'b']]) {
        const coordinator = new SnapshotDeliveryGuardCoordinator();
        const clock = new ManualClock();
        const owners = new Map<string, SnapshotDeliveryGuardOwner>();
        const tickets = ownerIds.map((id, index) => {
            let owner = owners.get(id);
            if (!owner) {
                owner = coordinator.createOwner(id);
                owners.set(id, owner);
            }
            clock.set(index * 20);
            return registration(coordinator, owner, clock, index * 20);
        });
        const traces: SnapshotDeliveryGuardTrace[] = [];
        const pending = tickets.map(ticket => ready(ticket, 100, traces));
        await clock.advanceTo(3_000);
        for (let index = 1; index < tickets.length; index++)
            await clock.advanceTo(3_000 + index * HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
        await Promise.all(pending);
        assert.ok(traces.every(trace => trace.classification === 'isolated'));
    }
});

test('a source cancelled inside the detection window does not promote two cameras', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const cancelled = registration(coordinator, coordinator.createOwner('cancelled'), clock, 0);
    cancelled.cancel();
    const active = [1, 2].map((startedAt, index) => {
        clock.set(startedAt);
        return registration(coordinator, coordinator.createOwner(`active-${index}`), clock, startedAt);
    });
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = active.map(ticket => ready(ticket, 2, traces));
    await clock.advanceTo(3_000);
    await clock.advanceTo(3_075);
    await Promise.all(pending);
    assert.ok(traces.every(trace => trace.classification === 'isolated'));
});

test('a promoted cohort intentionally stays burst if the promoting source then fails', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const first = registration(coordinator, coordinator.createOwner('first'), clock, 0);
    clock.set(50);
    const second = registration(coordinator, coordinator.createOwner('second'), clock, 50);
    clock.set(100);
    const promoting = registration(coordinator, coordinator.createOwner('promoting'), clock, 100);
    promoting.cancel();
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = [ready(first, 100, traces), ready(second, 100, traces)];

    await clock.advanceTo(300);
    await clock.advanceTo(375);
    await Promise.all(pending);
    assert.equal(traces.length, 2);
    assert.ok(traces.every(trace => trace.classification === 'burst'));
});

test('event, unknown, disabled, and string periodic reasons bypass synchronously', () => {
    for (const [reason, enabled] of [[1, true], [2, true], [undefined, true], [null, true], ['0', true], [0, false]] as const) {
        const coordinator = new SnapshotDeliveryGuardCoordinator();
        const owner = coordinator.createOwner('camera');
        const clock = new ManualClock();
        const calls: string[] = [];
        const ticket = coordinator.register({
            enabled,
            reason,
            startedAtNs: 0n,
            owner,
            nowNs: clock.nowNs,
            sleep: async () => assert.fail('bypass must not schedule'),
        });
        const pending = ticket.deliver({ readyAtNs: 0n }, trace => {
            assert.equal(trace.applied, false);
            assert.equal(trace.classification, 'bypass');
            calls.push('callback');
        });
        calls.push('returned');
        assert.equal(pending, undefined);
        assert.deepEqual(calls, ['callback', 'returned']);
    }
});

test('event delivery bypasses a pending isolated request', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = new ManualClock();
    const calls: string[] = [];
    const periodic = registration(coordinator, owner, clock, 0).deliver(
        { readyAtNs: 0n },
        () => calls.push('periodic'),
    )!;
    await clock.flush();
    const event = coordinator.register({
        enabled: true,
        reason: 1,
        startedAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
    }).deliver({ readyAtNs: 0n }, () => calls.push('event'));
    calls.push('returned');

    assert.equal(event, undefined);
    assert.deepEqual(calls, ['event', 'returned']);
    await clock.advanceTo(2_700);
    await periodic;
    assert.deepEqual(calls, ['event', 'returned', 'periodic']);
});

test('source cancellation releases queue capacity without invoking delivery', () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(1);
    const clock = new ManualClock();
    const first = registration(coordinator, coordinator.createOwner('first'), clock, 0);
    first.cancel();
    const second = registration(coordinator, coordinator.createOwner('second'), clock, 0);
    const overflow = registration(coordinator, coordinator.createOwner('overflow'), clock, 0);
    let trace: SnapshotDeliveryGuardTrace | undefined;
    const pending = overflow.deliver({ readyAtNs: 0n }, delivered => trace = delivered);
    assert.equal(pending, undefined);
    assert.equal(trace?.failedOpenReason, 'queue-cap');
    second.cancel();
});

test('queue overflow fails open synchronously when its image becomes ready', () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(1);
    const clock = new ManualClock();
    registration(coordinator, coordinator.createOwner('first'), clock, 0);
    const overflow = registration(coordinator, coordinator.createOwner('overflow'), clock, 0);
    let trace: SnapshotDeliveryGuardTrace | undefined;
    const pending = overflow.deliver({ readyAtNs: 0n }, delivered => trace = delivered);
    assert.equal(pending, undefined);
    assert.equal(trace?.failedOpenReason, 'queue-cap');
    assert.equal(trace?.queueAhead, 1);
});

test('queue overflow retains rejection-time depth after the admitted request finishes', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(1);
    const clock = new ManualClock();
    const admitted = registration(coordinator, coordinator.createOwner('first'), clock, 0, {
        burstOwners: 1,
        floorMs: 0,
        spacingMs: 0,
    });
    const overflow = registration(coordinator, coordinator.createOwner('overflow'), clock, 0);
    await admitted.deliver({ readyAtNs: 0n }, () => { });

    let trace: SnapshotDeliveryGuardTrace | undefined;
    const pending = overflow.deliver({ readyAtNs: 0n }, delivered => trace = delivered);
    assert.equal(pending, undefined);
    assert.equal(trace?.failedOpenReason, 'queue-cap');
    assert.equal(trace?.queueAhead, 1);

    const replacement = registration(coordinator, coordinator.createOwner('replacement'), clock, 0, {
        burstOwners: 1,
        floorMs: 0,
        spacingMs: 0,
    });
    let replacementTrace: SnapshotDeliveryGuardTrace | undefined;
    await replacement.deliver({ readyAtNs: 0n }, delivered => replacementTrace = delivered);
    assert.equal(replacementTrace?.failedOpen, false);
});

test('owner release wakes an eligibility wait and fails open exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = new ManualClock();
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = ready(registration(coordinator, owner, clock, 0), 0, traces);
    await clock.flush();
    coordinator.releaseOwner(owner);
    await clock.flush();
    await pending;
    assert.equal(traces.length, 1);
    assert.equal(traces[0].failedOpenReason, 'owner-released');
});

test('owner recreation fails old work open and admits the new generation', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const oldOwner = coordinator.createOwner('camera');
    const oldTraces: SnapshotDeliveryGuardTrace[] = [];
    const oldPending = ready(registration(coordinator, oldOwner, clock, 0), 0, oldTraces);
    await clock.flush();

    const newOwner = coordinator.createOwner('camera');
    await clock.flush();
    await oldPending;
    assert.equal(oldTraces[0].failedOpenReason, 'owner-released');

    let newTrace: SnapshotDeliveryGuardTrace | undefined;
    await registration(coordinator, newOwner, clock, 0, {
        burstOwners: 1,
        floorMs: 0,
        spacingMs: 0,
    }).deliver({ readyAtNs: 0n }, delivered => newTrace = delivered);
    assert.equal(newTrace?.failedOpen, false);
});

test('coordinator close wakes all eligibility waits and fails open exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = ['a', 'b'].map(id => ready(
        registration(coordinator, coordinator.createOwner(id), clock, 0),
        0,
        traces,
    ));
    await clock.flush();
    coordinator.close();
    await clock.flush();
    await Promise.all(pending);
    assert.equal(traces.length, 2);
    assert.ok(traces.every(trace => trace.failedOpenReason === 'coordinator-closed'));
});

test('maximum hold fails an isolated request open before an unsafe indefinite wait', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(64, 100);
    const owner = coordinator.createOwner('camera');
    const clock = new ManualClock();
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const pending = ready(registration(coordinator, owner, clock, 0), 0, traces);
    await clock.advanceTo(100);
    await pending;
    assert.equal(traces.length, 1);
    assert.equal(traces[0].failedOpenReason, 'max-hold');
});

test('an early timer is rechecked against the monotonic clock', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    let now = 50n * MS;
    let first = true;
    const sleeps: number[] = [];
    let trace: SnapshotDeliveryGuardTrace | undefined;
    const ticket = coordinator.register({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        owner,
        burstOwners: 1,
        nowNs: () => now,
        sleep: async delayMs => {
            sleeps.push(delayMs);
            now += BigInt(first ? delayMs - 20 : delayMs) * MS;
            first = false;
        },
    });
    await ticket.deliver({ readyAtNs: 50n * MS }, delivered => trace = delivered);
    assert.deepEqual(sleeps, [250, 20]);
    assert.equal(trace?.handoffAtNs, 300n * MS);
    assert.equal(trace?.timerWaits, 2);
});

test('timer failure fails open and invokes the callback once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    let calls = 0;
    let trace: SnapshotDeliveryGuardTrace | undefined;
    const ticket = coordinator.register({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        owner,
        burstOwners: 1,
        nowNs: () => 50n * MS,
        sleep: async () => {
            throw new Error('timer failed');
        },
    });
    await ticket.deliver({ readyAtNs: 50n * MS }, delivered => {
        calls++;
        trace = delivered;
    });
    assert.equal(calls, 1);
    assert.equal(trace?.failedOpenReason, 'timer');
});

test('clock failure fails open and invokes the callback once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    let calls = 0;
    let trace: SnapshotDeliveryGuardTrace | undefined;
    const ticket = coordinator.register({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        owner,
        nowNs: () => {
            throw new Error('clock failed');
        },
    });
    await ticket.deliver({ readyAtNs: 50n * MS }, delivered => {
        calls++;
        trace = delivered;
    });
    assert.equal(calls, 1);
    assert.equal(trace?.failedOpenReason, 'clock');
});

test('callback failure is not retried and does not poison the handoff lane', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const owners = ['a', 'b', 'c'].map(id => coordinator.createOwner(id));
    const tickets = owners.map((owner, index) => {
        clock.set(index);
        return registration(coordinator, owner, clock, index);
    });
    let firstCalls = 0;
    const first = tickets[0].deliver({ readyAtNs: 2n * MS }, () => {
        firstCalls++;
        throw new Error('callback failed');
    })!;
    let laterCalls = 0;
    const later = tickets.slice(1).map(ticket => ticket.deliver(
        { readyAtNs: 2n * MS },
        () => laterCalls++,
    )!);

    await clock.advanceTo(300);
    await assert.rejects(first, /callback failed/);
    await clock.advanceTo(375);
    await clock.advanceTo(450);
    await Promise.all(later);
    assert.equal(firstCalls, 1);
    assert.equal(laterCalls, 2);
});

test('callback work is followed by the full handoff spacing interval', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const clock = new ManualClock();
    const tickets = [0, 1, 2].map((startedAt, index) => {
        clock.set(startedAt);
        return registration(coordinator, coordinator.createOwner(`work-${index}`), clock, startedAt);
    });
    const handoffs: bigint[] = [];
    const pending = tickets.map((ticket, index) => ticket.deliver(
        { readyAtNs: 2n * MS },
        trace => {
            handoffs.push(trace.handoffAtNs);
            if (index === 0)
                clock.set(320);
        },
    )!);

    await clock.advanceTo(300);
    assert.deepEqual(handoffs, [300n * MS]);
    await clock.advanceTo(394);
    assert.equal(handoffs.length, 1);
    await clock.advanceTo(395);
    await clock.advanceTo(470);
    await Promise.all(pending);
    assert.deepEqual(handoffs, [300n * MS, 395n * MS, 470n * MS]);
});

test('setting defaults enabled when absent and false explicitly disables it', () => {
    assert.equal(isSnapshotDeliveryGuardEnabled(undefined), true);
    assert.equal(isSnapshotDeliveryGuardEnabled(null), true);
    assert.equal(isSnapshotDeliveryGuardEnabled('true'), true);
    assert.equal(isSnapshotDeliveryGuardEnabled('false'), false);
});
