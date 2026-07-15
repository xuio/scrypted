import assert from 'node:assert/strict';
import test from 'node:test';
import { BOOTSTRAP_REPLAY_BURST_BYTES, ReplayBootstrapTracker } from '../src/replay-bootstrap';
import { DEFAULT_REPLAY_BURST_BYTES } from '../src/replay-pacer';

function rtp(type: 'h264' | 'h265' | 'aac' | 'rtcp-h264', payload: number[], marker = false, timestamp = 100, ssrc = 200) {
  const packet = Buffer.alloc(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = marker ? 0x80 : 0;
  packet.writeUInt32BE(timestamp, 4);
  packet.writeUInt32BE(ssrc, 8);
  Buffer.from(payload).copy(packet, 12);
  return { type, chunks: [Buffer.from([0x24, 0, 0, packet.length]), packet] };
}

function bursts(chunks: ReturnType<typeof rtp>[]) {
  const tracker = new ReplayBootstrapTracker();
  return chunks.map(chunk => tracker.nextBurstBytes(chunk, DEFAULT_REPLAY_BURST_BYTES));
}

test('H264 bootstrap stays critical through the fragmented IDR marker', () => {
  const chunks = [
    rtp('h264', [0x67]),
    rtp('aac', [1, 2], true),
    rtp('h264', [0x7c, 0x85]),
    rtp('h264', [0x7c, 0x05]),
    rtp('h264', [0x7c, 0x45], true),
    rtp('h264', [0x41], true),
  ];
  assert.deepEqual(bursts(chunks), [1500, 1500, 1500, 1500, 1500, 3000]);
});

test('single-packet H265 IDR marker ends the critical prefix', () => {
  const chunks = [
    rtp('h265', [32 << 1, 1]),
    rtp('h265', [19 << 1, 1], true),
    rtp('h265', [1 << 1, 1], true),
  ];
  assert.deepEqual(bursts(chunks), [1500, 1500, 3000]);
});

test('missing IDR marker conservatively protects the complete replay', () => {
  const chunks = [
    rtp('h264', [0x67]),
    rtp('h264', [0x7c, 0x85]),
    rtp('h264', [0x7c, 0x05]),
  ];
  assert.deepEqual(bursts(chunks), chunks.map(() => BOOTSTRAP_REPLAY_BURST_BYTES));
});

test('audio, RTCP, and a different video timestamp cannot end the protected IDR', () => {
  const chunks = [
    rtp('h264', [0x7c, 0x85], false, 100, 200),
    rtp('aac', [1, 2], true, 100, 300),
    rtp('rtcp-h264', [1, 2], true, 100, 200),
    rtp('h264', [0x41], true, 101, 200),
    rtp('h264', [0x7c, 0x45], true, 100, 200),
    rtp('h264', [0x41], true, 101, 200),
  ];
  assert.deepEqual(bursts(chunks), [1500, 1500, 1500, 1500, 1500, 3000]);
});

test('tracker keeps an IDR protected when its marker crosses replay into live ingress', () => {
  const tracker = new ReplayBootstrapTracker();
  const replay = [
    rtp('h264', [0x67]),
    rtp('h264', [0x7c, 0x85], false, 100, 200),
    rtp('h264', [0x7c, 0x05], false, 100, 200),
  ];
  const live = [
    rtp('h264', [0x7c, 0x45], true, 100, 200),
    rtp('h264', [0x41], true, 101, 200),
  ];
  assert.deepEqual(
    [...replay, ...live].map(chunk => tracker.nextBurstBytes(chunk, DEFAULT_REPLAY_BURST_BYTES)),
    [1500, 1500, 1500, 1500, 3000],
  );
});

test('later SPS/PPS and IDRs re-enter critical pacing while catch-up is active', () => {
  const chunks = [
    rtp('h264', [0x65], true, 100, 200),
    rtp('h264', [0x41], true, 101, 200),
    rtp('h264', [0x67], false, 200, 200),
    rtp('h264', [0x68], false, 200, 200),
    rtp('h264', [0x7c, 0x85], false, 200, 200),
    rtp('h264', [0x7c, 0x05], false, 200, 200),
    rtp('h264', [0x7c, 0x45], true, 200, 200),
    rtp('h264', [0x41], true, 201, 200),
  ];
  assert.deepEqual(bursts(chunks), [1500, 3000, 1500, 1500, 1500, 1500, 1500, 3000]);
});

test('audio and RTCP retain the one-MTU budget after video leaves bootstrap', () => {
  const chunks = [
    rtp('h264', [0x65], true, 100, 200),
    rtp('h264', [0x41], true, 101, 200),
    rtp('aac', [1, 2], true, 102, 300),
    rtp('rtcp-h264', [1, 2], true, 103, 200),
    rtp('h264', [0x41], true, 104, 200),
  ];
  assert.deepEqual(bursts(chunks), [1500, 3000, 1500, 1500, 3000]);
});
