import { performance } from 'perf_hooks';

export const REPLAY_RATE_MULTIPLIER = 10;
export const MIN_REPLAY_BYTES_PER_SECOND = 1_000_000; // 8 Mbit/s
// Above ~12 Mbit/s, localhost RTSP delivery can turn consecutive RTP records
// into a downstream UDP microburst. This ceiling still overtakes the measured
// 4 MP source while leaving the decoder-critical IDRs on the stricter budget.
export const MAX_REPLAY_BYTES_PER_SECOND = 1_500_000; // 12 Mbit/s
export const ONE_MTU_REPLAY_BURST_BYTES = 1500;
export const ONE_MTU_REPLAY_BYTES_PER_SECOND = 750_000; // 6 Mbit/s
// The ordinary catch-up tail may release at most two MTUs of credit per timer
// turn. The dependency-bearing bootstrap prefix uses the stricter one-MTU limit
// exported by replay-bootstrap.ts.
export const DEFAULT_REPLAY_BURST_BYTES = 3000;
// The smoothed one-MTU path runs at 6 Mbit/s. Keep at least 2 Mbit/s of
// catch-up headroom; faster sources need the two-MTU path.
export const MAX_ONE_MTU_SOURCE_BYTES_PER_SECOND = 500_000; // 4 Mbit/s
export const MIN_STABLE_RATE_SPAN_MS = 4000;
export const DEFAULT_REPLAY_MAX_QUEUE_BYTES = 100_000_000;
export const HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY = 'homekitReplayBootstrapBytesPerSecond';
export const HOMEKIT_REPLAY_BOOTSTRAP_BYTES_PER_SECOND = new Set([
  1_000_000, // 8 Mbit/s
  1_250_000, // 10 Mbit/s
  1_500_000, // 12 Mbit/s
]);

export function getHomeKitReplayBootstrapBytesPerSecond(options?: {
  destinationType?: string;
  metadata?: any;
}) {
  if (options?.destinationType !== '@scrypted/homekit')
    return;
  const value = options.metadata?.[HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY];
  if (HOMEKIT_REPLAY_BOOTSTRAP_BYTES_PER_SECOND.has(value))
    return value as number;
}

/**
 * Select a replay rate that drains a finite prebuffer quickly without turning it
 * into a localhost RTP microburst. At ten times the measured source rate, a
 * four-second GOP catches up promptly while live packets keep arriving. The
 * bounded per-turn burst remains the final safety limit on actual throughput.
 */
export function calculateReplayBytesPerSecond(totalBytes: number, spanMs: number) {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(spanMs) || spanMs <= 0)
    return MIN_REPLAY_BYTES_PER_SECOND;

  const averageBytesPerSecond = totalBytes * 1000 / spanMs;
  return Math.max(
    MIN_REPLAY_BYTES_PER_SECOND,
    Math.min(MAX_REPLAY_BYTES_PER_SECOND, averageBytesPerSecond * REPLAY_RATE_MULTIPLIER),
  );
}

export function calculateReplayBurstBytes(totalBytes: number, spanMs: number, stableBytes = 0, stableSpanMs = 0) {
  // A selected slice can begin with a large IDR and span only a fraction of a
  // GOP, grossly overstating the sustained stream rate. Prefer a sufficiently
  // long buffer average when available; retain the selected-slice cold fallback.
  const hasStableRate = Number.isFinite(stableBytes)
    && stableBytes > 0
    && Number.isFinite(stableSpanMs)
    && stableSpanMs >= MIN_STABLE_RATE_SPAN_MS;
  if (!hasStableRate && (!Number.isFinite(totalBytes) || totalBytes <= 0 || !Number.isFinite(spanMs) || spanMs <= 0))
    return ONE_MTU_REPLAY_BURST_BYTES;
  const sourceBytesPerSecond = hasStableRate
    ? stableBytes * 1000 / stableSpanMs
    : totalBytes * 1000 / spanMs;
  return sourceBytesPerSecond <= MAX_ONE_MTU_SOURCE_BYTES_PER_SECOND
    ? ONE_MTU_REPLAY_BURST_BYTES
    : DEFAULT_REPLAY_BURST_BYTES;
}

/** Positive explicit prebuffer requests are recording/pre-roll consumers
 * (notably HKSV). Zero is also used by live callers during a cold startup; the
 * rebroadcaster may still supply a sync-frame bootstrap and must pace it. */
export function shouldPaceReplay(requestedPrebuffer: number | undefined) {
  return requestedPrebuffer === undefined || requestedPrebuffer === 0;
}

export interface ReplayPacerOptions<T> {
  bytesPerSecond: number;
  write: (item: T) => void | Promise<void>;
  getBytes: (item: T) => number;
  getBurstBytes?: (item: T) => number;
  getBytesPerSecond?: (item: T) => number | undefined;
  burstBytes?: number;
  maxQueuedBytes?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  onCaughtUp?: () => void;
  onError?: (error: Error) => void;
}

/**
 * A per-client, bounded FIFO used only while an implicit live-view prebuffer is
 * catching up. Replay packets are queued first; packets arriving from the live
 * source are appended to the same queue, so asynchronous pacing cannot allow
 * live data to overtake cached data. The owner switches back to its normal
 * synchronous live writer after onCaughtUp.
 */
export class ReplayPacer<T> {
  private queue: { item: T; bytes: number; burstBytes: number; bytesPerSecond: number }[] = [];
  private head = 0;
  private queuedBytes = 0;
  private tokens: number;
  private lastRefill: number;
  private started = false;
  private pumping = false;
  private closed = false;
  private caughtUp = false;
  private failure: Error;
  private idleWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();

  constructor(private options: ReplayPacerOptions<T>) {
    const burstBytes = options.burstBytes ?? DEFAULT_REPLAY_BURST_BYTES;
    const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_REPLAY_MAX_QUEUE_BYTES;
    if (!(options.bytesPerSecond > 0) || !(burstBytes > 0) || !(maxQueuedBytes >= burstBytes))
      throw new Error('Invalid replay pacer limits.');
    this.tokens = burstBytes;
    this.lastRefill = this.now();
  }

  get bytesQueued() {
    return this.queuedBytes;
  }

  enqueue(item: T) {
    if (this.closed || this.caughtUp)
      return false;

    const bytes = this.options.getBytes(item);
    if (!Number.isFinite(bytes) || bytes <= 0) {
      this.fail(new Error(`Invalid replay item size: ${bytes}.`));
      return false;
    }

    const maximumBurstBytes = this.options.burstBytes ?? DEFAULT_REPLAY_BURST_BYTES;
    const burstBytes = this.options.getBurstBytes?.(item) ?? maximumBurstBytes;
    if (!Number.isFinite(burstBytes) || burstBytes <= 0 || burstBytes > maximumBurstBytes) {
      this.fail(new Error(`Invalid replay item burst: ${burstBytes}.`));
      return false;
    }

    const bytesPerSecond = this.options.getBytesPerSecond?.(item) ?? this.options.bytesPerSecond;
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
      this.fail(new Error(`Invalid replay item rate: ${bytesPerSecond}.`));
      return false;
    }

    const maxQueuedBytes = this.options.maxQueuedBytes ?? DEFAULT_REPLAY_MAX_QUEUE_BYTES;
    if (this.queuedBytes + bytes > maxQueuedBytes) {
      this.fail(new Error(`Replay queue exceeded ${maxQueuedBytes} bytes.`));
      return false;
    }

    this.queue.push({ item, bytes, burstBytes, bytesPerSecond });
    this.queuedBytes += bytes;
    if (this.started)
      this.startPump();
    return true;
  }

  /** Queue the complete replay snapshot before calling start. */
  start() {
    if (this.started || this.closed)
      return;
    this.started = true;
    this.startPump();
  }

  close() {
    if (this.closed)
      return;
    this.closed = true;
    if (!this.pumping)
      this.finish();
  }

  waitForIdle() {
    if (!this.pumping) {
      if (this.failure)
        return Promise.reject(this.failure);
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => this.idleWaiters.add({ resolve, reject }));
  }

  private now() {
    return this.options.now?.() ?? performance.now();
  }

  private sleep(milliseconds: number) {
    if (this.options.sleep)
      return this.options.sleep(milliseconds);
    return new Promise<void>(resolve => setTimeout(resolve, Math.max(1, Math.ceil(milliseconds))));
  }

  private startPump() {
    if (this.pumping || this.closed || this.caughtUp)
      return;
    this.pumping = true;
    void this.pump();
  }

  private async pump() {
    try {
      while (!this.closed && this.head < this.queue.length) {
        const queued = this.queue[this.head];
        await this.waitForBudget(queued.bytes, queued.burstBytes, queued.bytesPerSecond);
        if (this.closed)
          break;

        await this.options.write(queued.item);
        this.queuedBytes -= queued.bytes;
        this.queue[this.head] = undefined;
        this.head++;

        if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
      }

      if (!this.closed && this.head === this.queue.length) {
        this.caughtUp = true;
        this.options.onCaughtUp?.();
      }
    }
    catch (e) {
      this.fail(e instanceof Error ? e : new Error(String(e)));
    }
    finally {
      this.pumping = false;
      this.finish();
    }
  }

  private async waitForBudget(bytes: number, burstBytes: number, bytesPerSecond: number) {
    // A StreamChunk is one indivisible RTP/RTSP record. A maximum-size
    // interleaved frame can be a few bytes larger than the configured burst;
    // send that record atomically once the bucket is full, then carry the
    // excess as token debt so following records still observe the rate limit.
    const requiredTokens = Math.min(bytes, burstBytes);
    // A stricter per-item limit must also discard credit accumulated under the
    // preceding item's larger limit, otherwise the critical prefix could still
    // release multiple records in one turn.
    this.tokens = Math.min(this.tokens, burstBytes);

    while (!this.closed) {
      const now = this.now();
      const elapsed = Math.max(0, now - this.lastRefill);
      this.lastRefill = now;
      // Preserve at most one realistic record of timer overshoot. The old
      // burst-only clamp discarded every sub-millisecond remainder after
      // setTimeout rounded upward, making a nominal 6 Mbit/s one-MTU path
      // deliver only ~4.8 Mbit/s for 1216-byte RTSP records. Capping below two
      // required records retains the intended one-record critical turns while
      // carrying enough fractional credit to achieve the configured rate.
      const refillCap = Math.max(burstBytes, requiredTokens * 2 - 1);
      this.tokens = Math.min(refillCap, this.tokens + elapsed * bytesPerSecond / 1000);
      if (this.tokens >= requiredTokens) {
        this.tokens -= bytes;
        return;
      }
      await this.sleep((requiredTokens - this.tokens) * 1000 / bytesPerSecond);
    }
  }

  private fail(error: Error) {
    if (this.failure)
      return;
    this.failure = error;
    this.closed = true;
    try {
      this.options.onError?.(error);
    }
    catch {
    }
    if (!this.pumping)
      this.finish();
  }

  private finish() {
    if (this.pumping)
      return;

    this.queue = [];
    this.head = 0;
    this.queuedBytes = 0;
    for (const waiter of this.idleWaiters) {
      if (this.failure)
        waiter.reject(this.failure);
      else
        waiter.resolve();
    }
    this.idleWaiters.clear();
  }
}
