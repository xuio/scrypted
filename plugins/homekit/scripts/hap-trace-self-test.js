#!/usr/bin/env node
"use strict";

/** Bounded end-to-end test for collector handshake, key separation, and analysis. */

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const SCRIPT_DIRECTORY = __dirname;

function parseArgs(argv) {
    const options = { keep: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--keep") {
            options.keep = true;
            continue;
        }
        if (arg === "--run-dir") {
            options.runDir = argv[++i];
            if (!options.runDir)
                throw new Error("--run-dir requires a value");
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            process.stdout.write("Usage: node hap-trace-self-test.js [--keep] [--run-dir DIR]\n");
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }
    return options;
}

function privateMode(filePath, expected) {
    const stat = fs.lstatSync(filePath);
    assert.equal(stat.mode & 0o777, expected, `${filePath} mode`);
}

function readJsonLines(filePath) {
    return fs.readFileSync(filePath, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map(line => JSON.parse(line));
}

function waitForCollectorReady(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`collector readiness timeout: ${stderr}`)), timeoutMs);
        child.stdout.on("data", chunk => {
            stdout += chunk.toString("utf8");
            while (true) {
                const newline = stdout.indexOf("\n");
                if (newline < 0)
                    return;
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                try {
                    const message = JSON.parse(line);
                    if (message.status === "ready") {
                        clearTimeout(timer);
                        resolve(message);
                        return;
                    }
                }
                catch {
                    // Ignore progress lines.
                }
            }
        });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString("utf8");
        });
        child.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`collector exited before ready (${code}): ${stderr}`));
        });
    });
}

function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null)
        return Promise.resolve(child.exitCode);
    return new Promise((resolve, reject) => {
        const onExit = code => {
            clearTimeout(timer);
            resolve(code);
        };
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            reject(new Error("child exit timeout"));
        }, timeoutMs);
        child.once("exit", onExit);
    });
}

function sendProducerSession(control, events) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection(control.socketPath);
        let input = "";
        let sent = false;
        const timer = setTimeout(() => {
            socket.destroy();
            reject(new Error("collector handshake timeout"));
        }, 3_000);
        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({
                type: "hello",
                version: 1,
                runId: control.runId,
                token: control.token,
                pid: process.pid,
            })}\n`);
        });
        socket.on("data", data => {
            input += data;
            while (true) {
                const newline = input.indexOf("\n");
                if (newline < 0)
                    return;
                const line = input.slice(0, newline);
                input = input.slice(newline + 1);
                const message = JSON.parse(line);
                if (message.type !== "ready" || message.runId !== control.runId || sent)
                    continue;
                sent = true;
                for (const event of events) {
                    socket.write(`${JSON.stringify({
                        ...event,
                        traceVersion: 1,
                        runId: control.runId,
                        at: new Date().toISOString(),
                        _traceToken: control.token,
                    })}\n`);
                }
                socket.end();
            }
        });
        socket.on("error", reject);
        socket.on("close", () => {
            clearTimeout(timer);
            if (sent)
                resolve();
        });
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const runDir = options.runDir
        ? path.resolve(options.runDir)
        : fs.mkdtempSync("/tmp/scrypted-homekit-hap-trace-self-test-");
    if (options.runDir)
        fs.mkdirSync(runDir, { mode: 0o700 });
    fs.chmodSync(runDir, 0o700);
    const runId = `self-test-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
    const controlPath = `/tmp/scrypted-homekit-hap-trace-self-test-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`;
    const collector = spawn(process.execPath, [
        path.join(SCRIPT_DIRECTORY, "hap-trace-collector.js"),
        "--run-dir", runDir,
        "--self-test-control", controlPath,
        "--run-id", runId,
        "--duration", "8",
        "--include-keys",
        "--max-bytes", String(4 * 1024 * 1024),
    ], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: {
            ...process.env,
            SCRYPTED_HAP_TRACE_SELF_TEST: "1",
        },
    });
    let socketPath;
    try {
        const ready = await waitForCollectorReady(collector, 4_000);
        assert.equal(ready.runId, runId);
        privateMode(runDir, 0o700);
        privateMode(controlPath, 0o600);
        const control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
        socketPath = control.socketPath;
        assert.equal(control.version, 1);
        assert.equal(control.runId, runId);
        assert.match(control.token, /^[a-f0-9]{64}$/);
        assert.equal(typeof control.expiresAt, "number");
        assert.equal(control.includeKeys, true);
        assert.match(path.basename(control.socketPath), /^scrypted-homekit-hap-trace-.*\.sock$/);
        privateMode(control.socketPath, 0o600);

        const jpeg = Buffer.from([
            0xff, 0xd8,
            0xff, 0xc0, 0x00, 0x11, 0x08,
            0x02, 0xd0, 0x05, 0x00, 0x03,
            0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
            0xff, 0xd9,
        ]);
        const jpegHash = crypto.createHash("sha256").update(jpeg).digest("hex");
        const requestId = "self-test-resource-1";
        await sendProducerSession(control, [
            {
                type: "hap-resource-request",
                connectionId: "self-test-connection",
                requestId,
                url: "/resource",
                accessory: "Self Test Camera",
                width: 1280,
                height: 720,
                reason: 0,
            },
            {
                type: "hap-snapshot-result",
                deviceId: "self-test-device",
                camera: "Self Test Camera",
                requestedWidth: 1280,
                requestedHeight: 720,
                reason: 0,
                elapsedMs: 12,
                bytes: jpeg.length,
                sha256: jpegHash,
                soi: true,
                eoi: true,
                firstMarker: "0xc0",
                jfif: false,
                exif: false,
                iccProfile: false,
                adobe: false,
                sof: "0xc0",
                width: 1280,
                height: 720,
                components: 3,
            },
            {
                type: "hap-resource-response",
                connectionId: "self-test-connection",
                requestId,
                accessory: "Self Test Camera",
                bytes: 84,
                capturedBytes: 84,
                headerComplete: true,
                statusLine: "HTTP/1.1 200 OK",
                statusCode: 200,
                contentType: "image/jpeg",
                declaredContentLength: jpeg.length,
                bodyBytes: jpeg.length,
                bodySha256: jpegHash,
                contentLengthMatches: true,
                truncated: false,
                jpeg: {
                    bytes: jpeg.length,
                    sha256: jpegHash,
                    soi: true,
                    eoi: true,
                    firstMarker: "0xc0",
                    jfif: false,
                    exif: false,
                    iccProfile: false,
                    adobe: false,
                    sof: "0xc0",
                    width: 1280,
                    height: 720,
                    components: 3,
                },
            },
            {
                type: "hap-session-keys",
                connectionId: "self-test-connection",
                external: {
                    localAddress: "127.0.0.1",
                    localPort: 41001,
                    remoteAddress: "127.0.0.1",
                    remotePort: 51001,
                },
                accessoryToControllerKey: crypto.randomBytes(32).toString("base64"),
                controllerToAccessoryKey: crypto.randomBytes(32).toString("base64"),
                accessoryToControllerCount: 0,
                controllerToAccessoryCount: 0,
            },
        ]);
        await new Promise(resolve => setTimeout(resolve, 100));
        collector.kill("SIGINT");
        assert.equal(await waitForExit(collector, 3_000), 0);

        assert.equal(fs.existsSync(controlPath), false, "control file must be removed");
        assert.equal(fs.existsSync(socketPath), false, "socket must be removed");
        const eventsPath = path.join(runDir, "events.jsonl");
        const keysPath = path.join(runDir, "session-keys.jsonl");
        privateMode(eventsPath, 0o600);
        privateMode(keysPath, 0o600);
        const events = readJsonLines(eventsPath);
        const keys = readJsonLines(keysPath);
        assert.deepEqual(events.map(event => event.type), ["hap-resource-request", "hap-snapshot-result", "hap-resource-response"]);
        assert.equal(keys.length, 1);
        assert.equal(keys[0].type, "hap-session-keys");
        assert.ok(events.every(event => event._traceToken === undefined));
        assert.ok(events.every(event => event.accessoryToControllerKey === undefined));

        const analyzer = spawnSync(process.execPath, [
            path.join(SCRIPT_DIRECTORY, "hap-trace-analyze.js"),
            "--run-dir", runDir,
        ], { encoding: "utf8", timeout: 10_000 });
        assert.equal(analyzer.status, 0, analyzer.stderr);
        const analysisPath = path.join(runDir, "analysis.json");
        privateMode(analysisPath, 0o600);
        const analysis = JSON.parse(fs.readFileSync(analysisPath, "utf8"));
        assert.equal(analysis.events.count, 3);
        assert.equal(analysis.sessionKeys.count, 1);
        assert.equal(analysis.events.resourceRequests.length, 1);
        assert.equal(analysis.events.resourceResponseAnomalies.length, 0);
        assert.equal(analysis.events.resourceRequests[0].resourceResponse.bodySha256, jpegHash);
        assert.equal(analysis.events.resourceRequests[0].resourceResponse.contentLengthMatches, true);
        assert.equal(analysis.events.resourceRequests[0].resourceResponse.jpeg.firstMarker, "0xc0");
        assert.equal(analysis.events.resourceRequests[0].resourceResponse.jpeg.jfif, false);
        assert.equal(analysis.events.snapshotResults[0].firstMarker, "0xc0");
        assert.equal(analysis.events.snapshotResults[0].jfif, false);
        assert.equal(analysis.snapshotBodyCorrelations[0].exactSourceMatchCount, 1);

        process.stdout.write(`${JSON.stringify({
            status: "ok",
            runDir,
            kept: options.keep,
            events: events.length,
            keyEvents: keys.length,
            resourceResponseAnomalies: analysis.events.resourceResponseAnomalies.length,
        })}\n`);
    }
    finally {
        if (collector.exitCode === null)
            collector.kill("SIGKILL");
        if (fs.existsSync(controlPath)) {
            try {
                const control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
                if (control.runId === runId)
                    fs.unlinkSync(controlPath);
            }
            catch {
                // Never remove an unverified control file.
            }
        }
        if (socketPath && fs.existsSync(socketPath)) {
            const stat = fs.lstatSync(socketPath);
            if (stat.isSocket() && path.basename(socketPath).startsWith("scrypted-homekit-hap-trace-"))
                fs.unlinkSync(socketPath);
        }
        if (!options.keep && fs.existsSync(runDir)
            && path.basename(runDir).startsWith("scrypted-homekit-hap-trace-self-test-"))
            fs.rmSync(runDir, { recursive: true, force: true });
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
