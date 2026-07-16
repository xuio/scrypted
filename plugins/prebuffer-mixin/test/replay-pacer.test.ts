import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateReplayBurstBytes,
  calculateReplayBytesPerSecond,
  DEFAULT_REPLAY_BURST_BYTES,
  getHomeKitReplayBootstrapBytesPerSecond,
  HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY,
  MAX_REPLAY_BYTES_PER_SECOND,
  MIN_REPLAY_BYTES_PER_SECOND,
  ONE_MTU_REPLAY_BURST_BYTES,
  ONE_MTU_REPLAY_BYTES_PER_SECOND,
  ReplayPacer,
  shouldPaceReplay,
} from '../src/replay-pacer';

type Item = {
  id: string;
  bytes: number;
  prebuffer: boolean;
  track?: 'video' | 'audio';
};

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('replay rate is ten times the measured average and clamped to 8-12 Mbit/s', () => {
  assert.equal(calculateReplayBytesPerSecond(0, 4000), MIN_REPLAY_BYTES_PER_SECOND);
  assert.equal(calculateReplayBytesPerSecond(120_000, 1000), 1_200_000);
  assert.equal(calculateReplayBytesPerSecond(50_000, 1000), MIN_REPLAY_BYTES_PER_SECOND);
  assert.equal(calculateReplayBytesPerSecond(20_000_000, 1000), MAX_REPLAY_BYTES_PER_SECOND);
});

test('low-rate sources use one-MTU replay while high-rate sources retain catch-up capacity', () => {
  assert.equal(calculateReplayBurstBytes(0, 4000), ONE_MTU_REPLAY_BURST_BYTES);
  assert.equal(calculateReplayBurstBytes(2_000_000, 4000), ONE_MTU_REPLAY_BURST_BYTES);
  assert.equal(calculateReplayBurstBytes(2_000_001, 4000), DEFAULT_REPLAY_BURST_BYTES);
  assert.equal(calculateReplayBurstBytes(3_000_000, 4000), DEFAULT_REPLAY_BURST_BYTES);
  assert.equal(calculateReplayBurstBytes(5_000_000, 4000), DEFAULT_REPLAY_BURST_BYTES);
  // A partial medium GOP beginning with a large IDR looks high-rate by itself,
  // but the stable ten-second average remains safely below the cutoff.
  assert.equal(calculateReplayBurstBytes(1_000_000, 500, 3_000_000, 10_000), ONE_MTU_REPLAY_BURST_BYTES);
  // Conversely, a quiet selected slice must not hide a sustained high stream.
  assert.equal(calculateReplayBurstBytes(100_000, 500, 10_000_000, 10_000), DEFAULT_REPLAY_BURST_BYTES);
  assert.equal(calculateReplayBurstBytes(1000, 0, 10_000_000, 10_000), DEFAULT_REPLAY_BURST_BYTES);
  // Too little history is a cold fallback, not a stable-rate override.
  assert.equal(calculateReplayBurstBytes(1_000_000, 500, 300_000, 1000), DEFAULT_REPLAY_BURST_BYTES);
});

test('implicit and explicit-zero live bootstrap are paced; positive HKSV pre-roll bypasses it', () => {
  assert.equal(shouldPaceReplay(undefined), true);
  assert.equal(shouldPaceReplay(0), true);
  assert.equal(shouldPaceReplay(10_000), false);
});

test('HomeKit bootstrap rate hints are capability-gated and allowlisted', () => {
  for (const bytesPerSecond of [1_000_000, 1_250_000, 1_500_000]) {
    assert.equal(getHomeKitReplayBootstrapBytesPerSecond({
      destinationType: '@scrypted/homekit',
      metadata: {
        [HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY]: bytesPerSecond,
      },
    }), bytesPerSecond);
  }

  assert.equal(getHomeKitReplayBootstrapBytesPerSecond({
    destinationType: '@scrypted/webrtc',
    metadata: {
      [HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY]: 1_500_000,
    },
  }), undefined);
  assert.equal(getHomeKitReplayBootstrapBytesPerSecond({
    destinationType: '@scrypted/homekit',
    metadata: {
      [HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY]: 2_000_000,
    },
  }), undefined);
});

test('live ingress appended during replay never overtakes the cached FIFO', async () => {
  const written: string[] = [];
  let pacer: ReplayPacer<Item>;
  pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000_000,
    burstBytes: 1_000,
    maxQueuedBytes: 10_000,
    getBytes: item => item.bytes,
    write: item => {
      written.push(item.id);
      if (item.id === 'replay-1')
        pacer.enqueue({ id: 'live-1', bytes: 10, prebuffer: false });
    },
  });
  pacer.enqueue({ id: 'replay-1', bytes: 10, prebuffer: true });
  pacer.enqueue({ id: 'replay-2', bytes: 10, prebuffer: true });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(written, ['replay-1', 'replay-2', 'live-1']);
});

test('mixed audio/video order and replay flags are preserved exactly', async () => {
  const written: Pick<Item, 'id' | 'track' | 'prebuffer'>[] = [];
  const pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000_000,
    burstBytes: 1_000,
    maxQueuedBytes: 10_000,
    getBytes: item => item.bytes,
    write: item => {
      written.push({ id: item.id, track: item.track, prebuffer: item.prebuffer });
    },
  });
  pacer.enqueue({ id: 'v0', bytes: 10, prebuffer: true, track: 'video' });
  pacer.enqueue({ id: 'a0', bytes: 10, prebuffer: true, track: 'audio' });
  pacer.enqueue({ id: 'v1', bytes: 10, prebuffer: false, track: 'video' });
  pacer.enqueue({ id: 'a1', bytes: 10, prebuffer: false, track: 'audio' });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(written, [
    { id: 'v0', track: 'video', prebuffer: true },
    { id: 'a0', track: 'audio', prebuffer: true },
    { id: 'v1', track: 'video', prebuffer: false },
    { id: 'a1', track: 'audio', prebuffer: false },
  ]);
});

test('token bucket honors the initial burst and deterministic refill rate', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const written: string[] = [];
  const pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000,
    burstBytes: 100,
    maxQueuedBytes: 1_000,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    getBytes: item => item.bytes,
    write: item => {
      written.push(item.id);
    },
  });
  pacer.enqueue({ id: 'first', bytes: 60, prebuffer: true });
  pacer.enqueue({ id: 'second', bytes: 60, prebuffer: true });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(written, ['first', 'second']);
  assert.equal(sleeps.length, 1);
  assert.ok(Math.abs(sleeps[0] - 20) < 0.0001);
});

test('per-item rate changes only the selected replay records', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const pacer = new ReplayPacer<Item & { rate?: number }>({
    bytesPerSecond: 1_000,
    burstBytes: 100,
    maxQueuedBytes: 1_000,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    getBytes: item => item.bytes,
    getBytesPerSecond: item => item.rate,
    write: () => { },
  });
  pacer.enqueue({ id: 'primer', bytes: 100, prebuffer: true });
  pacer.enqueue({ id: 'bootstrap', bytes: 100, prebuffer: true, rate: 2_000 });
  pacer.enqueue({ id: 'tail', bytes: 100, prebuffer: true });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(sleeps, [50, 100]);
});

test('an indivisible record larger than the burst is written whole and charges token debt', async () => {
  let now = 0;
  const sleeps: number[] = [];
  const written: string[] = [];
  const pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000,
    burstBytes: 100,
    maxQueuedBytes: 1_000,
    now: () => now,
    sleep: async milliseconds => {
      sleeps.push(milliseconds);
      now += milliseconds;
    },
    getBytes: item => item.bytes,
    write: item => {
      written.push(item.id);
    },
  });
  pacer.enqueue({ id: 'large', bytes: 150, prebuffer: true });
  pacer.enqueue({ id: 'following', bytes: 10, prebuffer: false });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(written, ['large', 'following']);
  assert.deepEqual(sleeps, [60]);
});

test('per-item burst keeps bootstrap to one MTU without inheriting tail credit', async () => {
  let now = 0;
  const writes: { id: string; at: number }[] = [];
  const pacer = new ReplayPacer<Item & { burst: number }>({
    bytesPerSecond: MAX_REPLAY_BYTES_PER_SECOND,
    burstBytes: DEFAULT_REPLAY_BURST_BYTES,
    maxQueuedBytes: 100_000,
    now: () => now,
    sleep: async milliseconds => {
      now += Math.max(1, Math.ceil(milliseconds));
    },
    getBytes: item => item.bytes,
    getBurstBytes: item => item.burst,
    write: item => {
      writes.push({ id: item.id, at: now });
    },
  });
  for (let i = 0; i < 4; i++)
    pacer.enqueue({ id: `critical-${i}`, bytes: 1216, prebuffer: true, burst: 1500 });
  for (let i = 0; i < 4; i++)
    pacer.enqueue({ id: `tail-${i}`, bytes: 1216, prebuffer: true, burst: DEFAULT_REPLAY_BURST_BYTES });
  pacer.start();
  await pacer.waitForIdle();

  assert.deepEqual(writes.map(write => write.at), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test('one-MTU branch overtakes sustained 4 Mbit ingress within a bounded transition', async () => {
  let now = 0;
  let liveSequence = 0;
  let caughtUpAt: number;
  let pacer: ReplayPacer<Item & { burst: number }>;
  pacer = new ReplayPacer<Item & { burst: number }>({
    bytesPerSecond: ONE_MTU_REPLAY_BYTES_PER_SECOND,
    burstBytes: ONE_MTU_REPLAY_BURST_BYTES,
    maxQueuedBytes: 10_000_000,
    now: () => now,
    sleep: async milliseconds => {
      const elapsed = Math.max(1, Math.ceil(milliseconds));
      for (let i = 0; i < elapsed; i++) {
        now++;
        pacer.enqueue({ id: `live-${liveSequence++}`, bytes: 500, prebuffer: false, burst: ONE_MTU_REPLAY_BURST_BYTES });
      }
    },
    getBytes: item => item.bytes,
    getBurstBytes: item => item.burst,
    write: () => {},
    onCaughtUp: () => caughtUpAt = now,
  });
  // Four seconds of 4 Mbit/s source backlog.
  for (let i = 0; i < 2000; i++)
    pacer.enqueue({ id: `replay-${i}`, bytes: 1000, prebuffer: true, burst: ONE_MTU_REPLAY_BURST_BYTES });
  pacer.start();
  await pacer.waitForIdle();

  assert.ok(caughtUpAt >= 7_000 && caughtUpAt <= 9_000, `pacer caught up at ${caughtUpAt}ms`);
  assert.equal(pacer.bytesQueued, 0);
});

test('two-MTU tail catches sustained 10.7 Mbit ingress with 1ms timer quantization', async () => {
  let now = 0;
  let liveSequence = 0;
  let caughtUpAt: number;
  let pacer: ReplayPacer<Item & { burst: number }>;
  pacer = new ReplayPacer<Item & { burst: number }>({
    bytesPerSecond: MAX_REPLAY_BYTES_PER_SECOND,
    burstBytes: DEFAULT_REPLAY_BURST_BYTES,
    maxQueuedBytes: 1_000_000,
    now: () => now,
    sleep: async milliseconds => {
      const elapsed = Math.max(1, Math.ceil(milliseconds));
      for (let i = 0; i < elapsed; i++) {
        now++;
        pacer.enqueue({ id: `live-${liveSequence++}`, bytes: 1216, prebuffer: false, burst: DEFAULT_REPLAY_BURST_BYTES });
        if (now % 10 === 0)
          pacer.enqueue({ id: `live-${liveSequence++}`, bytes: 1216, prebuffer: false, burst: DEFAULT_REPLAY_BURST_BYTES });
      }
    },
    getBytes: item => item.bytes,
    getBurstBytes: item => item.burst,
    write: () => {},
    onCaughtUp: () => caughtUpAt = now,
  });
  for (let i = 0; i < 20; i++)
    pacer.enqueue({ id: `critical-${i}`, bytes: 1216, prebuffer: true, burst: 1500 });
  for (let i = 0; i < 180; i++)
    pacer.enqueue({ id: `replay-${i}`, bytes: 1216, prebuffer: true, burst: DEFAULT_REPLAY_BURST_BYTES });
  pacer.start();
  await pacer.waitForIdle();

  assert.ok(caughtUpAt <= 2000, `pacer caught up at ${caughtUpAt}ms`);
  assert.equal(pacer.bytesQueued, 0);
  assert.ok(liveSequence > 0);
});

test('a backpressured write holds all following replay and live items', async () => {
  let release: () => void;
  const blocked = new Promise<void>(resolve => release = resolve);
  const written: string[] = [];
  const pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000_000,
    burstBytes: 1_000,
    maxQueuedBytes: 10_000,
    getBytes: item => item.bytes,
    write: item => {
      written.push(item.id);
      if (item.id === 'replay-1')
        return blocked;
    },
  });
  pacer.enqueue({ id: 'replay-1', bytes: 10, prebuffer: true });
  pacer.enqueue({ id: 'replay-2', bytes: 10, prebuffer: true });
  pacer.start();
  await flushMicrotasks();
  pacer.enqueue({ id: 'live-1', bytes: 10, prebuffer: false });
  assert.deepEqual(written, ['replay-1']);

  release();
  await pacer.waitForIdle();
  assert.deepEqual(written, ['replay-1', 'replay-2', 'live-1']);
});

test('close while rate-limited releases the queue without another write', async () => {
  let releaseSleep: () => void;
  const sleeping = new Promise<void>(resolve => releaseSleep = resolve);
  const written: string[] = [];
  const pacer = new ReplayPacer<Item>({
    bytesPerSecond: 1_000,
    burstBytes: 10,
    maxQueuedBytes: 1_000,
    getBytes: item => item.bytes,
    sleep: () => sleeping,
    write: item => {
      written.push(item.id);
    },
  });
  pacer.enqueue({ id: 'first', bytes: 10, prebuffer: true });
  pacer.enqueue({ id: 'second', bytes: 10, prebuffer: true });
  pacer.start();
  await flushMicrotasks();
  assert.deepEqual(written, ['first']);

  pacer.close();
  releaseSleep();
  await pacer.waitForIdle();
  assert.deepEqual(written, ['first']);
  assert.equal(pacer.bytesQueued, 0);
});
