import assert from 'node:assert/strict';
import test from 'node:test';
import {
    HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS,
    HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS,
    isSnapshotDeliveryGuardEnabled,
    SnapshotDeliveryGuardCoordinator,
    SnapshotDeliveryGuardTrace,
} from '../src/types/camera/camera-snapshot-delivery-guard';

const MS = 1_000_000n;

function fakeTime(initialMs: number) {
    let now = BigInt(initialMs) * MS;
    const sleeps: number[] = [];
    return {
        nowNs: () => now,
        sleeps,
        advance(delayMs: number) {
            now += BigInt(delayMs) * MS;
        },
        sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
            now += BigInt(delayMs) * MS;
        },
    };
}

test('periodic delivery observes the 300ms floor from request start', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(1_050);
    let trace: SnapshotDeliveryGuardTrace | undefined;

    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 1_000n * MS,
        readyAtNs: 1_050n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, deliveredTrace => trace = deliveredTrace);

    assert.deepEqual(clock.sleeps, [250]);
    assert.equal(trace?.handoffAtNs, 1_300n * MS);
    assert.equal(trace?.requestElapsedMs, HOMEKIT_SNAPSHOT_DELIVERY_FLOOR_MS);
    assert.equal(trace?.readyDelayMs, 250);
    assert.equal(trace?.floorSlackMs, 0);
    assert.equal(trace?.timerWaits, 1);
});

test('a globally serialized burst is released at least 75ms apart', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(20);
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const deliveries = [0, 1, 2].map(() => coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 20n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, trace => traces.push(trace))!);

    await Promise.all(deliveries);

    assert.deepEqual(clock.sleeps, [280, 75, 75]);
    assert.deepEqual(traces.map(trace => trace.handoffAtNs), [300n * MS, 375n * MS, 450n * MS]);
    assert.deepEqual(traces.map(trace => trace.queueAhead), [0, 1, 2]);
    assert.equal(traces[1].previousHandoffDeltaMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
    assert.equal(traces[2].previousHandoffDeltaMs, HOMEKIT_SNAPSHOT_DELIVERY_SPACING_MS);
    assert.equal(traces[1].spacingSlackMs, 0);
    assert.equal(traces[2].spacingSlackMs, 0);
});

test('synchronous callback work cannot compress the next spacing window', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(0);
    const handoffs: bigint[] = [];
    const deliver = () => coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, trace => {
        handoffs.push(trace.handoffAtNs);
        clock.advance(20);
    })!;

    await Promise.all([deliver(), deliver()]);

    assert.deepEqual(clock.sleeps, [300, 75]);
    assert.deepEqual(handoffs, [300n * MS, 395n * MS]);
});

test('a source already older than the floor is delivered without a floor sleep', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(500);
    let trace: SnapshotDeliveryGuardTrace | undefined;

    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 500n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, deliveredTrace => trace = deliveredTrace);

    assert.deepEqual(clock.sleeps, []);
    assert.equal(trace?.requestElapsedMs, 500);
    assert.equal(trace?.readyDelayMs, 0);
    assert.equal(trace?.floorSlackMs, 200);
});

test('event and nonnumeric reasons bypass scheduling synchronously', () => {
    for (const reason of [1, undefined, null, '0', 2]) {
        const coordinator = new SnapshotDeliveryGuardCoordinator();
        const owner = coordinator.createOwner('camera');
        const calls: string[] = [];
        const pending = coordinator.deliver({
            enabled: true,
            reason,
            startedAtNs: 0n,
            readyAtNs: 10n * MS,
            owner,
            nowNs: () => 10n * MS,
            sleep: async () => {
                throw new Error('must not schedule');
            },
        }, trace => {
            assert.equal(trace.applied, false);
            calls.push('delivered');
        });
        calls.push('returned');

        assert.equal(pending, undefined);
        assert.deepEqual(calls, ['delivered', 'returned']);
    }
});

test('event delivery bypasses an already queued periodic request', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(0);
    let releaseTimer: (() => void) | undefined;
    const calls: string[] = [];
    const periodic = coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
        sleep: delayMs => new Promise(resolve => {
            clock.advance(delayMs);
            releaseTimer = resolve;
        }),
    }, () => calls.push('periodic'))!;
    await Promise.resolve();

    const event = coordinator.deliver({
        enabled: true,
        reason: 1,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
    }, () => calls.push('event'));
    calls.push('returned');

    assert.equal(event, undefined);
    assert.deepEqual(calls, ['event', 'returned']);
    assert.ok(releaseTimer);
    releaseTimer!();
    await periodic;
    assert.deepEqual(calls, ['event', 'returned', 'periodic']);
});

test('an early timer is rechecked until the floor is actually reached', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(50);
    let first = true;
    let trace: SnapshotDeliveryGuardTrace | undefined;

    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 50n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: async delayMs => {
            clock.sleeps.push(delayMs);
            clock.advance(first ? delayMs - 20 : delayMs);
            first = false;
        },
    }, deliveredTrace => trace = deliveredTrace);

    assert.deepEqual(clock.sleeps, [250, 20]);
    assert.equal(trace?.handoffAtNs, 300n * MS);
    assert.equal(trace?.timerWaits, 2);
    assert.equal(trace?.plannedSleepMs, 270);
});

test('timer failure fails open and invokes the callback exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(50);
    let deliveries = 0;
    let trace: SnapshotDeliveryGuardTrace | undefined;

    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 50n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: async () => {
            throw new Error('timer failed');
        },
    }, deliveredTrace => {
        deliveries++;
        trace = deliveredTrace;
    });

    assert.equal(deliveries, 1);
    assert.equal(trace?.failedOpen, true);
    assert.equal(trace?.floorSlackMs, -250);
});

test('callback failure is not retried and does not poison the global lane', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(300);
    let firstDeliveries = 0;
    const first = coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 300n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, () => {
        firstDeliveries++;
        throw new Error('callback failed');
    })!;

    await assert.rejects(first, /callback failed/);
    let secondDeliveries = 0;
    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 300n * MS,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, () => secondDeliveries++);

    assert.equal(firstDeliveries, 1);
    assert.equal(secondDeliveries, 1);
    assert.deepEqual(clock.sleeps, [75]);
});

test('releasing an owner wakes its pending timer and fails open exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(0);
    let trace: SnapshotDeliveryGuardTrace | undefined;
    let deliveries = 0;
    const pending = coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
        sleep: () => new Promise(() => { }),
    }, deliveredTrace => {
        deliveries++;
        trace = deliveredTrace;
    })!;
    await Promise.resolve();

    coordinator.releaseOwner(owner);
    await pending;

    assert.equal(deliveries, 1);
    assert.equal(trace?.failedOpen, true);
    assert.equal(trace?.failedOpenReason, 'owner-released');
});

test('owner recreation drains queued stale callbacks and admits the new owner', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const options = {
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: () => 0n,
        sleep: () => new Promise<void>(() => { }),
    };
    const first = coordinator.deliver(options, trace => traces.push(trace))!;
    const second = coordinator.deliver(options, trace => traces.push(trace))!;
    await Promise.resolve();

    coordinator.releaseOwner(owner);
    const replacement = coordinator.createOwner('camera');
    await Promise.all([first, second]);

    assert.equal(traces.length, 2);
    assert.deepEqual(
        traces.map(trace => trace.failedOpenReason),
        ['owner-released', 'owner-released'],
    );

    let replacementTrace: SnapshotDeliveryGuardTrace | undefined;
    await coordinator.deliver({
        ...options,
        owner: replacement,
        floorMs: 0,
        spacingMs: 0,
    }, trace => replacementTrace = trace);
    assert.equal(replacementTrace?.failedOpen, false);
});

test('closing wakes and drains all queued callbacks fail-open exactly once', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator();
    const owner = coordinator.createOwner('camera');
    const traces: SnapshotDeliveryGuardTrace[] = [];
    const options = {
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: () => 0n,
        sleep: () => new Promise<void>(() => { }),
    };
    const first = coordinator.deliver(options, trace => traces.push(trace))!;
    const second = coordinator.deliver(options, trace => traces.push(trace))!;
    await Promise.resolve();

    coordinator.close();
    await Promise.all([first, second]);

    assert.equal(traces.length, 2);
    assert.deepEqual(
        traces.map(trace => trace.failedOpenReason),
        ['coordinator-closed', 'coordinator-closed'],
    );
});

test('queue cap fails excess requests open without stranding the lane', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(1, 1_000);
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(0);
    let releaseTimer: (() => void) | undefined;
    const first = coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
        sleep: delayMs => new Promise(resolve => {
            clock.advance(delayMs);
            releaseTimer = resolve;
        }),
    }, () => { })!;
    await Promise.resolve();

    let overflowTrace: SnapshotDeliveryGuardTrace | undefined;
    const overflow = coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
    }, trace => overflowTrace = trace);

    assert.equal(overflow, undefined);
    assert.equal(overflowTrace?.failedOpenReason, 'queue-cap');
    assert.ok(releaseTimer);
    releaseTimer!();
    await first;
});

test('maximum hold bounds a backed-up periodic callback', async () => {
    const coordinator = new SnapshotDeliveryGuardCoordinator(64, 100);
    const owner = coordinator.createOwner('camera');
    const clock = fakeTime(0);
    let trace: SnapshotDeliveryGuardTrace | undefined;

    await coordinator.deliver({
        enabled: true,
        reason: 0,
        startedAtNs: 0n,
        readyAtNs: 0n,
        owner,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, deliveredTrace => trace = deliveredTrace);

    assert.deepEqual(clock.sleeps, [100]);
    assert.equal(trace?.handoffAtNs, 100n * MS);
    assert.equal(trace?.failedOpen, true);
    assert.equal(trace?.failedOpenReason, 'max-hold');
});

test('setting defaults enabled when absent and false explicitly disables it', () => {
    assert.equal(isSnapshotDeliveryGuardEnabled(undefined), true);
    assert.equal(isSnapshotDeliveryGuardEnabled(null), true);
    assert.equal(isSnapshotDeliveryGuardEnabled('true'), true);
    assert.equal(isSnapshotDeliveryGuardEnabled('false'), false);
});
