import assert from 'node:assert/strict';
import test from 'node:test';
import {
    CameraSnapshotCache,
    compactSnapshotError,
    getCompleteJpegDimensions,
    HOMEKIT_SNAPSHOT_COLD_WAIT_MS,
} from '../src/types/camera/camera-snapshot-cache';

function makeJpeg(width: number, height: number, tag = 0x11) {
    const app0 = Buffer.from([
        0xff, 0xe0, 0x00, 0x10,
        0x4a, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    ]);
    const sof0 = Buffer.from([
        0xff, 0xc0, 0x00, 0x11, 0x08,
        height >>> 8, height & 0xff,
        width >>> 8, width & 0xff,
        0x03,
        0x01, 0x11, 0x00,
        0x02, 0x11, 0x00,
        0x03, 0x11, 0x00,
    ]);
    const scan = Buffer.from([
        0xff, 0xda, 0x00, 0x0c, 0x03,
        0x01, 0x00,
        0x02, 0x00,
        0x03, 0x00,
        0x00, 0x3f, 0x00,
    ]);
    return Buffer.concat([
        Buffer.from([0xff, 0xd8]),
        app0,
        sof0,
        scan,
        Buffer.alloc(220, tag),
        Buffer.from([0xff, 0xd9]),
    ]);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return {
        promise,
        resolve,
        reject,
    };
}

function tick() {
    return new Promise<void>(resolve => setImmediate(resolve));
}

test('JPEG validation requires a complete envelope and reports exact dimensions', () => {
    assert.equal(HOMEKIT_SNAPSHOT_COLD_WAIT_MS, 4_500);

    const jpeg = makeJpeg(640, 360);
    assert.deepEqual(getCompleteJpegDimensions(jpeg), {
        width: 640,
        height: 360,
    });
    assert.equal(getCompleteJpegDimensions(jpeg.subarray(0, jpeg.length - 2)), undefined);
    assert.equal(getCompleteJpegDimensions(Buffer.alloc(512)), undefined);

    const compact = compactSnapshotError(new Error('failed https://user:pass@example.test/frame?token=secret\nnext'));
    assert.equal(compact, 'Error: failed [url] next');
    assert.equal(
        compactSnapshotError(new Error('request failed\nAuthorization: Bearer secret-token\nnext')),
        'Error: request failed Authorization: [redacted] next',
    );
});

test('periodic requests are single-flight and cached per exact size', async () => {
    const first = deferred<Buffer>();
    let captures = 0;
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        return first.promise;
    });
    const request = {
        width: 640,
        height: 360,
    };

    const one = cache.getPeriodic(request);
    const two = cache.getPeriodic({ ...request });
    assert.equal(captures, 1);

    const jpeg = makeJpeg(640, 360);
    first.resolve(jpeg);
    assert.equal(await one, jpeg);
    assert.equal(await two, jpeg);
    assert.equal(await cache.getPeriodic(request), jpeg);
    assert.equal(captures, 1);
});

test('different snapshot sizes never share an in-flight result', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<Buffer>>>();
    let captures = 0;
    const cache = new CameraSnapshotCache(async request => {
        captures++;
        const key = `${request.width}x${request.height}`;
        const capture = deferred<Buffer>();
        pending.set(key, capture);
        return capture.promise;
    });

    const small = cache.getPeriodic({ width: 320, height: 180 });
    const large = cache.getPeriodic({ width: 1280, height: 720 });
    assert.equal(captures, 2);

    const smallJpeg = makeJpeg(320, 180);
    const largeJpeg = makeJpeg(1280, 720);
    pending.get('320x180')!.resolve(smallJpeg);
    pending.get('1280x720')!.resolve(largeJpeg);
    assert.equal(await small, smallJpeg);
    assert.equal(await large, largeJpeg);
});

test('a stale periodic snapshot returns quickly while one refresh updates the cache', async () => {
    let now = 0;
    const refresh = deferred<Buffer>();
    let captures = 0;
    const diagnostics: string[] = [];
    const initial = makeJpeg(640, 360, 0x21);
    const updated = makeJpeg(640, 360, 0x22);
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        if (captures === 1)
            return initial;
        return refresh.promise;
    }, {
        now: () => now,
        freshTtlMs: 50,
        staleWaitMs: 15,
        diagnostic: message => diagnostics.push(message),
    });

    assert.equal(await cache.getPeriodic({ width: 640, height: 360 }), initial);
    now = 100;

    const started = Date.now();
    assert.equal(await cache.getPeriodic({ width: 640, height: 360 }), initial);
    assert.ok(Date.now() - started < 100);
    assert.equal(captures, 2);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /^HomeKit snapshot stale fallback size=640x360 ageMs=100 waitMs=15 bytes=\d+ hash=[a-f0-9]{8} cause=refresh-pending$/);

    refresh.resolve(updated);
    await tick();
    assert.equal(await cache.getPeriodic({ width: 640, height: 360 }), updated);
    assert.equal(captures, 2);
});

test('a failed periodic refresh falls back to stale and emits compact diagnostics', async () => {
    let now = 0;
    let captures = 0;
    const diagnostics: string[] = [];
    const initial = makeJpeg(320, 180);
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        if (captures === 1)
            return initial;
        throw new Error('camera failed https://camera.test/snapshot?token=secret\nstack');
    }, {
        now: () => now,
        freshTtlMs: 50,
        diagnostic: message => diagnostics.push(message),
    });

    assert.equal(await cache.getPeriodic({ width: 320, height: 180 }), initial);
    now = 100;
    assert.equal(await cache.getPeriodic({ width: 320, height: 180 }), initial);
    assert.equal(diagnostics.length, 1);
    assert.match(diagnostics[0], /^HomeKit snapshot stale fallback size=320x180 ageMs=100 waitMs=350 bytes=\d+ hash=[a-f0-9]{8}/);
    assert.match(diagnostics[0], /cause=Error: camera failed \[url\] stack$/);
});

test('a cold periodic request has a bounded wait and a late capture warms the cache', async () => {
    const capture = deferred<Buffer>();
    let captures = 0;
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        return capture.promise;
    }, {
        coldWaitMs: 15,
    });
    const request = {
        width: 640,
        height: 360,
    };

    await assert.rejects(cache.getPeriodic(request), /snapshot timed out size=640x360 after=15ms/);
    assert.equal(captures, 1);

    const jpeg = makeJpeg(640, 360);
    capture.resolve(jpeg);
    await tick();
    assert.equal(await cache.getPeriodic(request), jpeg);
    assert.equal(captures, 1);
});

test('fresh requests never return stale, are single-flight, and update periodic cache', async () => {
    let now = 0;
    let captures = 0;
    const stale = makeJpeg(640, 360, 0x31);
    const fresh = makeJpeg(640, 360, 0x32);
    const eventCapture = deferred<Buffer>();
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        if (captures === 1)
            return stale;
        if (captures === 2)
            throw new Error('event capture failed');
        return eventCapture.promise;
    }, {
        now: () => now,
        freshTtlMs: 50,
    });
    const request = {
        width: 640,
        height: 360,
    };

    assert.equal(await cache.getPeriodic(request), stale);
    now = 100;
    await assert.rejects(cache.getFresh(request), /event capture failed/);

    const eventOne = cache.getFresh(request);
    const eventTwo = cache.getFresh({ ...request });
    assert.equal(captures, 3);
    eventCapture.resolve(fresh);
    assert.equal(await eventOne, fresh);
    assert.equal(await eventTwo, fresh);
    assert.equal(await cache.getPeriodic(request), fresh);
    assert.equal(captures, 3);
});

test('fresh requests have a bounded wait and a late result can still warm the cache', async () => {
    const capture = deferred<Buffer>();
    let captures = 0;
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        return capture.promise;
    }, {
        freshWaitMs: 15,
    });
    const request = {
        width: 640,
        height: 360,
    };

    await assert.rejects(cache.getFresh(request), /snapshot timed out size=640x360 after=15ms/);
    assert.equal(captures, 1);

    const jpeg = makeJpeg(640, 360);
    capture.resolve(jpeg);
    await tick();
    assert.equal(await cache.getPeriodic(request), jpeg);
    assert.equal(captures, 1);
});

test('an older periodic refresh cannot overwrite a newer event snapshot', async () => {
    let now = 0;
    let captures = 0;
    const periodicRefresh = deferred<Buffer>();
    const initial = makeJpeg(640, 360, 0x41);
    const olderPeriodic = makeJpeg(640, 360, 0x42);
    const event = makeJpeg(640, 360, 0x43);
    const cache = new CameraSnapshotCache(async () => {
        captures++;
        if (captures === 1)
            return initial;
        if (captures === 2)
            return periodicRefresh.promise;
        return event;
    }, {
        now: () => now,
        freshTtlMs: 50,
        staleWaitMs: 10,
    });
    const request = {
        width: 640,
        height: 360,
    };

    assert.equal(await cache.getPeriodic(request), initial);
    now = 100;
    assert.equal(await cache.getPeriodic(request), initial);
    assert.equal(await cache.getFresh(request), event);

    periodicRefresh.resolve(olderPeriodic);
    await tick();
    assert.equal(await cache.getPeriodic(request), event);
    assert.equal(captures, 3);
});

test('a complete wrong-size JPEG is delivered on a cold request but never cached', async () => {
    let captures = 0;
    const wrongSize = makeJpeg(320, 180);
    const exactSize = makeJpeg(640, 360);
    const responses = [
        wrongSize,
        exactSize,
    ];
    const cache = new CameraSnapshotCache(async () => responses[captures++], {
        coldWaitMs: 50,
    });
    const request = {
        width: 640,
        height: 360,
    };

    assert.equal(await cache.getPeriodic(request), wrongSize);
    assert.equal(await cache.getPeriodic(request), exactSize);
    assert.equal(await cache.getPeriodic(request), exactSize);
    assert.equal(captures, 2);
});

test('wrong-size refreshes never replace an exact cached entry', async () => {
    let now = 0;
    let captures = 0;
    const diagnostics: string[] = [];
    const exactSize = makeJpeg(640, 360, 0x51);
    const wrongPeriodic = makeJpeg(320, 180, 0x52);
    const wrongFresh = makeJpeg(320, 180, 0x53);
    const updated = makeJpeg(640, 360, 0x54);
    const responses = [
        exactSize,
        wrongPeriodic,
        wrongFresh,
        updated,
    ];
    const cache = new CameraSnapshotCache(async () => responses[captures++], {
        now: () => now,
        freshTtlMs: 50,
        staleWaitMs: 50,
        diagnostic: message => diagnostics.push(message),
    });
    const request = {
        width: 640,
        height: 360,
    };

    assert.equal(await cache.getPeriodic(request), exactSize);
    now = 100;
    assert.equal(await cache.getPeriodic(request), exactSize);
    assert.match(diagnostics[0], /cause=wrong-dimensions-actual=320x180$/);

    assert.equal(await cache.getFresh(request), wrongFresh);
    assert.equal(await cache.getPeriodic(request), updated);
    assert.equal(await cache.getPeriodic(request), updated);
    assert.equal(captures, 4);
});

test('incomplete JPEGs are rejected and never cached', async () => {
    let captures = 0;
    const exactSize = makeJpeg(640, 360);
    const responses = [
        Buffer.alloc(512),
        exactSize,
    ];
    const cache = new CameraSnapshotCache(async () => responses[captures++], {
        coldWaitMs: 50,
    });
    const request = {
        width: 640,
        height: 360,
    };

    await assert.rejects(cache.getPeriodic(request), /incomplete JPEG size=640x360/);
    assert.equal(await cache.getPeriodic(request), exactSize);
    assert.equal(await cache.getPeriodic(request), exactSize);
    assert.equal(captures, 2);
});

test('the last-good age bound and LRU limit evict old exact-size entries', async () => {
    let now = 0;
    let captures = 0;
    const cache = new CameraSnapshotCache(async request => {
        captures++;
        return makeJpeg(request.width, request.height, captures);
    }, {
        now: () => now,
        freshTtlMs: 1_000,
        maxAgeMs: 100,
        maxEntries: 2,
    });

    await cache.getPeriodic({ width: 100, height: 100 });
    now = 1;
    await cache.getPeriodic({ width: 200, height: 100 });
    now = 2;
    await cache.getPeriodic({ width: 100, height: 100 });
    await cache.getPeriodic({ width: 300, height: 100 });
    assert.equal(captures, 3);

    await cache.getPeriodic({ width: 200, height: 100 });
    assert.equal(captures, 4);

    now = 200;
    await cache.getPeriodic({ width: 300, height: 100 });
    assert.equal(captures, 5);
});
