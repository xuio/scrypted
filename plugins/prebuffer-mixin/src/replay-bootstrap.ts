import type { StreamChunk } from '@scrypted/common/src/stream-parser';
import { ONE_MTU_REPLAY_BURST_BYTES } from './replay-pacer';

/** One RTP record per timer turn while codec state and the first IDR are sent. */
export const BOOTSTRAP_REPLAY_BURST_BYTES = ONE_MTU_REPLAY_BURST_BYTES;

/**
 * Implicit live views intentionally omit cached audio and RTCP. Remove those
 * records before pacing so packets that will never be written consume neither
 * queue space nor token-bucket credit. Explicit pre-roll passes no codec and
 * retains the original byte-for-byte behavior.
 */
export function filterPrebufferReplayChunks<T extends Pick<StreamChunk, 'type'>>(chunks: T[], implicitVideoOnlyCodec?: string) {
  if (implicitVideoOnlyCodec === undefined)
    return chunks;
  return chunks.filter(chunk => chunk.type === implicitVideoOnlyCodec);
}

/**
 * During an implicit live-view bootstrap, cached audio is intentionally
 * omitted. Forward the exact selected live audio RTP immediately rather than
 * queuing it behind the cached video replay. Exact matching keeps RTCP and
 * unknown records in the replay FIFO; explicit pre-roll passes no codec.
 */
export function shouldBypassReplayForLiveAudio(options: {
  chunkType: string;
  implicitLiveAudioCodec?: string;
  replayRecordWritten: boolean;
  writableNeedDrain: boolean;
}) {
  return options.implicitLiveAudioCodec !== undefined
    && options.chunkType === options.implicitLiveAudioCodec
    && options.replayRecordWritten
    && !options.writableNeedDrain;
}

function isVideoReplayChunk(chunk: StreamChunk) {
  return chunk.type === 'h264' || chunk.type === 'h265';
}

function h264PayloadStartsIdr(payload: Buffer) {
  const naluType = payload[0] & 0x1f;
  if (naluType === 5)
    return true;
  if (naluType === 28)
    return payload.length >= 2 && !!(payload[1] & 0x80) && (payload[1] & 0x1f) === 5;
  if (naluType !== 24)
    return false;
  for (let offset = 1; offset + 2 <= payload.length;) {
    const length = payload.readUInt16BE(offset);
    offset += 2;
    if (!length || offset + length > payload.length)
      return false;
    if ((payload[offset] & 0x1f) === 5)
      return true;
    offset += length;
  }
  return false;
}

function h264PayloadStartsCodecInfo(payload: Buffer) {
  const naluType = payload[0] & 0x1f;
  if (naluType === 7 || naluType === 8)
    return true;
  if (naluType === 28)
    return payload.length >= 2
      && !!(payload[1] & 0x80)
      && ((payload[1] & 0x1f) === 7 || (payload[1] & 0x1f) === 8);
  if (naluType !== 24)
    return false;
  for (let offset = 1; offset + 2 <= payload.length;) {
    const length = payload.readUInt16BE(offset);
    offset += 2;
    if (!length || offset + length > payload.length)
      return false;
    const stapType = payload[offset] & 0x1f;
    if (stapType === 7 || stapType === 8)
      return true;
    offset += length;
  }
  return false;
}

function isH265KeyframeType(naluType: number) {
  return naluType >= 16 && naluType <= 21;
}

function h265PayloadStartsKeyframe(payload: Buffer) {
  if (payload.length < 2)
    return false;
  const naluType = (payload[0] & 0x7e) >> 1;
  if (isH265KeyframeType(naluType))
    return true;
  if (naluType === 49)
    return payload.length >= 3 && !!(payload[2] & 0x80) && isH265KeyframeType(payload[2] & 0x3f);
  if (naluType !== 48)
    return false;
  for (let offset = 2; offset + 2 <= payload.length;) {
    const length = payload.readUInt16BE(offset);
    offset += 2;
    if (length < 2 || offset + length > payload.length)
      return false;
    if (isH265KeyframeType((payload[offset] & 0x7e) >> 1))
      return true;
    offset += length;
  }
  return false;
}

function h265PayloadStartsCodecInfo(payload: Buffer) {
  if (payload.length < 2)
    return false;
  const naluType = (payload[0] & 0x7e) >> 1;
  if (naluType >= 32 && naluType <= 34)
    return true;
  if (naluType === 49)
    return payload.length >= 3
      && !!(payload[2] & 0x80)
      && (payload[2] & 0x3f) >= 32
      && (payload[2] & 0x3f) <= 34;
  if (naluType !== 48)
    return false;
  for (let offset = 2; offset + 2 <= payload.length;) {
    const length = payload.readUInt16BE(offset);
    offset += 2;
    if (length < 2 || offset + length > payload.length)
      return false;
    const aggregatedType = (payload[offset] & 0x7e) >> 1;
    if (aggregatedType >= 32 && aggregatedType <= 34)
      return true;
    offset += length;
  }
  return false;
}

type ParsedRtp = {
  marker: boolean;
  payload: Buffer;
  ssrc: number;
  timestamp: number;
};

function parseRtp(chunk: StreamChunk): ParsedRtp | undefined {
  const packet = chunk.chunks[chunk.chunks.length - 1];
  if (!packet || packet.length <= 12 || (packet[0] & 0xc0) !== 0x80)
    return;
  const csrcBytes = (packet[0] & 0x0f) * 4;
  const extensionBytes = packet[0] & 0x10 && packet.length >= 16 + csrcBytes
    ? 4 + packet.readUInt16BE(14 + csrcBytes) * 4
    : 0;
  const payloadOffset = 12 + csrcBytes + extensionBytes;
  if (payloadOffset >= packet.length)
    return;
  return {
    marker: !!(packet[1] & 0x80),
    payload: packet.subarray(payloadOffset),
    ssrc: packet.readUInt32BE(8),
    timestamp: packet.readUInt32BE(4),
  };
}

function isKeyframeStart(chunk: StreamChunk, rtp: ParsedRtp) {
  if (chunk.type === 'h264')
    return h264PayloadStartsIdr(rtp.payload);
  if (chunk.type === 'h265')
    return h265PayloadStartsKeyframe(rtp.payload);
  return false;
}

function isCodecInfoStart(chunk: StreamChunk, rtp: ParsedRtp) {
  if (chunk.type === 'h264')
    return h264PayloadStartsCodecInfo(rtp.payload);
  if (chunk.type === 'h265')
    return h265PayloadStartsCodecInfo(rtp.payload);
  return false;
}

/**
 * Per-client phase tracker for decoder bootstrap dependencies. Selection
 * normally begins at SPS/PPS or an IDR start. Keep the strict one-MTU byte
 * budget through the marker on that exact video access unit, even when the
 * replay snapshot ends mid-IDR and its remaining fragments arrive live.
 */
export class ReplayBootstrapTracker {
  private critical = true;
  private keyframe: { type: string; ssrc: number; timestamp: number } | undefined;

  nextPacing(chunk: StreamChunk, tailBurstBytes: number) {
    // Audio and RTCP are small and low-rate. Keeping them on the one-MTU budget
    // avoids coupling an AAC packet to a simultaneous accelerated video write.
    if (!isVideoReplayChunk(chunk))
      return {
        burstBytes: BOOTSTRAP_REPLAY_BURST_BYTES,
        decoderBootstrap: false,
      };
    const rtp = parseRtp(chunk);
    if (!rtp)
      return {
        burstBytes: this.critical ? BOOTSTRAP_REPLAY_BURST_BYTES : tailBurstBytes,
        decoderBootstrap: this.critical,
      };
    if (isCodecInfoStart(chunk, rtp))
      this.critical = true;
    if (isKeyframeStart(chunk, rtp)) {
      this.critical = true;
      this.keyframe = {
        type: chunk.type,
        ssrc: rtp.ssrc,
        timestamp: rtp.timestamp,
      };
    }
    if (!this.critical)
      return {
        burstBytes: tailBurstBytes,
        decoderBootstrap: false,
      };

    const burstBytes = BOOTSTRAP_REPLAY_BURST_BYTES;
    if (this.keyframe
      && chunk.type === this.keyframe.type
      && rtp.ssrc === this.keyframe.ssrc
      && rtp.timestamp === this.keyframe.timestamp
      && rtp.marker) {
      this.critical = false;
      this.keyframe = undefined;
    }
    return {
      burstBytes,
      decoderBootstrap: true,
    };
  }

  nextBurstBytes(chunk: StreamChunk, tailBurstBytes: number) {
    return this.nextPacing(chunk, tailBurstBytes).burstBytes;
  }
}
