#!/usr/bin/env node
"use strict";

/**
 * Short-lived, local-only JSONL collector for HomeKit/HAP diagnostics.
 *
 * Producer contract:
 *   1. Read the mode-0600 control file.
 *   2. Connect to control.socketPath (a mode-0600 Unix domain socket).
 *   3. Send `{type:"hello",version:1,runId,token,pid}` and wait for
 *      `{type:"ready",runId}`.
 *   4. Send one JSON object per line with `_traceToken` set to control.token.
 *
 * Session key material is disabled by default. When explicitly enabled, key
 * events are written to a separate mode-0600 file and never copied into the
 * normal event stream or collector summary.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const CONTROL_SCHEMA = "scrypted-homekit-hap-trace-control/v1";
const TRACE_TMP_DIRECTORY = "/tmp";
const DEFAULT_CONTROL = path.join(TRACE_TMP_DIRECTORY, "scrypted-homekit-hap-trace-control.json");
const DEFAULT_DURATION_SECONDS = 120;
const MAX_DURATION_SECONDS = 15 * 60;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const HARD_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;
const HARD_MAX_LINE_BYTES = 4 * 1024 * 1024;
const KEY_EVENT_TYPES = new Set([
    "hap.session.keys",
    "hap-session-keys",
    "hap_session_keys",
]);
const KEY_FIELD_NAMES = new Set([
    "accessorytocontrollerkey",
    "controllertoaccessorykey",
    "sessionkey",
    "sessionkeys",
    "sharedsecret",
    "secretkey",
    "privatekey",
]);

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage:
  node hap-trace-collector.js --run-dir DIR [options]

Options:
  --run-id ID             Correlation ID (default: generated)
  --duration SECONDS      Stop automatically (default: ${DEFAULT_DURATION_SECONDS}, max: ${MAX_DURATION_SECONDS})
  --max-bytes BYTES       Total JSONL output cap (default: ${DEFAULT_MAX_BYTES})
  --max-line-bytes BYTES  Per-event cap (default: ${DEFAULT_MAX_LINE_BYTES})
  --include-keys          Accept key events into session-keys.jsonl
  --ready-file FILE       Write mode-0600 readiness metadata
  --help                  Show this help

The run directory is created mode 0700. Output and control files are mode 0600.
The collector rejects unauthenticated, oversized, malformed, and unexpected
key-bearing events. It removes only its own token-matched control/socket files.
`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const result = {
        control: DEFAULT_CONTROL,
        duration: DEFAULT_DURATION_SECONDS,
        maxBytes: DEFAULT_MAX_BYTES,
        maxLineBytes: DEFAULT_MAX_LINE_BYTES,
        includeKeys: false,
        runId: `hk-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h")
            usage(0);
        if (arg === "--include-keys") {
            result.includeKeys = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined)
            usage(2);
        switch (arg) {
            case "--run-dir":
                result.runDir = value;
                break;
            // The runtime producer intentionally watches one fixed, private
            // path. A separate path exists only so this collector can test
            // itself without colliding with a live diagnostic run.
            case "--self-test-control": {
                const resolved = path.resolve(value);
                if (process.env.SCRYPTED_HAP_TRACE_SELF_TEST !== "1"
                    || path.dirname(resolved) !== TRACE_TMP_DIRECTORY
                    || !/^scrypted-homekit-hap-trace-self-test-[a-zA-Z0-9._-]+\.json$/.test(path.basename(resolved)))
                    throw new Error("--self-test-control is restricted to the collector self-test");
                result.control = resolved;
                break;
            }
            case "--run-id":
                if (!/^[a-zA-Z0-9._-]{8,96}$/.test(value))
                    throw new Error("--run-id must match [a-zA-Z0-9._-]{8,96}");
                result.runId = value;
                break;
            case "--duration":
                result.duration = boundedInteger(value, 1, MAX_DURATION_SECONDS, arg);
                break;
            case "--max-bytes":
                result.maxBytes = boundedInteger(value, 1024, HARD_MAX_BYTES, arg);
                break;
            case "--max-line-bytes":
                result.maxLineBytes = boundedInteger(value, 256, HARD_MAX_LINE_BYTES, arg);
                break;
            case "--ready-file":
                result.readyFile = value;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!result.runDir)
        throw new Error("--run-dir is required");
    return result;
}

function boundedInteger(value, minimum, maximum, flag) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}`);
    return parsed;
}

function assertSafeExistingFile(filePath, expectedMode = 0o600) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink())
        throw new Error(`Refusing non-regular file: ${filePath}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
        throw new Error(`Refusing file owned by another user: ${filePath}`);
    if ((stat.mode & 0o077) !== 0 || (stat.mode & 0o700) !== expectedMode)
        throw new Error(`Refusing file with unsafe permissions: ${filePath}`);
    return stat;
}

function preparePrivateDirectory(directory) {
    const resolved = path.resolve(directory);
    try {
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    catch (e) {
        if (e.code !== "EEXIST")
            throw e;
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Run path is not a real directory: ${resolved}`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid())
        throw new Error(`Run directory is owned by another user: ${resolved}`);
    fs.chmodSync(resolved, 0o700);
    return resolved;
}

function writeExclusiveJson(filePath, object) {
    const fd = fs.openSync(filePath, "wx", 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(object, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}

function writeAtomicPrivateJson(filePath, object) {
    const directory = path.dirname(filePath);
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(object, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
}

function isProcessAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (e) {
        return e.code === "EPERM";
    }
}

function isTraceSocketPath(socketPath) {
    if (typeof socketPath !== "string")
        return false;
    const resolved = path.resolve(socketPath);
    return path.dirname(resolved) === TRACE_TMP_DIRECTORY
        && /^scrypted-homekit-hap-trace-[a-zA-Z0-9._-]+\.sock$/.test(path.basename(resolved));
}

function clearStaleControl(controlPath) {
    if (!fs.existsSync(controlPath))
        return;
    assertSafeExistingFile(controlPath);
    let control;
    try {
        control = JSON.parse(fs.readFileSync(controlPath, "utf8"));
    }
    catch {
        throw new Error(`Refusing unreadable existing control file: ${controlPath}`);
    }
    if (control.version !== 1
        || control.schema !== CONTROL_SCHEMA
        || typeof control.runId !== "string"
        || !/^[a-zA-Z0-9._-]{8,96}$/.test(control.runId))
        throw new Error(`Refusing unrelated existing control file: ${controlPath}`);
    const expired = typeof control.expiresAt !== "number"
        || !Number.isFinite(control.expiresAt)
        || control.expiresAt <= Date.now();
    if (!expired && isProcessAlive(control.collectorPid))
        throw new Error(`A trace collector is already active (pid ${control.collectorPid})`);
    fs.unlinkSync(controlPath);
    if (isTraceSocketPath(control.socketPath)) {
        try {
            const socketPath = path.resolve(control.socketPath);
            const stat = fs.lstatSync(socketPath);
            if (stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid()))
                fs.unlinkSync(socketPath);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                throw e;
        }
    }
}

function containsSensitiveKeyMaterial(event) {
    const type = String(event.type || event.event || "").toLowerCase();
    if (KEY_EVENT_TYPES.has(type))
        return true;
    const stack = [event];
    const seen = new Set();
    while (stack.length) {
        const value = stack.pop();
        if (!value || typeof value !== "object" || seen.has(value))
            continue;
        seen.add(value);
        for (const [key, child] of Object.entries(value)) {
            const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
            if (KEY_FIELD_NAMES.has(normalized))
                return true;
            if (child && typeof child === "object")
                stack.push(child);
        }
    }
    return false;
}

function makeSocketPath() {
    const suffix = crypto.randomBytes(8).toString("hex");
    const socketPath = path.join(TRACE_TMP_DIRECTORY, `scrypted-homekit-hap-trace-${process.pid}-${suffix}.sock`);
    if (Buffer.byteLength(socketPath) >= 100)
        throw new Error(`Unix socket path is too long: ${socketPath}`);
    return socketPath;
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const runDir = preparePrivateDirectory(options.runDir);
    const controlPath = path.resolve(options.control);
    clearStaleControl(controlPath);

    const eventsPath = path.join(runDir, "events.jsonl");
    const keysPath = path.join(runDir, "session-keys.jsonl");
    const summaryPath = path.join(runDir, "collector-summary.json");
    const eventsFd = fs.openSync(eventsPath, "wx", 0o600);
    let keysFd;
    const token = crypto.randomBytes(32).toString("hex");
    const socketPath = makeSocketPath();
    const startedAtMs = Date.now();
    const expiresAtMs = startedAtMs + options.duration * 1000;
    const clients = new Set();
    const counters = {
        acceptedConnections: 0,
        authenticatedConnections: 0,
        events: 0,
        keyEvents: 0,
        rejectedAuth: 0,
        rejectedMalformed: 0,
        rejectedOversized: 0,
        rejectedKeys: 0,
        outputBytes: 0,
    };
    let finishing = false;
    let finishReason = "unknown";
    let controlWritten = false;

    function appendJson(fd, value, keyEvent) {
        const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
        if (counters.outputBytes + line.length > options.maxBytes) {
            finish("max-bytes");
            return false;
        }
        fs.writeSync(fd, line);
        counters.outputBytes += line.length;
        counters.events++;
        if (keyEvent)
            counters.keyEvents++;
        return true;
    }

    function reject(clientCounter) {
        counters[clientCounter]++;
    }

    function acceptEvent(parsed) {
        if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
            reject("rejectedMalformed");
            return;
        }
        if (parsed._traceToken !== token || parsed.runId !== options.runId) {
            reject("rejectedAuth");
            return;
        }
        delete parsed._traceToken;
        const keyEvent = containsSensitiveKeyMaterial(parsed);
        if (keyEvent && !options.includeKeys) {
            reject("rejectedKeys");
            return;
        }
        parsed._collectorReceivedAt = new Date().toISOString();
        if (keyEvent) {
            if (keysFd === undefined)
                keysFd = fs.openSync(keysPath, "wx", 0o600);
            appendJson(keysFd, parsed, true);
        }
        else {
            appendJson(eventsFd, parsed, false);
        }
    }

    const server = net.createServer(socket => {
        counters.acceptedConnections++;
        clients.add(socket);
        let pending = Buffer.alloc(0);
        let discardUntilNewline = false;
        let authenticated = false;
        const helloTimer = setTimeout(() => socket.destroy(), 5_000);
        helloTimer.unref();
        socket.on("data", data => {
            if (finishing)
                return;
            pending = pending.length ? Buffer.concat([pending, data]) : data;
            while (pending.length) {
                const newline = pending.indexOf(0x0a);
                if (newline === -1) {
                    if (pending.length > options.maxLineBytes) {
                        reject("rejectedOversized");
                        pending = Buffer.alloc(0);
                        discardUntilNewline = true;
                    }
                    break;
                }
                const line = pending.subarray(0, newline);
                pending = pending.subarray(newline + 1);
                if (discardUntilNewline) {
                    discardUntilNewline = false;
                    continue;
                }
                if (!line.length)
                    continue;
                if (line.length > options.maxLineBytes) {
                    reject("rejectedOversized");
                    if (!authenticated)
                        socket.destroy();
                    continue;
                }
                let parsed;
                try {
                    parsed = JSON.parse(line.toString("utf8"));
                }
                catch {
                    reject("rejectedMalformed");
                    if (!authenticated)
                        socket.destroy();
                    continue;
                }
                if (!authenticated) {
                    if (!parsed
                        || parsed.type !== "hello"
                        || parsed.version !== 1
                        || parsed.runId !== options.runId
                        || parsed.token !== token
                        || !Number.isSafeInteger(parsed.pid)
                        || parsed.pid <= 0) {
                        reject("rejectedAuth");
                        socket.destroy();
                        continue;
                    }
                    authenticated = true;
                    counters.authenticatedConnections++;
                    clearTimeout(helloTimer);
                    socket.write(`${JSON.stringify({
                        type: "ready",
                        version: 1,
                        runId: options.runId,
                    })}\n`);
                    continue;
                }
                acceptEvent(parsed);
            }
        });
        socket.on("error", () => {
            // Producer failures are reflected by missing events; never crash tracing.
        });
        socket.on("close", () => {
            clearTimeout(helloTimer);
            clients.delete(socket);
        });
    });

    function removeOwnedControl() {
        if (!controlWritten)
            return;
        try {
            assertSafeExistingFile(controlPath);
            const existing = JSON.parse(fs.readFileSync(controlPath, "utf8"));
            if (existing.schema === CONTROL_SCHEMA && existing.token === token)
                fs.unlinkSync(controlPath);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                process.stderr.write(`control cleanup warning: ${e.message}\n`);
        }
    }

    function removeOwnedSocket() {
        try {
            const stat = fs.lstatSync(socketPath);
            if (stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid()))
                fs.unlinkSync(socketPath);
        }
        catch (e) {
            if (e.code !== "ENOENT")
                process.stderr.write(`socket cleanup warning: ${e.message}\n`);
        }
    }

    function finish(reason) {
        if (finishing)
            return;
        finishing = true;
        finishReason = reason;
        clearTimeout(expiryTimer);
        for (const client of clients)
            client.destroy();
        if (server.listening)
            server.close(() => finalize());
        else
            finalize();
        setTimeout(finalize, 1000).unref();
    }

    let finalized = false;
    function finalize() {
        if (finalized)
            return;
        finalized = true;
        removeOwnedControl();
        removeOwnedSocket();
        try {
            fs.fsyncSync(eventsFd);
            fs.closeSync(eventsFd);
        }
        catch {
            // Best effort during signal/error cleanup.
        }
        if (keysFd !== undefined) {
            try {
                fs.fsyncSync(keysFd);
                fs.closeSync(keysFd);
            }
            catch {
                // Best effort during signal/error cleanup.
            }
        }
        const summary = {
            schema: "scrypted-homekit-hap-trace-collector-summary/v1",
            runId: options.runId,
            startedAt: new Date(startedAtMs).toISOString(),
            endedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAtMs,
            reason: finishReason,
            includeKeys: options.includeKeys,
            limits: {
                durationSeconds: options.duration,
                maxBytes: options.maxBytes,
                maxLineBytes: options.maxLineBytes,
            },
            counters,
            files: {
                events: path.basename(eventsPath),
                sessionKeys: keysFd === undefined ? undefined : path.basename(keysPath),
            },
        };
        try {
            writeAtomicPrivateJson(summaryPath, summary);
        }
        catch (e) {
            process.stderr.write(`summary write failed: ${e.message}\n`);
            process.exitCode = 1;
        }
        process.stdout.write(`${JSON.stringify({ status: "stopped", reason: finishReason, summaryPath })}\n`);
    }

    const expiryTimer = setTimeout(() => finish("duration"), options.duration * 1000);
    process.once("SIGINT", () => finish("sigint"));
    process.once("SIGTERM", () => finish("sigterm"));
    process.once("SIGHUP", () => finish("sighup"));
    process.once("uncaughtException", error => {
        process.stderr.write(`${error.stack || error.message}\n`);
        process.exitCode = 1;
        finish("uncaught-exception");
    });
    process.once("unhandledRejection", error => {
        process.stderr.write(`${error && (error.stack || error.message) || error}\n`);
        process.exitCode = 1;
        finish("unhandled-rejection");
    });

    try {
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(socketPath, resolve);
        });
    }
    catch (error) {
        finishReason = "listen-error";
        finishing = true;
        finalize();
        throw error;
    }
    fs.chmodSync(socketPath, 0o600);

    const control = {
        version: 1,
        schema: CONTROL_SCHEMA,
        runId: options.runId,
        collectorPid: process.pid,
        socketPath,
        token,
        runDir,
        startedAt: new Date(startedAtMs).toISOString(),
        expiresAt: expiresAtMs,
        includeKeys: options.includeKeys,
        limits: {
            maxBytes: options.maxBytes,
            maxLineBytes: options.maxLineBytes,
        },
        protocol: {
            encoding: "utf8-jsonl",
            handshake: "hello-ready-v1",
            tokenField: "_traceToken",
            keyEventTypes: [...KEY_EVENT_TYPES],
        },
    };
    writeExclusiveJson(controlPath, control);
    controlWritten = true;

    const ready = {
        status: "ready",
        controlPath,
        runDir,
        socketPath,
        runId: options.runId,
        expiresAt: control.expiresAt,
        includeKeys: options.includeKeys,
    };
    if (options.readyFile)
        writeExclusiveJson(path.resolve(options.readyFile), ready);
    process.stdout.write(`${JSON.stringify(ready)}\n`);
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
