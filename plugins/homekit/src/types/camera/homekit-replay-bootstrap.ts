export const HOMEKIT_REPLAY_BOOTSTRAP_RATE_KEY = 'replayBootstrapRate';
export const HOMEKIT_REPLAY_BOOTSTRAP_METADATA_KEY = 'homekitReplayBootstrapBytesPerSecond';
export const HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE = 'Adaptive (High auto / Medium 8 Mbit/s)';
export const HOMEKIT_REPLAY_BOOTSTRAP_RATE_CHOICES = [
    'Default',
    HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE,
    '8 Mbit/s',
    '10 Mbit/s',
    '12 Mbit/s',
] as const;

const rates = new Map<string, number>([
    ['8 Mbit/s', 1_000_000],
    ['10 Mbit/s', 1_250_000],
    ['12 Mbit/s', 1_500_000],
]);

const adaptiveDestinations = new Set([
    'medium-resolution',
    'remote',
    'low-resolution',
]);

export function getHomeKitReplayBootstrapBytesPerSecond(
    value: string | undefined,
    destination?: string,
) {
    if (value === HOMEKIT_REPLAY_BOOTSTRAP_ADAPTIVE) {
        // This is the same destination selected for stream routing. Keep the
        // normal High/local automatic pacer, and use the measured gentler fixed
        // rate only when HomeKit is actually routed to a secondary stream.
        return adaptiveDestinations.has(destination) ? 1_000_000 : undefined;
    }
    return rates.get(value);
}
