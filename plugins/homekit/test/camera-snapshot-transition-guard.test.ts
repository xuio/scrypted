import assert from 'node:assert/strict';
import test from 'node:test';
import {
    deliverSnapshotWithTransitionGuard,
    HOMEKIT_SNAPSHOT_TRANSITION_GUARD_MS,
    SnapshotStreamTransition,
    waitForSnapshotTransitionGuard,
} from '../src/types/camera/camera-snapshot-transition-guard';

const MS = 1_000_000n;

function fakeTime(initialMs: number) {
    let now = BigInt(initialMs) * MS;
    const sleeps: number[] = [];
    return {
        nowNs: () => now,
        sleeps,
        sleep: async (delayMs: number) => {
            sleeps.push(delayMs);
            now += BigInt(delayMs) * MS;
        },
    };
}

test('periodic snapshot waits only for the remainder of the 300ms transition window', async () => {
    const clock = fakeTime(1_050);
    const trace = await waitForSnapshotTransitionGuard({
        enabled: true,
        periodic: true,
        readyAtNs: 1_050n * MS,
        transition: { kind: 'start', atNs: 1_000n * MS },
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    });

    assert.deepEqual(clock.sleeps, [250]);
    assert.equal(trace.guardPlannedMs, 250);
    assert.equal(trace.guardDelayMs, 250);
    assert.equal(trace.nearestTransition, 'start');
    assert.equal(trace.transitionDeltaMs, 300);
    assert.equal(trace.guardReleasedAtNs, 1_300n * MS);
});

test('periodic snapshot replans when a newer transition occurs during the wait', async () => {
    const clock = fakeTime(1_050);
    let transition: SnapshotStreamTransition = { kind: 'start', atNs: 1_000n * MS };
    const trace = await waitForSnapshotTransitionGuard({
        enabled: true,
        periodic: true,
        readyAtNs: 1_050n * MS,
        latestTransition: () => transition,
        nowNs: clock.nowNs,
        sleep: async delayMs => {
            await clock.sleep(delayMs);
            if (clock.sleeps.length === 1)
                transition = { kind: 'stop', atNs: 1_200n * MS };
        },
    });

    assert.deepEqual(clock.sleeps, [250, 200]);
    assert.equal(trace.guardPlannedMs, 450);
    assert.equal(trace.guardDelayMs, 450);
    assert.equal(trace.nearestTransition, 'stop');
    assert.equal(trace.transitionDeltaMs, 300);
    assert.equal(trace.guardReleasedAtNs, 1_500n * MS);
});

test('event snapshot is never delayed even when the guard is enabled', async () => {
    const clock = fakeTime(2_010);
    const trace = await waitForSnapshotTransitionGuard({
        enabled: true,
        periodic: false,
        readyAtNs: 2_010n * MS,
        transition: { kind: 'stop', atNs: 2_000n * MS },
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    });

    assert.deepEqual(clock.sleeps, []);
    assert.equal(trace.guardPlannedMs, 0);
    assert.equal(trace.guardDelayMs, 0);
    assert.equal(trace.nearestTransition, 'stop');
    assert.equal(trace.transitionDeltaMs, 10);
});

test('disabled and event delivery callbacks stay synchronous', () => {
    for (const periodic of [true, false]) {
        const calls: string[] = [];
        const pending = deliverSnapshotWithTransitionGuard({
            enabled: !periodic,
            periodic,
            readyAtNs: 2_010n * MS,
            transition: { kind: 'stop', atNs: 2_000n * MS },
            nowNs: () => 2_010n * MS,
        }, () => calls.push('delivered'));
        calls.push('returned');

        assert.equal(pending, undefined);
        assert.deepEqual(calls, ['delivered', 'returned']);
    }
});

test('transition lookup failure fails open synchronously', () => {
    const calls: string[] = [];
    const pending = deliverSnapshotWithTransitionGuard({
        enabled: true,
        periodic: true,
        readyAtNs: 2_010n * MS,
        latestTransition: () => {
            throw new Error('storage unavailable');
        },
        nowNs: () => 2_010n * MS,
    }, () => calls.push('delivered'));
    calls.push('returned');

    assert.equal(pending, undefined);
    assert.deepEqual(calls, ['delivered', 'returned']);
});

test('guard defaults off and old or future transitions are never delayed', async () => {
    for (const options of [
        {
            enabled: false,
            readyAtNs: 3_010n * MS,
            transition: { kind: 'start' as const, atNs: 3_000n * MS },
        },
        {
            enabled: true,
            readyAtNs: 3_300n * MS,
            transition: { kind: 'stop' as const, atNs: 3_000n * MS },
        },
        {
            enabled: true,
            readyAtNs: 3_000n * MS,
            transition: { kind: 'start' as const, atNs: 3_001n * MS },
        },
    ]) {
        const clock = fakeTime(Number(options.readyAtNs / MS));
        const trace = await waitForSnapshotTransitionGuard({
            ...options,
            periodic: true,
            nowNs: clock.nowNs,
            sleep: clock.sleep,
        });
        assert.deepEqual(clock.sleeps, []);
        assert.equal(trace.guardPlannedMs, 0);
    }
});

test('delivery callback is invoked exactly once after the guard', async () => {
    const clock = fakeTime(4_100);
    let deliveries = 0;
    let deliveredTrace: unknown;
    await deliverSnapshotWithTransitionGuard({
        enabled: true,
        periodic: true,
        readyAtNs: 4_100n * MS,
        transition: { kind: 'stop', atNs: 4_000n * MS },
        guardMs: HOMEKIT_SNAPSHOT_TRANSITION_GUARD_MS,
        nowNs: clock.nowNs,
        sleep: clock.sleep,
    }, trace => {
        deliveries++;
        deliveredTrace = trace;
    });

    assert.equal(deliveries, 1);
    assert.deepEqual(clock.sleeps, [200]);
    assert.equal((deliveredTrace as { guardDelayMs: number }).guardDelayMs, 200);
});
