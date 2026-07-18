import AppKit
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

private let homeBundleIdentifiers = ["com.apple.Home", "com.apple.home"]

private struct DriverError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) {
        self.description = description
    }
}

private func jsonObject(_ value: [String: Any]) throws -> String {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    return String(decoding: data, as: UTF8.self)
}

private func jsonLine(_ value: [String: Any]) throws -> Data {
    var data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    data.append(0x0a)
    return data
}

private func emit(_ value: [String: Any]) {
    do {
        print(try jsonObject(value))
    }
    catch {
        fputs("{\"ok\":false,\"error\":\"json encoding failed\"}\n", stderr)
    }
}

private func fail(_ message: String, code: Int32 = 1) -> Never {
    emit(["ok": false, "error": message])
    exit(code)
}

private struct BrokerRequest: Decodable {
    let arguments: [String]
}

private let maximumBrokerMessageBytes = 64 * 1024

private func systemError(_ operation: String) -> DriverError {
    DriverError("\(operation) failed: \(String(cString: strerror(errno)))")
}

private func validatePrivateSocketParent(_ socketPath: String) throws {
    let parent = URL(fileURLWithPath: socketPath).deletingLastPathComponent().path
    var metadata = stat()
    guard lstat(parent, &metadata) == 0 else {
        throw systemError("lstat broker directory")
    }
    guard metadata.st_uid == geteuid() else {
        throw DriverError("broker directory is not owned by the current user")
    }
    guard metadata.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR) else {
        throw DriverError("broker socket parent is not a directory")
    }
    guard metadata.st_mode & 0o077 == 0 else {
        throw DriverError("broker directory must not be accessible by group or other users")
    }
}

private func makeListeningSocket(path: String) throws -> Int32 {
    guard path.hasPrefix("/") else {
        throw DriverError("broker socket path must be absolute")
    }
    try validatePrivateSocketParent(path)
    var existing = stat()
    guard lstat(path, &existing) != 0 else {
        throw DriverError("broker socket path already exists")
    }
    guard errno == ENOENT else {
        throw systemError("lstat broker socket")
    }

    let descriptor = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else {
        throw systemError("socket")
    }
    do {
        guard fcntl(descriptor, F_SETFD, FD_CLOEXEC) == 0 else {
            throw systemError("fcntl")
        }
        var address = sockaddr_un()
        let pathCapacity = MemoryLayout.size(ofValue: address.sun_path)
        guard path.utf8.count < pathCapacity else {
            throw DriverError("broker socket path is too long")
        }
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: pathCapacity) { destination in
                path.withCString { source in
                    _ = strlcpy(destination, source, pathCapacity)
                }
            }
        }
        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.bind(descriptor, socketAddress, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            throw systemError("bind")
        }
        guard chmod(path, 0o600) == 0 else {
            throw systemError("chmod broker socket")
        }
        guard Darwin.listen(descriptor, 8) == 0 else {
            throw systemError("listen")
        }
        return descriptor
    }
    catch {
        Darwin.close(descriptor)
        _ = unlink(path)
        throw error
    }
}

private func acceptConnection(_ descriptor: Int32) async throws -> Int32 {
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            while true {
                let connection = Darwin.accept(descriptor, nil, nil)
                if connection >= 0 {
                    _ = fcntl(connection, F_SETFD, FD_CLOEXEC)
                    var noSigPipe: Int32 = 1
                    _ = withUnsafePointer(to: &noSigPipe) { pointer in
                        setsockopt(
                            connection,
                            SOL_SOCKET,
                            SO_NOSIGPIPE,
                            pointer,
                            socklen_t(MemoryLayout<Int32>.size)
                        )
                    }
                    continuation.resume(returning: connection)
                    return
                }
                if errno != EINTR {
                    continuation.resume(throwing: systemError("accept"))
                    return
                }
            }
        }
    }
}

private func readBrokerRequest(_ descriptor: Int32) async throws -> BrokerRequest {
    let data: Data = try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            var data = Data()
            var byte: UInt8 = 0
            while data.count <= maximumBrokerMessageBytes {
                let count = Darwin.read(descriptor, &byte, 1)
                if count == 1 {
                    if byte == 0x0a {
                        continuation.resume(returning: data)
                        return
                    }
                    data.append(byte)
                    continue
                }
                if count == 0 {
                    continuation.resume(throwing: DriverError("broker request ended before newline"))
                    return
                }
                if errno != EINTR {
                    continuation.resume(throwing: systemError("read broker request"))
                    return
                }
            }
            continuation.resume(throwing: DriverError("broker request exceeds size limit"))
        }
    }
    do {
        return try JSONDecoder().decode(BrokerRequest.self, from: data)
    }
    catch {
        throw DriverError("invalid broker request JSON")
    }
}

private func writeBrokerResponse(_ value: [String: Any], to descriptor: Int32) async throws {
    let data = try jsonLine(value)
    try await withCheckedThrowingContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            do {
                try data.withUnsafeBytes { rawBuffer in
                    guard let base = rawBuffer.baseAddress else {
                        return
                    }
                    var written = 0
                    while written < rawBuffer.count {
                        let count = Darwin.write(
                            descriptor,
                            base.advanced(by: written),
                            rawBuffer.count - written
                        )
                        if count > 0 {
                            written += count
                            continue
                        }
                        if count < 0 && errno == EINTR {
                            continue
                        }
                        throw systemError("write broker response")
                    }
                }
                continuation.resume()
            }
            catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

private func homeApplication() -> NSRunningApplication? {
    for identifier in homeBundleIdentifiers {
        if let application = NSRunningApplication.runningApplications(withBundleIdentifier: identifier).first {
            return application
        }
    }
    return nil
}

private func activateHome() throws -> NSRunningApplication {
    guard let application = homeApplication() else {
        throw DriverError("Home is not running in the active login session")
    }
    if !application.activate(options: [.activateAllWindows]) {
        throw DriverError("Home could not be activated")
    }
    return application
}

private func requestAccessibilityPermission() -> Bool {
    let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
    return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
}

private func permissionStatus(request: Bool) -> [String: Any] {
    let accessibility = request ? requestAccessibilityPermission() : AXIsProcessTrusted()
    let screenRecording = request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess()
    return [
        "ok": true,
        "bundleIdentifier": Bundle.main.bundleIdentifier ?? NSNull(),
        "accessibility": accessibility,
        "screenRecording": screenRecording,
        "homeRunning": homeApplication() != nil,
    ]
}

private func homeWindow() async throws -> SCWindow {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { window in
        guard window.isOnScreen, window.frame.width >= 320, window.frame.height >= 240 else {
            return false
        }
        guard let identifier = window.owningApplication?.bundleIdentifier else {
            return false
        }
        return homeBundleIdentifiers.contains(identifier)
    }
    guard let window = candidates.max(by: {
        $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
    }) else {
        throw DriverError("No on-screen Home window was found")
    }
    return window
}

private func captureHomeWindow(path: String) async throws -> [String: Any] {
    guard CGPreflightScreenCaptureAccess() else {
        throw DriverError("Screen Recording permission is not granted")
    }
    let window = try await homeWindow()
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let configuration = SCStreamConfiguration()
    let scale = NSScreen.main?.backingScaleFactor ?? 2
    configuration.width = max(1, Int(window.frame.width * scale))
    configuration.height = max(1, Int(window.frame.height * scale))
    configuration.showsCursor = false
    configuration.captureResolution = .best
    let image = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: configuration
    )

    let output = URL(fileURLWithPath: path)
    let parent = output.deletingLastPathComponent()
    try FileManager.default.createDirectory(
        at: parent,
        withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700]
    )
    guard let destination = CGImageDestinationCreateWithURL(
        output as CFURL,
        UTType.png.identifier as CFString,
        1,
        nil
    ) else {
        throw DriverError("Could not create PNG destination")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw DriverError("Could not finalize PNG")
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path)
    return [
        "ok": true,
        "path": output.path,
        "windowId": window.windowID,
        "title": window.title ?? "",
        "width": image.width,
        "height": image.height,
        "frame": [
            "x": window.frame.origin.x,
            "y": window.frame.origin.y,
            "width": window.frame.width,
            "height": window.frame.height,
        ],
    ]
}

private func postKey(_ key: String) async throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw DriverError("Accessibility permission is not granted")
    }
    let codes: [String: CGKeyCode] = [
        "up": 126,
        "down": 125,
        "pageup": 116,
        "pagedown": 121,
        "home": 115,
        "end": 119,
    ]
    guard let code = codes[key.lowercased()] else {
        throw DriverError("Unsupported key: \(key)")
    }
    _ = try activateHome()
    try await Task.sleep(for: .milliseconds(150))
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else {
        throw DriverError("Could not create keyboard event")
    }
    down.post(tap: .cghidEventTap)
    up.post(tap: .cghidEventTap)
    return ["ok": true, "key": key.lowercased()]
}

private func postScroll(_ amount: Int32) async throws -> [String: Any] {
    guard AXIsProcessTrusted() else {
        throw DriverError("Accessibility permission is not granted")
    }
    _ = try activateHome()
    try await Task.sleep(for: .milliseconds(150))
    let window = try await homeWindow()
    let point = CGPoint(x: window.frame.midX, y: window.frame.midY)
    CGWarpMouseCursorPosition(point)
    guard let source = CGEventSource(stateID: .hidSystemState),
          let event = CGEvent(
            scrollWheelEvent2Source: source,
            units: .pixel,
            wheelCount: 1,
            wheel1: amount,
            wheel2: 0,
            wheel3: 0
          ) else {
        throw DriverError("Could not create scroll event")
    }
    event.location = point
    event.post(tap: .cghidEventTap)
    return [
        "ok": true,
        "amount": amount,
        "x": point.x,
        "y": point.y,
    ]
}

@MainActor
private func initializeAquaApplication() {
    // Creating NSApplication explicitly initializes the WindowServer/CGS
    // connection. Launching a command-line-style app through Launch Services
    // alone is not sufficient before the first ScreenCaptureKit call.
    let application = NSApplication.shared
    _ = application.setActivationPolicy(.accessory)
    application.finishLaunching()
}

@MainActor
private func performCommand(_ arguments: [String]) async throws -> [String: Any] {
    guard let command = arguments.first else {
        throw DriverError(
            "usage: home-preview-ui-driver status [--request] | activate | "
            + "capture PATH | key NAME | scroll PIXELS | broker SOCKET"
        )
    }
    switch command {
    case "ping":
        return ["ok": true, "pid": getpid()]
    case "status":
        return permissionStatus(request: arguments.dropFirst().contains("--request"))
    case "activate":
        let application = try activateHome()
        return ["ok": true, "pid": application.processIdentifier]
    case "capture":
        guard arguments.count == 2 else {
            throw DriverError("capture requires an output path")
        }
        return try await captureHomeWindow(path: arguments[1])
    case "key":
        guard arguments.count == 2 else {
            throw DriverError("key requires a key name")
        }
        return try await postKey(arguments[1])
    case "scroll":
        guard arguments.count == 2, let amount = Int32(arguments[1]) else {
            throw DriverError("scroll requires a signed pixel count")
        }
        return try await postScroll(amount)
    default:
        throw DriverError("unknown command: \(command)")
    }
}

@MainActor
private func runBroker(socketPath: String) async throws {
    let listeningSocket = try makeListeningSocket(path: socketPath)
    defer {
        Darwin.close(listeningSocket)
        _ = unlink(socketPath)
    }
    while true {
        let connection = try await acceptConnection(listeningSocket)
        var shouldStop = false
        do {
            let request = try await readBrokerRequest(connection)
            if request.arguments == ["shutdown"] {
                shouldStop = true
                try await writeBrokerResponse(
                    ["ok": true, "pid": getpid(), "shutdown": true],
                    to: connection
                )
            }
            else {
                do {
                    var response = try await performCommand(request.arguments)
                    response["brokerPid"] = getpid()
                    try await writeBrokerResponse(response, to: connection)
                }
                catch {
                    try await writeBrokerResponse(
                        ["ok": false, "error": String(describing: error), "brokerPid": getpid()],
                        to: connection
                    )
                }
            }
        }
        catch {
            try? await writeBrokerResponse(
                ["ok": false, "error": String(describing: error), "brokerPid": getpid()],
                to: connection
            )
        }
        Darwin.close(connection)
        if shouldStop {
            return
        }
    }
}

@main
private struct HomePreviewUIDriver {
    @MainActor
    static func main() async {
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard let command = arguments.first else {
            fail(
                "usage: home-preview-ui-driver status [--request] | activate | "
                + "capture PATH | key NAME | scroll PIXELS | broker SOCKET",
                code: 2
            )
        }
        initializeAquaApplication()
        do {
            if command == "broker" {
                guard arguments.count == 2 else {
                    throw DriverError("broker requires an absolute Unix socket path")
                }
                try await runBroker(socketPath: arguments[1])
            }
            else {
                emit(try await performCommand(arguments))
            }
        }
        catch {
            fail(String(describing: error))
        }
    }
}
