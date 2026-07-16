#!/usr/bin/env node
"use strict";

/**
 * Correlates HAP trace JSONL, Apple unified-log exports, and packet captures.
 *
 * This deliberately emits metadata, hashes, timing, and framing/decryption
 * status rather than raw HomeKit plaintext. `--write-plaintext` is explicit
 * and writes only into a mode-0700 subdirectory with mode-0600 files.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const MAX_PCAP_STDOUT = 512 * 1024 * 1024;

function usage(exitCode = 0) {
    const out = exitCode ? process.stderr : process.stdout;
    out.write(`Usage:
  node hap-trace-analyze.js --run-dir DIR [options]

Options:
  --events FILE           Trace events JSONL (default: RUN/events.jsonl)
  --keys FILE             Optional session key JSONL (default if present)
  --home-log FILE         Apple unified-log NDJSON/JSONL (repeatable)
  --pcap FILE             Loopback or external pcap/pcapng (repeatable)
  --out-json FILE         Analysis JSON (default: RUN/analysis.json)
  --out-md FILE           Brief report (default: RUN/analysis.md)
  --tshark FILE           tshark executable override
  --write-plaintext       Save decrypted directions under RUN/plaintext/
  --help                  Show this help

Expected optional key event fields:
  type: "hap-session-keys"
  connectionId, external.{localAddress,localPort,remoteAddress,remotePort}
  accessoryToControllerKey, controllerToAccessoryKey (base64, base64url, hex)
  accessoryToControllerCount, controllerToAccessoryCount (current counters)

No key bytes or decrypted bodies are included in analysis.json/analysis.md.
`);
    process.exit(exitCode);
}

function parseArgs(argv) {
    const result = {
        pcaps: [],
        homeLogs: [],
        writePlaintext: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--help" || arg === "-h")
            usage(0);
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
            case "--events":
                result.events = value;
                break;
            case "--keys":
                result.keys = value;
                break;
            case "--home-log":
                result.homeLogs.push(value);
                break;
            case "--pcap":
                result.pcaps.push(value);
                break;
            case "--out-json":
                result.outJson = value;
                break;
            case "--out-md":
                result.outMd = value;
                break;
            case "--tshark":
                result.tshark = value;
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }
    if (!result.runDir)
        throw new Error("--run-dir is required");
    const runDir = path.resolve(result.runDir);
    result.runDir = runDir;
    result.events ||= path.join(runDir, "events.jsonl");
    const defaultKeys = path.join(runDir, "session-keys.jsonl");
    if (!result.keys && fs.existsSync(defaultKeys))
        result.keys = defaultKeys;
    const defaultHomeLog = path.join(runDir, "home-unified-log.jsonl");
    if (!result.homeLogs.length && fs.existsSync(defaultHomeLog))
        result.homeLogs.push(defaultHomeLog);
    for (const name of ["loopback.pcapng", "external.pcapng"]) {
        const candidate = path.join(runDir, name);
        if (!result.pcaps.includes(candidate) && fs.existsSync(candidate))
            result.pcaps.push(candidate);
    }
    result.outJson ||= path.join(runDir, "analysis.json");
    result.outMd ||= path.join(runDir, "analysis.md");
    return result;
}

function ensurePrivateDirectory(directory) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(`Unsafe directory: ${directory}`);
    fs.chmodSync(directory, 0o700);
}

function writePrivate(filePath, data) {
    ensurePrivateDirectory(path.dirname(filePath));
    const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
    const fd = fs.openSync(temporary, "wx", 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    }
    finally {
        fs.closeSync(fd);
    }
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
}

function readJsonLines(filePath, errors, ignoreNonJson = false) {
    if (!filePath || !fs.existsSync(filePath))
        return [];
    const contents = fs.readFileSync(filePath, "utf8");
    if (ignoreNonJson) {
        // `log stream --style json` writes one pretty-printed JSON array and
        // may prefix it with a human-readable filter banner. Prefer that
        // native shape before falling back to NDJSON/event-per-line inputs.
        const arrayStart = /\[\s*(?:\{|\])/.exec(contents)?.index;
        const arrayEnd = contents.lastIndexOf("]");
        if (arrayStart !== undefined && arrayEnd >= arrayStart) {
            try {
                const parsed = JSON.parse(contents.slice(arrayStart, arrayEnd + 1));
                if (Array.isArray(parsed))
                    return parsed.filter(value => value && typeof value === "object");
            }
            catch (e) {
                errors.push(`${path.basename(filePath)}: JSON array: ${e.message}`);
            }
        }
    }
    const result = [];
    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim())
            continue;
        if (ignoreNonJson && !/^\s*[\[{]/.test(lines[i]))
            continue;
        try {
            const parsed = JSON.parse(lines[i]);
            if (parsed && typeof parsed === "object")
                result.push(parsed);
        }
        catch (e) {
            errors.push(`${path.basename(filePath)}:${i + 1}: ${e.message}`);
        }
    }
    return result;
}

function eventType(event) {
    return String(event.type || event.event || event.name || "unknown");
}

function eventTimestamp(event) {
    for (const value of [
        event.ts,
        event.timestamp,
        event.at,
        event.time,
        event.date,
        event._collectorReceivedAt,
        event.trace && event.trace.timestamp,
    ]) {
        if (typeof value === "number" && Number.isFinite(value))
            return value > 1e12 ? value : value * 1000;
        if (typeof value === "string") {
            const parsed = Date.parse(value);
            if (Number.isFinite(parsed))
                return parsed;
        }
    }
}

function connectionId(event) {
    return event.connectionId || event.connection || event.sessionId || event.session || "unknown";
}

function summarizeEvents(events) {
    const byType = {};
    const byConnection = {};
    const requests = new Map();
    const snapshotResults = [];
    let firstTimestamp;
    let lastTimestamp;
    for (const event of events) {
        const type = eventType(event);
        byType[type] = (byType[type] || 0) + 1;
        const connection = String(connectionId(event));
        byConnection[connection] = (byConnection[connection] || 0) + 1;
        const timestamp = eventTimestamp(event);
        if (timestamp !== undefined) {
            firstTimestamp = firstTimestamp === undefined ? timestamp : Math.min(firstTimestamp, timestamp);
            lastTimestamp = lastTimestamp === undefined ? timestamp : Math.max(lastTimestamp, timestamp);
        }
        if (type === "hap-snapshot-result") {
            snapshotResults.push({
                timestamp,
                at: iso(timestamp),
                deviceId: event.deviceId,
                camera: event.camera,
                requestedWidth: event.requestedWidth,
                requestedHeight: event.requestedHeight,
                reason: event.reason,
                elapsedMs: event.elapsedMs,
                bytes: event.bytes,
                sha256: event.sha256,
                soi: event.soi,
                eoi: event.eoi,
                firstMarker: event.firstMarker,
                jfif: event.jfif,
                exif: event.exif,
                iccProfile: event.iccProfile,
                adobe: event.adobe,
                sof: event.sof,
                width: event.width,
                height: event.height,
                components: event.components,
            });
        }
        const requestId = event.requestId || event.request && event.request.id;
        if (requestId !== undefined) {
            const key = `${connection}:${requestId}`;
            const item = requests.get(key) || {
                connectionId: connection,
                requestId: String(requestId),
                eventCount: 0,
                bytes: 0,
            };
            item.eventCount++;
            item.firstTimestamp = item.firstTimestamp === undefined ? timestamp : Math.min(item.firstTimestamp, timestamp ?? item.firstTimestamp);
            item.lastTimestamp = item.lastTimestamp === undefined ? timestamp : Math.max(item.lastTimestamp, timestamp ?? item.lastTimestamp);
            const url = event.url || event.path || event.request && (event.request.url || event.request.path);
            if (url)
                item.url = String(url);
            const status = event.statusCode || event.status;
            if (status !== undefined)
                item.status = status;
            const bytes = Number(event.bytes || event.byteLength || event.length || 0);
            if (Number.isFinite(bytes) && bytes > 0) {
                if (type === "hap-resource-response")
                    item.bytes = Math.max(item.bytes, bytes);
                else if (type === "hap-response-boundary")
                    item.bytes += bytes;
            }
            if (type === "hap-resource-request") {
                item.resourceRequest = {
                    accessory: event.accessory,
                    aid: event.aid,
                    width: event.width,
                    height: event.height,
                    reason: event.reason,
                    declaredContentLength: event.declaredContentLength,
                    bodyBytes: event.bodyBytes,
                    contentLengthMatches: event.contentLengthMatches,
                    truncated: event.truncated,
                };
            }
            if (type === "hap-resource-response") {
                const jpeg = event.jpeg || {};
                const successful = event.statusCode === 200 && event.truncated !== true;
                item.resourceResponse = {
                    accessory: event.accessory,
                    statusLine: event.statusLine,
                    statusCode: event.statusCode,
                    bytes: event.bytes,
                    capturedBytes: event.capturedBytes,
                    headerComplete: event.headerComplete,
                    truncated: event.truncated,
                    contentType: event.contentType,
                    declaredContentLength: event.declaredContentLength,
                    transferEncoding: event.transferEncoding,
                    bodyBytes: event.bodyBytes,
                    rawSha256: event.rawSha256,
                    bodySha256: event.bodySha256,
                    contentLengthMatches: event.contentLengthMatches,
                    jpeg: {
                        bytes: jpeg.bytes,
                        sha256: jpeg.sha256,
                        soi: jpeg.soi,
                        eoi: jpeg.eoi,
                        firstMarker: jpeg.firstMarker,
                        jfif: jpeg.jfif,
                        exif: jpeg.exif,
                        iccProfile: jpeg.iccProfile,
                        adobe: jpeg.adobe,
                        width: jpeg.width,
                        height: jpeg.height,
                        components: jpeg.components,
                        sof: jpeg.sof,
                    },
                };
                item.responseAnomalies = [
                    event.headerComplete === false && "incomplete HTTP headers",
                    event.truncated === true && "trace response exceeded capture bound",
                    event.statusCode !== undefined && event.statusCode !== 200 && `HTTP ${event.statusCode}`,
                    successful && !/^image\/jpeg(?:\s*;|$)/i.test(String(event.contentType || "")) && "missing/non-JPEG Content-Type",
                    successful && event.declaredContentLength === undefined && "missing Content-Length",
                    successful && !(event.bodyBytes > 0) && "empty JPEG body",
                    successful && !event.bodySha256 && "missing JPEG body hash",
                    event.contentLengthMatches === false && "Content-Length mismatch",
                    successful && !event.jpeg && "missing JPEG metadata",
                    successful && jpeg.soi !== true && "missing JPEG SOI",
                    successful && jpeg.eoi !== true && "missing JPEG EOI",
                    successful && !jpeg.sof && "missing JPEG SOF",
                    successful && !(jpeg.width > 1) && "missing/invalid JPEG width",
                    successful && !(jpeg.height > 1) && "missing/invalid JPEG height",
                ].filter(Boolean);
            }
            requests.set(key, item);
        }
    }
    const requestSummary = [...requests.values()].map(item => ({
        ...item,
        durationMs: item.firstTimestamp !== undefined && item.lastTimestamp !== undefined
            ? item.lastTimestamp - item.firstTimestamp
            : undefined,
    }));
    return {
        count: events.length,
        firstTimestamp: iso(firstTimestamp),
        lastTimestamp: iso(lastTimestamp),
        durationMs: firstTimestamp !== undefined && lastTimestamp !== undefined ? lastTimestamp - firstTimestamp : undefined,
        byType,
        byConnection,
        requests: requestSummary,
        resourceRequests: requestSummary.filter(request => request.resourceRequest
            || request.resourceResponse
            || request.url && /\/resource(?:\?|$)/i.test(request.url)),
        resourceResponseAnomalies: requestSummary.filter(request => request.responseAnomalies?.length),
        snapshotResults,
    };
}

function extractLogMessage(record) {
    return String(record.eventMessage || record.composedMessage || record.message || record.msg || "");
}

function summarizeHomeLogs(records) {
    const markerPattern = /\b(?:black|blank|snapshot|resource|camera|jpeg|timeout|timed out|error|fail|drop|stall|invalid|decrypt|encrypt|hap)\b/i;
    const markers = [];
    for (const record of records) {
        const message = extractLogMessage(record);
        if (!message || !markerPattern.test(message))
            continue;
        markers.push({
            timestamp: iso(eventTimestamp(record)),
            process: record.process || record.processImagePath || record.senderImagePath,
            subsystem: record.subsystem,
            category: record.category,
            message: message.slice(0, 1000),
        });
    }
    return {
        count: records.length,
        diagnosticMarkerCount: markers.length,
        diagnosticMarkers: markers.slice(0, 500),
        markersTruncated: markers.length > 500,
    };
}

function iso(timestamp) {
    return timestamp === undefined ? undefined : new Date(timestamp).toISOString();
}

function findExecutable(explicit, names) {
    if (explicit) {
        if (!fs.existsSync(explicit))
            throw new Error(`Executable not found: ${explicit}`);
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

function tsharkPackets(tshark, pcapPath) {
    const fields = [
        "frame.time_epoch",
        "ip.src",
        "ipv6.src",
        "tcp.srcport",
        "ip.dst",
        "ipv6.dst",
        "tcp.dstport",
        "tcp.stream",
        "tcp.seq",
        "tcp.len",
        "tcp.analysis.retransmission",
        "tcp.analysis.fast_retransmission",
        "tcp.analysis.out_of_order",
        "tcp.payload",
    ];
    const args = ["-n", "-r", pcapPath, "-Y", "tcp", "-T", "fields", "-E", "separator=\t", "-E", "quote=n", "-E", "occurrence=f"];
    for (const field of fields)
        args.push("-e", field);
    const result = spawnSync(tshark, args, {
        encoding: "utf8",
        maxBuffer: MAX_PCAP_STDOUT,
        windowsHide: true,
    });
    if (result.error)
        throw result.error;
    if (result.status !== 0)
        throw new Error(`tshark failed for ${pcapPath}: ${(result.stderr || "").trim()}`);
    const packets = [];
    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line)
            continue;
        const columns = line.split("\t");
        while (columns.length < fields.length)
            columns.push("");
        const [time, ip4Source, ip6Source, sourcePort, ip4Destination, ip6Destination, destinationPort, stream, sequence, tcpLength, retransmission, fastRetransmission, outOfOrder, payload] = columns;
        if (stream === "")
            continue;
        packets.push({
            timestamp: Number(time) * 1000,
            sourceAddress: normalizeAddress(ip4Source || ip6Source),
            sourcePort: Number(sourcePort),
            destinationAddress: normalizeAddress(ip4Destination || ip6Destination),
            destinationPort: Number(destinationPort),
            stream: Number(stream),
            sequence: Number(sequence),
            tcpLength: Number(tcpLength),
            retransmission: Boolean(retransmission || fastRetransmission),
            outOfOrder: Boolean(outOfOrder),
            payload: payload ? Buffer.from(payload.replace(/:/g, ""), "hex") : Buffer.alloc(0),
        });
    }
    return packets;
}

function normalizeAddress(address) {
    return String(address || "").replace(/^::ffff:/i, "").toLowerCase();
}

function endpoint(address, port) {
    return `${normalizeAddress(address)}:${Number(port)}`;
}

function reassembleSegments(packets) {
    const segments = packets
        .filter(packet => packet.payload.length && !packet.retransmission)
        .sort((a, b) => a.sequence - b.sequence || a.timestamp - b.timestamp);
    if (!segments.length)
        return { buffer: Buffer.alloc(0), gaps: 0, overlaps: 0 };
    const chunks = [];
    let expected = segments[0].sequence;
    let gaps = 0;
    let overlaps = 0;
    for (const segment of segments) {
        let start = 0;
        if (segment.sequence > expected) {
            gaps++;
            expected = segment.sequence;
        }
        else if (segment.sequence < expected) {
            overlaps++;
            start = expected - segment.sequence;
            if (start >= segment.payload.length)
                continue;
        }
        const chunk = segment.payload.subarray(start);
        chunks.push(chunk);
        expected += chunk.length;
    }
    return { buffer: Buffer.concat(chunks), gaps, overlaps };
}

function parseHapRecords(buffer, offset = 0) {
    const records = [];
    let cursor = offset;
    while (cursor + 18 <= buffer.length) {
        const length = buffer.readUInt16LE(cursor);
        if (length > 0x400 || cursor + 18 + length > buffer.length)
            break;
        records.push({
            offset: cursor,
            plaintextLength: length,
            aad: buffer.subarray(cursor, cursor + 2),
            ciphertext: buffer.subarray(cursor + 2, cursor + 2 + length),
            tag: buffer.subarray(cursor + 2 + length, cursor + 18 + length),
        });
        cursor += 18 + length;
    }
    return { records, consumedBytes: cursor - offset, trailingBytes: buffer.length - cursor };
}

function bestUnauthenticatedHapOffset(buffer) {
    const parsed = parseHapRecords(buffer, 0);
    if (parsed.records.length < 3
        || parsed.consumedBytes < 256
        || parsed.trailingBytes !== 0)
        return;
    return { offset: 0, ...parsed };
}

function decodeKey(value) {
    if (Buffer.isBuffer(value))
        return value;
    if (value && typeof value === "object" && value.type === "Buffer" && Array.isArray(value.data))
        return Buffer.from(value.data);
    if (typeof value !== "string")
        return;
    const compact = value.trim();
    if (/^[0-9a-f]{64}$/i.test(compact))
        return Buffer.from(compact, "hex");
    try {
        const decoded = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64");
        if (decoded.length === 32)
            return decoded;
    }
    catch {
        // Invalid key encoding.
    }
}

function keyField(event, direction) {
    const keys = event.keys || event.encryption || {};
    if (direction === "accessoryToController")
        return decodeKey(event.accessoryToControllerKey || keys.accessoryToControllerKey || keys.accessoryToController);
    return decodeKey(event.controllerToAccessoryKey || keys.controllerToAccessoryKey || keys.controllerToAccessory);
}

function countField(event, direction) {
    const counters = event.counters || event.encryption || {};
    const values = direction === "accessoryToController"
        ? [event.accessoryToControllerCountStart, event.accessoryToControllerCount, counters.accessoryToControllerCount]
        : [event.controllerToAccessoryCountStart, event.controllerToAccessoryCount, counters.controllerToAccessoryCount];
    for (const value of values) {
        const number = Number(value);
        if (Number.isSafeInteger(number) && number >= 0)
            return number;
    }
    return 0;
}

function keyEndpoint(event, side) {
    const nested = event[side] || {};
    const external = event.external || {};
    const address = event[`${side}Address`]
        || external[`${side}Address`]
        || nested.address
        || nested.host;
    const port = event[`${side}Port`] || external[`${side}Port`] || nested.port;
    if (!address || !port)
        return;
    return endpoint(address, port);
}

function nonceForCounter(counter) {
    const nonce = Buffer.alloc(12);
    nonce.writeBigUInt64LE(BigInt(counter), 4);
    return nonce;
}

function decryptRecord(record, key, counter) {
    const decipher = crypto.createDecipheriv("chacha20-poly1305", key, nonceForCounter(counter), { authTagLength: 16 });
    decipher.setAAD(record.aad, { plaintextLength: record.ciphertext.length });
    decipher.setAuthTag(record.tag);
    const plaintext = decipher.update(record.ciphertext);
    decipher.final();
    return plaintext;
}

function findAuthenticatedHapOffset(buffer, key, counter) {
    // The collector may become active in the middle of an already-running,
    // multi-megabyte JPEG response. Search up to the resource trace cap so the
    // current key counter can authenticate the first post-activation record.
    const scanLimit = Math.min(buffer.length, 16 * 1024 * 1024);
    for (let offset = 0; offset + 18 <= scanLimit; offset++) {
        const length = buffer.readUInt16LE(offset);
        if (length > 0x400 || offset + 18 + length > buffer.length)
            continue;
        const parsed = parseHapRecords(buffer, offset);
        if (!parsed.records.length)
            continue;
        try {
            decryptRecord(parsed.records[0], key, counter);
            if (parsed.records.length > 1)
                decryptRecord(parsed.records[1], key, counter + 1);
            return { offset, ...parsed };
        }
        catch {
            // Authentication makes false positives vanishingly unlikely.
        }
    }
}

function decryptHapDirection(buffer, key, initialCounter) {
    const located = findAuthenticatedHapOffset(buffer, key, initialCounter);
    if (!located)
        return { ok: false, error: "no authenticated HAP record boundary found" };
    const plaintext = [];
    let counter = initialCounter;
    try {
        for (const record of located.records)
            plaintext.push(decryptRecord(record, key, counter++));
    }
    catch (e) {
        return {
            ok: false,
            error: e.message,
            offset: located.offset,
            decryptedRecords: plaintext.length,
        };
    }
    return {
        ok: true,
        offset: located.offset,
        recordCount: located.records.length,
        trailingBytes: located.trailingBytes,
        initialCounter,
        finalCounter: counter,
        plaintext: Buffer.concat(plaintext),
    };
}

function parseChunkedBody(buffer, offset) {
    const chunks = [];
    let cursor = offset;
    while (true) {
        const lineEnd = buffer.indexOf("\r\n", cursor, "ascii");
        if (lineEnd === -1)
            return;
        const sizeText = buffer.subarray(cursor, lineEnd).toString("ascii").split(";", 1)[0].trim();
        if (!/^[0-9a-f]+$/i.test(sizeText))
            return;
        const size = Number.parseInt(sizeText, 16);
        cursor = lineEnd + 2;
        if (size === 0) {
            const end = buffer.indexOf("\r\n\r\n", cursor, "ascii");
            const consumed = end === -1 ? cursor + 2 : end + 4;
            return { body: Buffer.concat(chunks), consumed: consumed - offset };
        }
        if (cursor + size + 2 > buffer.length)
            return;
        chunks.push(buffer.subarray(cursor, cursor + size));
        cursor += size;
        if (buffer.subarray(cursor, cursor + 2).toString("ascii") !== "\r\n")
            return;
        cursor += 2;
    }
}

function summarizeBody(body, contentType) {
    const jpeg = /image\/jpeg/i.test(contentType || "") || (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8);
    const sampleLength = Math.min(body.length, 4096);
    let zeroes = 0;
    for (let i = 0; i < sampleLength; i++) {
        if (body[i] === 0)
            zeroes++;
    }
    return {
        bytes: body.length,
        sha256: crypto.createHash("sha256").update(body).digest("hex"),
        jpeg,
        jpegHasSoi: jpeg ? body.subarray(0, 2).equals(Buffer.from([0xff, 0xd8])) : undefined,
        jpegHasEoi: jpeg ? body.subarray(-2).equals(Buffer.from([0xff, 0xd9])) : undefined,
        leadingZeroFraction: sampleLength ? zeroes / sampleLength : undefined,
    };
}

function parseHttpMessages(buffer) {
    const messages = [];
    let cursor = 0;
    while (cursor < buffer.length) {
        const headerEnd = buffer.indexOf("\r\n\r\n", cursor, "ascii");
        if (headerEnd === -1)
            break;
        const headerText = buffer.subarray(cursor, headerEnd).toString("latin1");
        const lines = headerText.split("\r\n");
        const firstLine = lines.shift();
        if (!/^(?:[A-Z]+ \S+ HTTP\/1\.[01]|HTTP\/1\.[01] \d{3}|EVENT\/1\.0 \d{3})/.test(firstLine)) {
            cursor++;
            continue;
        }
        const headers = {};
        for (const line of lines) {
            const colon = line.indexOf(":");
            if (colon <= 0)
                continue;
            const name = line.slice(0, colon).trim().toLowerCase();
            const value = line.slice(colon + 1).trim();
            if (name !== "authorization")
                headers[name] = value;
        }
        const bodyOffset = headerEnd + 4;
        let body = Buffer.alloc(0);
        let consumed;
        if (/chunked/i.test(headers["transfer-encoding"] || "")) {
            const chunked = parseChunkedBody(buffer, bodyOffset);
            if (!chunked)
                break;
            body = chunked.body;
            consumed = bodyOffset - cursor + chunked.consumed;
        }
        else {
            const contentLength = Number(headers["content-length"] || 0);
            if (!Number.isSafeInteger(contentLength) || contentLength < 0 || bodyOffset + contentLength > buffer.length)
                break;
            body = buffer.subarray(bodyOffset, bodyOffset + contentLength);
            consumed = bodyOffset - cursor + contentLength;
        }
        messages.push({
            offset: cursor,
            firstLine,
            headers,
            body: summarizeBody(body, headers["content-type"]),
        });
        cursor += consumed;
    }
    return { messages, trailingBytes: buffer.length - cursor };
}

function chooseKeyEvent(keyEvents, stream, streamStart, streamEnd) {
    const first = stream.directions[0];
    const second = stream.directions[1];
    if (!first || !second)
        return;
    const endpoints = new Set([first.sourceEndpoint, first.destinationEndpoint]);
    const candidates = keyEvents.filter(event => {
        const local = keyEndpoint(event, "local");
        const remote = keyEndpoint(event, "remote");
        return local && remote && endpoints.has(local) && endpoints.has(remote);
    });
    if (!candidates.length)
        return;
    candidates.sort((a, b) => {
        const at = eventTimestamp(a) ?? streamStart;
        const bt = eventTimestamp(b) ?? streamStart;
        const ad = at < streamStart ? streamStart - at : at > streamEnd ? at - streamEnd : 0;
        const bd = bt < streamStart ? streamStart - bt : bt > streamEnd ? bt - streamEnd : 0;
        return ad - bd;
    });
    return candidates[0];
}

function analyzePcap(pcapPath, tshark, keyEvents, options, errors) {
    const packets = tsharkPackets(tshark, pcapPath);
    const grouped = new Map();
    for (const packet of packets) {
        let stream = grouped.get(packet.stream);
        if (!stream) {
            stream = {
                stream: packet.stream,
                packets: [],
                firstTimestamp: packet.timestamp,
                lastTimestamp: packet.timestamp,
                retransmissions: 0,
                outOfOrder: 0,
            };
            grouped.set(packet.stream, stream);
        }
        stream.packets.push(packet);
        stream.firstTimestamp = Math.min(stream.firstTimestamp, packet.timestamp);
        stream.lastTimestamp = Math.max(stream.lastTimestamp, packet.timestamp);
        if (packet.retransmission)
            stream.retransmissions++;
        if (packet.outOfOrder)
            stream.outOfOrder++;
    }
    const streamResults = [];
    for (const stream of grouped.values()) {
        const directions = new Map();
        for (const packet of stream.packets) {
            const key = `${endpoint(packet.sourceAddress, packet.sourcePort)}>${endpoint(packet.destinationAddress, packet.destinationPort)}`;
            let direction = directions.get(key);
            if (!direction) {
                direction = {
                    sourceEndpoint: endpoint(packet.sourceAddress, packet.sourcePort),
                    destinationEndpoint: endpoint(packet.destinationAddress, packet.destinationPort),
                    packets: [],
                };
                directions.set(key, direction);
            }
            direction.packets.push(packet);
        }
        const directionResults = [];
        for (const direction of directions.values()) {
            const reassembled = reassembleSegments(direction.packets);
            const framing = bestUnauthenticatedHapOffset(reassembled.buffer);
            const plaintextHttp = parseHttpMessages(reassembled.buffer);
            directionResults.push({
                ...direction,
                packets: undefined,
                packetCount: direction.packets.length,
                payloadBytes: reassembled.buffer.length,
                tcpGaps: reassembled.gaps,
                tcpOverlaps: reassembled.overlaps,
                hapFraming: framing && {
                    offset: framing.offset,
                    recordCount: framing.records.length,
                    plaintextBytes: framing.records.reduce((sum, record) => sum + record.plaintextLength, 0),
                    encryptedBytes: framing.consumedBytes,
                    trailingBytes: framing.trailingBytes,
                },
                plaintextHttp: plaintextHttp.messages.length ? {
                    messages: plaintextHttp.messages,
                    trailingBytes: plaintextHttp.trailingBytes,
                } : undefined,
                _buffer: reassembled.buffer,
            });
        }
        const streamForKey = { directions: directionResults };
        const keyEvent = chooseKeyEvent(keyEvents, streamForKey, stream.firstTimestamp, stream.lastTimestamp);
        const local = keyEvent && keyEndpoint(keyEvent, "local");
        for (const direction of directionResults) {
            if (!keyEvent)
                continue;
            const keyDirection = direction.sourceEndpoint === local
                ? "accessoryToController"
                : "controllerToAccessory";
            const key = keyField(keyEvent, keyDirection);
            if (!key)
                continue;
            const decrypted = decryptHapDirection(direction._buffer, key, countField(keyEvent, keyDirection));
            direction.decryption = {
                attempted: true,
                ok: decrypted.ok,
                error: decrypted.error,
                offset: decrypted.offset,
                recordCount: decrypted.recordCount,
                trailingBytes: decrypted.trailingBytes,
                initialCounter: decrypted.initialCounter,
                finalCounter: decrypted.finalCounter,
            };
            if (decrypted.ok) {
                const parsedHttp = parseHttpMessages(decrypted.plaintext);
                direction.decryption.plaintextBytes = decrypted.plaintext.length;
                direction.decryption.httpMessages = parsedHttp.messages;
                direction.decryption.httpTrailingBytes = parsedHttp.trailingBytes;
                if (options.writePlaintext) {
                    const plaintextDirectory = path.join(options.runDir, "plaintext");
                    ensurePrivateDirectory(plaintextDirectory);
                    const name = `${path.basename(pcapPath).replace(/[^a-z0-9_.-]/gi, "_")}-stream-${stream.stream}-${keyDirection}.bin`;
                    const plaintextPath = path.join(plaintextDirectory, name);
                    writePrivate(plaintextPath, decrypted.plaintext);
                    direction.decryption.plaintextFile = path.relative(options.runDir, plaintextPath);
                }
            }
        }
        for (const direction of directionResults)
            delete direction._buffer;
        streamResults.push({
            stream: stream.stream,
            firstTimestamp: iso(stream.firstTimestamp),
            lastTimestamp: iso(stream.lastTimestamp),
            durationMs: stream.lastTimestamp - stream.firstTimestamp,
            packetCount: stream.packets.length,
            retransmissions: stream.retransmissions,
            outOfOrder: stream.outOfOrder,
            connectionId: keyEvent && String(connectionId(keyEvent)),
            keyMatch: Boolean(keyEvent),
            directions: directionResults,
        });
    }
    const hapLike = streamResults.filter(stream => stream.directions.some(direction => direction.hapFraming
        || direction.plaintextHttp
        || direction.decryption && direction.decryption.ok));
    return {
        file: pcapPath,
        packetCount: packets.length,
        tcpStreamCount: streamResults.length,
        hapLikeStreamCount: hapLike.length,
        streams: hapLike,
        nonHapStreamCount: streamResults.length - hapLike.length,
    };
}

function nearestHomeLogMarkers(resourceRequests, homeLogs) {
    const markers = homeLogs.flatMap(log => log.diagnosticMarkers || []).filter(marker => marker.timestamp);
    return resourceRequests.map(request => {
        const timestamp = request.lastTimestamp;
        if (timestamp === undefined)
            return { ...request };
        let nearest;
        let nearestDelta = Infinity;
        for (const marker of markers) {
            const delta = Math.abs(Date.parse(marker.timestamp) - timestamp);
            if (delta < nearestDelta) {
                nearest = marker;
                nearestDelta = delta;
            }
        }
        return {
            ...request,
            nearestHomeLog: nearest && nearestDelta <= 5000 ? { deltaMs: nearestDelta, ...nearest } : undefined,
        };
    });
}

function correlateResourceBodies(resourceRequests, pcaps) {
    const pcapBodies = [];
    for (const pcap of pcaps) {
        for (const stream of pcap.streams || []) {
            for (const direction of stream.directions || []) {
                for (const source of [direction.plaintextHttp, direction.decryption]) {
                    for (const message of source?.messages || source?.httpMessages || []) {
                        if (!message.body?.jpeg)
                            continue;
                        pcapBodies.push({
                            pcap: pcap.file,
                            stream: stream.stream,
                            source: source === direction.decryption ? "decrypted-external" : "plaintext-loopback",
                            firstLine: message.firstLine,
                            bytes: message.body.bytes,
                            sha256: message.body.sha256,
                            jpegHasSoi: message.body.jpegHasSoi,
                            jpegHasEoi: message.body.jpegHasEoi,
                        });
                    }
                }
            }
        }
    }
    return resourceRequests
        .filter(request => request.resourceResponse?.bodySha256)
        .map(request => {
            const expected = request.resourceResponse.bodySha256;
            const matches = pcapBodies.filter(body => body.sha256 === expected);
            return {
                connectionId: request.connectionId,
                requestId: request.requestId,
                accessory: request.resourceResponse.accessory,
                expectedBodyBytes: request.resourceResponse.bodyBytes,
                expectedBodySha256: expected,
                pcapMatchCount: matches.length,
                pcapMatches: matches,
            };
        });
}

function correlateSnapshotBodies(resourceRequests, snapshotResults) {
    return resourceRequests
        .filter(request => request.resourceResponse?.bodySha256)
        .map(request => {
            const response = request.resourceResponse;
            const exact = snapshotResults.filter(snapshot => snapshot.sha256 === response.bodySha256);
            const responseAt = request.lastTimestamp;
            let nearest;
            if (responseAt !== undefined) {
                nearest = snapshotResults
                    .filter(snapshot => snapshot.timestamp !== undefined)
                    .map(snapshot => ({
                        snapshot,
                        deltaMs: Math.abs(snapshot.timestamp - responseAt),
                    }))
                    .sort((a, b) => a.deltaMs - b.deltaMs)[0];
            }
            return {
                connectionId: request.connectionId,
                requestId: request.requestId,
                accessory: response.accessory,
                responseBodyBytes: response.bodyBytes,
                responseBodySha256: response.bodySha256,
                exactSourceMatchCount: exact.length,
                exactSourceMatches: exact,
                nearestSnapshot: nearest && nearest.deltaMs <= 10_000 ? {
                    deltaMs: nearest.deltaMs,
                    ...nearest.snapshot,
                    hashMatches: nearest.snapshot.sha256 === response.bodySha256,
                } : undefined,
            };
        });
}

function markdownReport(analysis) {
    const lines = [
        "# HomeKit HAP trace analysis",
        "",
        `- Generated: ${analysis.generatedAt}`,
        `- Trace events: ${analysis.events.count}`,
        `- Session-key records loaded: ${analysis.sessionKeys.count} (key bytes are not reported)`,
        `- Home unified-log records: ${analysis.homeLogs.reduce((sum, log) => sum + log.count, 0)}`,
        `- Packet captures: ${analysis.pcaps.length}`,
        `- Resource response anomalies: ${analysis.events.resourceResponseAnomalies.length}`,
        `- Parse/analysis warnings: ${analysis.errors.length}`,
        "",
        "## Event evidence",
        "",
    ];
    const eventTypes = Object.entries(analysis.events.byType).sort((a, b) => b[1] - a[1]);
    if (!eventTypes.length)
        lines.push("No collector events were available.");
    else
        lines.push(...eventTypes.slice(0, 30).map(([type, count]) => `- \`${type}\`: ${count}`));
    lines.push("", "## Resource requests", "");
    if (!analysis.resourceCorrelations.length)
        lines.push("No `/resource` request correlation records were found.");
    else {
        lines.push("| Accessory | Request | Duration | Body | JPEG | Source hash matches | Pcap body matches | Status | Anomalies | Nearest Home marker |", "|---|---:|---:|---:|---|---:|---:|---:|---|---|");
        for (const request of analysis.resourceCorrelations.slice(0, 100)) {
            const response = request.resourceResponse || {};
            const jpeg = response.jpeg || {};
            const marker = request.nearestHomeLog
                ? `${request.nearestHomeLog.deltaMs} ms: ${String(request.nearestHomeLog.message).replace(/\|/g, "\\|").slice(0, 100)}`
                : "";
            const accessory = response.accessory || request.resourceRequest?.accessory || request.connectionId;
            const jpegText = jpeg.soi === undefined
                ? ""
                : `${jpeg.width || "?"}x${jpeg.height || "?"}; SOI ${jpeg.soi}; EOI ${jpeg.eoi}; first ${jpeg.firstMarker || "?"}; JFIF ${jpeg.jfif ?? "?"}; Exif ${jpeg.exif ?? "?"}; ICC ${jpeg.iccProfile ?? "?"}; Adobe ${jpeg.adobe ?? "?"}`;
            const anomalies = (request.responseAnomalies || []).join(", ");
            const pcapMatches = analysis.resourceBodyCorrelations.find(correlation => correlation.connectionId === request.connectionId
                && correlation.requestId === request.requestId)?.pcapMatchCount;
            const sourceMatches = analysis.snapshotBodyCorrelations.find(correlation => correlation.connectionId === request.connectionId
                && correlation.requestId === request.requestId)?.exactSourceMatchCount;
            lines.push(`| ${accessory} | ${request.requestId} | ${request.durationMs ?? ""} ms | ${response.bodyBytes ?? ""} | ${jpegText} | ${sourceMatches ?? ""} | ${pcapMatches ?? ""} | ${response.statusCode ?? request.status ?? ""} | ${anomalies} | ${marker} |`);
        }
    }
    lines.push("", "## Packet captures", "");
    for (const pcap of analysis.pcaps) {
        lines.push(`### ${path.basename(pcap.file)}`, "");
        lines.push(`- TCP packets: ${pcap.packetCount}`);
        lines.push(`- TCP streams: ${pcap.tcpStreamCount}`);
        lines.push(`- HAP-like streams: ${pcap.hapLikeStreamCount}`);
        for (const stream of pcap.streams) {
            const decrypted = stream.directions.filter(direction => direction.decryption && direction.decryption.ok).length;
            const retransmissions = stream.retransmissions ? `, ${stream.retransmissions} retransmissions` : "";
            lines.push(`- Stream ${stream.stream}: ${stream.durationMs.toFixed(1)} ms${retransmissions}, key match ${stream.keyMatch ? "yes" : "no"}, decrypted directions ${decrypted}/${stream.directions.length}`);
        }
        lines.push("");
    }
    if (analysis.errors.length) {
        lines.push("## Warnings", "");
        lines.push(...analysis.errors.map(error => `- ${error}`), "");
    }
    lines.push(
        "## Interpretation guardrails",
        "",
        "- A pcap can only be decrypted when its exact ephemeral HAP session keys and starting record counters were captured.",
        "- `hapFraming` is structural evidence only; authenticated decryption is the proof that a boundary/key/counter match is correct.",
        "- Plaintext bodies are represented by size, SHA-256, and JPEG structure by default. Use `--write-plaintext` only for a bounded private investigation.",
        "",
    );
    return `${lines.join("\n")}\n`;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    ensurePrivateDirectory(options.runDir);
    const errors = [];
    const events = readJsonLines(path.resolve(options.events), errors);
    const keyEvents = readJsonLines(options.keys && path.resolve(options.keys), errors);
    const homeLogs = options.homeLogs.map(file => {
        const resolved = path.resolve(file);
        const records = readJsonLines(resolved, errors, true)
            .filter(record => !(record.finished === 1 && Number.isFinite(record.count)));
        return { file: resolved, ...summarizeHomeLogs(records) };
    });
    const tshark = findExecutable(options.tshark, [
        "tshark",
        "/opt/homebrew/bin/tshark",
        "/usr/local/bin/tshark",
        "/usr/bin/tshark",
    ]);
    const pcaps = [];
    if (options.pcaps.length && !tshark)
        errors.push("tshark was not found; packet captures were not analyzed");
    if (tshark) {
        for (const pcap of options.pcaps) {
            try {
                pcaps.push(analyzePcap(path.resolve(pcap), tshark, keyEvents, options, errors));
            }
            catch (e) {
                errors.push(`${pcap}: ${e.message}`);
            }
        }
    }
    const eventSummary = summarizeEvents(events);
    const analysis = {
        schema: "scrypted-homekit-hap-trace-analysis/v1",
        generatedAt: new Date().toISOString(),
        runDir: options.runDir,
        inputs: {
            events: path.resolve(options.events),
            sessionKeys: options.keys ? path.resolve(options.keys) : undefined,
            homeLogs: options.homeLogs.map(file => path.resolve(file)),
            pcaps: options.pcaps.map(file => path.resolve(file)),
            tshark,
            wrotePlaintext: options.writePlaintext,
        },
        events: eventSummary,
        sessionKeys: {
            count: keyEvents.length,
            connections: [...new Set(keyEvents.map(event => String(connectionId(event))))],
        },
        homeLogs,
        resourceCorrelations: nearestHomeLogMarkers(eventSummary.resourceRequests, homeLogs),
        snapshotBodyCorrelations: correlateSnapshotBodies(eventSummary.resourceRequests, eventSummary.snapshotResults),
        resourceBodyCorrelations: correlateResourceBodies(eventSummary.resourceRequests, pcaps),
        pcaps,
        errors,
    };
    writePrivate(path.resolve(options.outJson), `${JSON.stringify(analysis, null, 2)}\n`);
    writePrivate(path.resolve(options.outMd), markdownReport(analysis));
    process.stdout.write(`${JSON.stringify({
        status: "ok",
        outJson: path.resolve(options.outJson),
        outMd: path.resolve(options.outMd),
        events: events.length,
        sessionKeys: keyEvents.length,
        pcaps: pcaps.length,
        errors: errors.length,
    })}\n`);
}

try {
    main();
}
catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
}
