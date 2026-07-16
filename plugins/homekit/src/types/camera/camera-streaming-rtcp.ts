import type { EventEmitter } from 'events';

type MessageEmitter = Pick<EventEmitter, 'once' | 'removeListener'>;

export function shouldWaitForInitialVideoRtcp(forceSlowConnection: boolean, isLowBandwidth: boolean, isStandalone: boolean) {
    return forceSlowConnection || isLowBandwidth || !isStandalone;
}

export function createInitialVideoRtcpLatch(videoReturn: MessageEmitter, stopped: Promise<unknown>) {
    return new Promise<boolean>(resolve => {
        let settled = false;

        const finish = (received: boolean) => {
            if (settled)
                return;
            settled = true;
            videoReturn.removeListener('message', onMessage);
            resolve(received);
        };
        const onMessage = () => finish(true);

        // PREPARE publishes the UDP return port before START arrives. Listen now
        // so an eager controller's first RTCP packet cannot fall into that gap.
        videoReturn.once('message', onMessage);
        stopped.then(() => finish(false), () => finish(false));
    });
}
