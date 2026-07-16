#!/usr/bin/env node
"use strict";

/**
 * Bounded orchestration wrapper for:
 *   - hap-trace-collector.js
 *   - optional Apple Home/unified-log streaming
 *   - optional loopback and external-interface packet captures
 *   - hap-trace-analyze.js
 *
 * It never invokes sudo and never modifies Scrypted or Home configuration.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const SCRIPT_DIRECTORY = __dirname;
const DEFAULT_DURATION_SECONDS = 120;
const MAX_DURATION_SECONDS = 15 * 60;
const DEFAULT_MAX_PCAP_BYTES = 128 * 1024 * 1024;
const HARD_MAX_PCAP_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_LOG_PREDICATE = [
    'process == "Home"',
    'process == "homed"',
    'process == "homeenergyd"',
    'subsystem CONTAINS[c] "homekit"',
    'subsystem CONTAINS[c] "HomeKit"',
].map(value => `(${value})`).join(" OR ");

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage:
  node hap-trace-run.js [options]

Core options:
  --run-dir DIR           Private run directory (default: /tmp timestamped)
  --duration SECONDS      Bounded capture duration (default: ${DEFAULT_DURATION_SECONDS}, max: ${MAX_DURATION_SECONDS})
  --max-bytes BYTES       Collector JSONL cap
  --include-keys          Explicitly collect ephemeral session keys separately
  --no-analyze            Do not run the analyzer at the end
  --write-plaintext       Pass explicit plaintext export request to analyzer

Apple unified log:
  --home-logs             Run \`log stream\` into home-unified-log.jsonl
  --home-log-predicate P  Override the default Home/HomeKit predicate

Packet capture (no sudo is attempted):
  --loopback IFACE        Capture IFACE into loopback.pcapng (usually lo0)
  --external IFACE        Capture IFACE into external.pcapng (for example en0)
  --capture-filter BPF    Capture filter passed as one argument
  --capture-tool FILE     dumpcap/tcpdump executable override
  --max-pcap-bytes BYTES  Per-live-capture cap (default: ${DEFAULT_MAX_PCAP_BYTES})
  --pcap FILE             Analyze an existing pcap as well (repeatable)

Example:
  node hap-trace-run.js --duration 180 --home-logs \\
    --external en0 --capture-filter "tcp and host 192.168.10.115" \\
    --include-keys

The user should reproduce the black preview during the bounded window. Captures
may require preconfigured dumpcap permissions. This script does not elevate.
`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const result = {
        duration: DEFAULT_DURATION_SECONDS,
        includeKeys: false,
        analyze: true,
        writePlaintext: false,
        homeLogs: false,
        pcaps: [],
        maxPcapBytes: DEFAULT_MAX_PCAP_BYTES,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h")
            usage(0);
        if (arg === "--include-keys") {
            result.includeKeys = true;
            continue;
        }
        if (arg === "--home-logs") {
            result.homeLogs = true;
            continue;
        }
        if (arg === "--no-analyze") {
            result.analyze = false;
            continue;
        }
        if (arg === "--write-plaintext") {
            result.writePlaintext = true;
            continue;
        }
        const value = argv[++i];
        if (value === undefined)
            usage(2);
        switch (arg) {
            case "--run-dir":
                result.runDir = value;
                break;
            case "--duration":
                result.duration = boundedInteger(value, 1, MAX_DURATION_SECONDS, arg);
                break;
            case "--max-bytes":
                result.maxBytes = boundedInteger(value, 1024, 512 * 1024 * 1024, arg);
                break;
            case "--home-log-predicate":
                result.homeLogPredicate = value;
                break;
            case "--loopback":
                result.loopback = value;
                break;
            case "--external":
                result.external = value;
                break;
            case "--capture-filter":
                result.captureFilter = value;
                break;
            case "--capture-tool":
                result.captureTool = value;
                break;
            case "--max-pcap-bytes":
                result.maxPcapBytes = boundedInteger(value, 1024 * 1024, HARD_MAX_PCAP_BYTES, arg);
                break;
            case "--pcap":
                result.pcaps.push(value);
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!result.runDir) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        result.runDir = path.join("/tmp", `scrypted-homekit-hap-trace-${timestamp}`);
    }
    return result;
}

function boundedInteger(value, minimum, maximum, flag) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum)
        throw new Error(`${flag} must be an integer from ${minimum} through ${maximum}`);
    return parsed;
}

function ensurePrivateDirectory(directory) {
    const resolved = path.resolve(directory);
    fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unsafe run directory: ${resolved}`);
    fs.chmodSync(resolved, 0o700);
    return resolved;
}

function openPrivateOutput(filePath) {
    return fs.openSync(filePath, "wx", 0o600);
}

function writePrivateJson(filePath, value) {
    const fd = openPrivateOutput(filePath);
    try {
        fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
}

function findExecutable(explicit, names) {
    if (explicit) {
        fs.accessSync(explicit, fs.constants.X_OK);
        return explicit;
    }
    const search = (process.env.PATH || "").split(path.delimiter);
    for (const name of names) {
        const candidates = path.isAbsolute(name) ? [name] : search.map(directory => path.join(directory, name));
        for (const candidate of candidates) {
            try {
                fs.accessSync(candidate, fs.constants.X_OK);
                return candidate;
            }
            catch {
                // Continue.
            }
        }
    }
}

function spawnLogged(command, args, stdoutPath, stderrPath) {
    const stdoutFd = openPrivateOutput(stdoutPath);
    const stderrFd = openPrivateOutput(stderrPath);
    const child = spawn(command, args, {
        stdio: ["ignore", stdoutFd, stderrFd],
        windowsHide: true,
    });
    // Keep late process errors from becoming uncaught after the readiness
    // probe removes its one-shot diagnostic listener.
    child.on("error", () => {});
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
    return child;
}

function stopChild(child, signal = "SIGINT") {
    if (!child || child.exitCode !== null)
        return;
    try {
        child.kill(signal);
    }
    catch {
        // Best effort.
    }
}

async function stopChildren(children) {
    for (const child of children)
        stopChild(child, "SIGINT");
    await Promise.all(children.map(child => waitForExit(child, 3000)));
    for (const child of children) {
        if (child.exitCode === null) {
            stopChild(child, "SIGTERM");
            await waitForExit(child, 1000);
        }
        if (child.exitCode === null) {
            stopChild(child, "SIGKILL");
            await waitForExit(child, 1000);
        }
    }
}

function readShortError(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8").trim().slice(0, 2000);
    }
    catch {
        return "";
    }
}

function assertChildStarted(child, role, stderrPath, settleMs = 400) {
    return new Promise((resolve, reject) => {
        let error;
        const onError = value => {
            error = value;
        };
        child.once("error", onError);
        setTimeout(() => {
            child.removeListener("error", onError);
            if (error)
                return reject(new Error(`${role} failed to start: ${error.message}`));
            if (child.exitCode !== null) {
                const detail = readShortError(stderrPath);
                return reject(new Error(`${role} exited immediately with code ${child.exitCode}${detail ? `: ${detail}` : ""}`));
            }
            resolve();
        }, settleMs);
    });
}

function waitForExit(child, timeoutMs) {
    if (!child || child.exitCode !== null)
        return Promise.resolve(child && child.exitCode);
    return new Promise(resolve => {
        const onExit = code => {
            clearTimeout(timer);
            resolve(code);
        };
        const timer = setTimeout(() => {
            child.removeListener("exit", onExit);
            resolve(undefined);
        }, timeoutMs);
        child.once("exit", onExit);
    });
}

function waitForCollectorReady(child, timeoutMs) {
    return new Promise((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => reject(new Error(`Collector did not become ready: ${stderr.trim()}`)), timeoutMs);
        child.once("error", error => {
            clearTimeout(timer);
            reject(new Error(`Collector failed to start: ${error.message}`));
        });
        child.stdout.on("data", chunk => {
            stdout += chunk.toString("utf8");
            let newline;
            while ((newline = stdout.indexOf("\n")) !== -1) {
                const line = stdout.slice(0, newline);
                stdout = stdout.slice(newline + 1);
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.status === "ready") {
                        clearTimeout(timer);
                        resolve(parsed);
                        return;
                    }
                }
                catch {
                    // Ignore non-JSON progress.
                }
            }
        });
        child.stderr.on("data", chunk => {
            stderr += chunk.toString("utf8");
            process.stderr.write(chunk);
        });
        child.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`Collector exited before readiness (code ${code}): ${stderr.trim()}`));
        });
    });
}

function captureCommand(tool, iface, output, filter, durationSeconds, maxBytes) {
    const name = path.basename(tool).toLowerCase();
    if (name.includes("dumpcap")) {
        const args = [
            "-q", "-i", iface, "-w", output,
            "-a", `duration:${durationSeconds}`,
            "-a", `filesize:${Math.ceil(maxBytes / 1024)}`,
        ];
        if (filter)
            args.push("-f", filter);
        return args;
    }
    if (name.includes("tcpdump")) {
        const args = ["-n", "-U", "-i", iface, "-w", output];
        if (filter)
            args.push(filter);
        return args;
    }
    throw new Error(`Unsupported capture tool: ${tool}; use dumpcap or tcpdump`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    const runDir = ensurePrivateDirectory(options.runDir);
    const manifest = {
        schema: "scrypted-homekit-hap-trace-run/v1",
        runId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        durationSeconds: options.duration,
        includeKeys: options.includeKeys,
        runDir,
        processes: [],
        inputs: {
            existingPcaps: options.pcaps.map(file => path.resolve(file)),
        },
    };
    const children = [];
    const liveCaptures = [];
    let interrupted = false;
    const interrupt = () => {
        interrupted = true;
    };
    let signalHandlersInstalled = false;
    try {
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    signalHandlersInstalled = true;

    if (options.homeLogs) {
        const logTool = findExecutable("/usr/bin/log", []);
        const logOut = path.join(runDir, "home-unified-log.jsonl");
        const logErr = path.join(runDir, "home-unified-log.stderr.log");
        const logArgs = [
            "stream",
            "--style", "ndjson",
            "--level", "debug",
            "--predicate", options.homeLogPredicate || DEFAULT_LOG_PREDICATE,
        ];
        const child = spawnLogged(logTool, logArgs, logOut, logErr);
        children.push(child);
        await assertChildStarted(child, "Home unified-log capture", logErr);
        manifest.processes.push({ role: "home-unified-log", pid: child.pid, output: logOut });
    }

    const captureInterfaces = [
        options.loopback && { role: "loopback-pcap", iface: options.loopback, output: path.join(runDir, "loopback.pcapng") },
        options.external && { role: "external-pcap", iface: options.external, output: path.join(runDir, "external.pcapng") },
    ].filter(Boolean);
    let captureTool;
    if (captureInterfaces.length) {
        captureTool = findExecutable(options.captureTool, [
            "dumpcap",
            "/opt/homebrew/bin/dumpcap",
            "/usr/local/bin/dumpcap",
            "/usr/sbin/tcpdump",
        ]);
        if (!captureTool)
            throw new Error("No dumpcap or tcpdump executable was found");
    }
    for (const capture of captureInterfaces) {
        const stderrPath = `${capture.output}.stderr.log`;
        const child = spawnLogged(
            captureTool,
            captureCommand(
                captureTool,
                capture.iface,
                capture.output,
                options.captureFilter,
                Math.min(options.duration + 15, MAX_DURATION_SECONDS + 15),
                options.maxPcapBytes,
            ),
            path.join(runDir, `${capture.role}.stdout.log`),
            stderrPath,
        );
        children.push(child);
        await assertChildStarted(child, capture.role, stderrPath, 1500);
        let initialPcapBytes = 0;
        try {
            initialPcapBytes = fs.statSync(capture.output).size;
        }
        catch {
            // The detailed dumpcap/tcpdump error is reported below.
        }
        if (!initialPcapBytes) {
            const detail = readShortError(stderrPath);
            throw new Error(`${capture.role} did not initialize a pcap before trace activation${detail ? `: ${detail}` : ""}`);
        }
        liveCaptures.push({ ...capture, child, stderrPath, limitReached: false });
        manifest.processes.push({
            role: capture.role,
            pid: child.pid,
            interface: capture.iface,
            output: capture.output,
            filter: options.captureFilter,
            maxBytes: options.maxPcapBytes,
        });
        options.pcaps.push(capture.output);
    }

    // Packet capture must already be verified before the control file is
    // published. Otherwise an existing HAP session can advance its record
    // counters after key export but before the first captured packet.
    const collectorArgs = [
        path.join(SCRIPT_DIRECTORY, "hap-trace-collector.js"),
        "--run-dir", runDir,
        "--duration", String(options.duration),
    ];
    if (options.maxBytes)
        collectorArgs.push("--max-bytes", String(options.maxBytes));
    if (options.includeKeys)
        collectorArgs.push("--include-keys");
    const collector = spawn(process.execPath, collectorArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
    });
    children.push(collector);
    const ready = await waitForCollectorReady(collector, 10_000);
    manifest.runId = ready.runId;
    manifest.controlPath = ready.controlPath;
    manifest.collectorExpiresAt = ready.expiresAt;
    manifest.processes.push({ role: "collector", pid: collector.pid });
    process.stdout.write(`Trace collector ready; reproduce the Home black preview now.\nRun directory: ${runDir}\n`);

    writePrivateJson(path.join(runDir, "run-manifest.json"), manifest);

    const deadline = Date.now() + options.duration * 1000;
    while (!interrupted && Date.now() < deadline) {
        for (const capture of liveCaptures) {
            try {
                if (fs.statSync(capture.output).size >= options.maxPcapBytes) {
                    capture.limitReached = true;
                    stopChild(capture.child, "SIGINT");
                }
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
    }
    await stopChildren(children);

    for (const capture of liveCaptures) {
        let bytes = 0;
        try {
            bytes = fs.statSync(capture.output).size;
        }
        catch {
            // Reported below with the capture process diagnostics.
        }
        if (!bytes) {
            const detail = readShortError(capture.stderrPath);
            throw new Error(`${capture.role} produced no pcap${detail ? `: ${detail}` : ""}`);
        }
    }

    writePrivateJson(path.join(runDir, "run-summary.json"), {
        schema: "scrypted-homekit-hap-trace-run-summary/v1",
        runId: manifest.runId,
        endedAt: new Date().toISOString(),
        interrupted,
        captures: liveCaptures.map(capture => ({
            role: capture.role,
            interface: capture.iface,
            output: capture.output,
            bytes: fs.statSync(capture.output).size,
            maxBytes: options.maxPcapBytes,
            limitReached: capture.limitReached,
            exitCode: capture.child.exitCode,
            signalCode: capture.child.signalCode,
        })),
    });

    if (options.analyze) {
        const analyzerArgs = [
            path.join(SCRIPT_DIRECTORY, "hap-trace-analyze.js"),
            "--run-dir", runDir,
        ];
        for (const pcap of options.pcaps) {
            if (fs.existsSync(pcap))
                analyzerArgs.push("--pcap", path.resolve(pcap));
        }
        if (options.writePlaintext)
            analyzerArgs.push("--write-plaintext");
        const analyzer = spawn(process.execPath, analyzerArgs, {
            stdio: "inherit",
            windowsHide: true,
        });
        children.push(analyzer);
        const analyzerExit = await waitForExit(analyzer, 10 * 60 * 1000);
        if (analyzerExit === undefined) {
            stopChild(analyzer, "SIGTERM");
            throw new Error("Analyzer exceeded its ten-minute bound");
        }
        if (analyzerExit !== 0)
            throw new Error(`Analyzer exited with code ${analyzerExit}`);
    }
    process.stdout.write(`Trace run complete: ${runDir}\n`);
    }
    finally {
        if (signalHandlersInstalled) {
            process.removeListener("SIGINT", interrupt);
            process.removeListener("SIGTERM", interrupt);
        }
        await stopChildren(children);
    }
}

main().catch(error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
});
