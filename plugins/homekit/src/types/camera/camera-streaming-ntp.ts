const NTP_UNIX_EPOCH_SECONDS = 2_208_988_800;
const NTP_FRACTION_SCALE = 0x1_0000_0000;

/**
 * Convert Unix wall time in milliseconds to the unsigned 64-bit NTP timestamp
 * used by RTCP Sender Reports (RFC 3550 section 4).
 *
 * The upper word is whole seconds since 1900-01-01. The lower word is a binary
 * fraction of a second, not the decimal digits that appear after a JavaScript
 * number's decimal point.
 */
export function unixMillisecondsToNtpTime(unixMilliseconds: number): bigint {
    if (!Number.isFinite(unixMilliseconds))
        throw new Error('NTP wall time must be finite.');

    const unixSeconds = Math.floor(unixMilliseconds / 1000);
    const fractionalMilliseconds = unixMilliseconds - unixSeconds * 1000;
    const ntpSeconds = unixSeconds + NTP_UNIX_EPOCH_SECONDS;
    const fraction = Math.max(0, Math.min(
        NTP_FRACTION_SCALE - 1,
        Math.floor(fractionalMilliseconds * NTP_FRACTION_SCALE / 1000),
    ));

    return (BigInt(ntpSeconds) << 32n) | BigInt(fraction);
}

/**
 * Use the monotonic performance clock anchored to its Unix time origin. This
 * avoids Date.now() adjustments inside a stream while retaining true wall time
 * for RTP-to-NTP synchronization.
 */
export function ntpTime() {
    return unixMillisecondsToNtpTime(performance.timeOrigin + performance.now());
}
