import assert from 'node:assert/strict';
import test from 'node:test';
import { unixMillisecondsToNtpTime } from '../src/types/camera/camera-streaming-ntp';

const NTP_UNIX_EPOCH_SECONDS = 2_208_988_800n;
const NTP_FRACTION_SCALE = 0x1_0000_0000n;

function decodeMilliseconds(value: bigint) {
    const seconds = value >> 32n;
    const fraction = value & 0xffff_ffffn;
    return Number(seconds - NTP_UNIX_EPOCH_SECONDS) * 1000
        + Number(fraction) * 1000 / Number(NTP_FRACTION_SCALE);
}

test('NTP conversion uses binary fractional seconds', () => {
    assert.equal(
        unixMillisecondsToNtpTime(0),
        NTP_UNIX_EPOCH_SECONDS << 32n,
    );
    assert.equal(
        unixMillisecondsToNtpTime(250),
        (NTP_UNIX_EPOCH_SECONDS << 32n) | 0x4000_0000n,
    );
    assert.equal(
        unixMillisecondsToNtpTime(500),
        (NTP_UNIX_EPOCH_SECONDS << 32n) | 0x8000_0000n,
    );
});

test('NTP timestamps stay monotonic across decimal and second boundaries', () => {
    const samples = [
        1_784_210_147_001,
        1_784_210_147_568.805,
        1_784_210_147_770.238,
        1_784_210_147_999.999,
        1_784_210_148_000,
        1_784_210_148_200,
    ].map(unixMillisecondsToNtpTime);

    for (let i = 1; i < samples.length; i++)
        assert.ok(samples[i] > samples[i - 1], `sample ${i} moved backward`);
});

test('NTP elapsed time matches wall elapsed time within one fractional tick', () => {
    const startMs = 1_784_210_147_568.805;
    const endMs = startMs + 200;
    const start = unixMillisecondsToNtpTime(startMs);
    const end = unixMillisecondsToNtpTime(endMs);

    assert.ok(Math.abs((decodeMilliseconds(end) - decodeMilliseconds(start)) - 200) < 0.001);
});
