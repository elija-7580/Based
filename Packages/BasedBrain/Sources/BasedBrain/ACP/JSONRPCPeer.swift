import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Bidirectional JSON-RPC 2.0 peer over newline-delimited JSON (stdio), as used by ACP and MCP stdio servers.
/// The same peer is used for Based→agent (ACP client) and Based→MCP-server (MCP client) connections.
public final class JSONRPCPeer: @unchecked Sendable {
    public typealias RequestHandler = @Sendable (String, JSONValue?) async -> Result<JSONValue, RPCError>
    public typealias NotificationHandler = @Sendable (String, JSONValue?) async -> Void

    public struct RPCError: Error, CustomStringConvertible, Sendable {
        public var code: Int; public var message: String; public var data: JSONValue?
        public init(code: Int, message: String, data: JSONValue? = nil) { self.code = code; self.message = message; self.data = data }
        public var description: String { "RPC \(code): \(message)" }
        public static func methodNotFound(_ m: String) -> RPCError { .init(code: -32601, message: "Method not found: \(m)") }
        public static func invalidParams(_ s: String) -> RPCError { .init(code: -32602, message: s) }
        public static func internalError(_ s: String) -> RPCError { .init(code: -32603, message: s) }
        public var json: JSONValue { var o: [String: JSONValue] = ["code": .number(Double(code)), "message": .string(message)]; if let data { o["data"] = data }; return .object(o) }
    }

    private let lock = NSLock()
    private let idCounter = Locked(0)
    private var pending: [Int: CheckedContinuation<JSONValue, Error>] = [:]
    private let write: @Sendable (Data) -> Void
    public var onRequest: RequestHandler?
    public var onNotification: NotificationHandler?
    public var onClose: (@Sendable () -> Void)?
    public var log: (@Sendable (String) -> Void)?
    private var buffer = Data()

    public init(write: @escaping @Sendable (Data) -> Void) { self.write = write }

    // MARK: Outgoing

    public func request(_ method: String, _ params: JSONValue? = nil) async throws -> JSONValue {
        let id = idCounter.sync { v -> Int in v += 1; return v }
        var msg: [String: JSONValue] = ["jsonrpc": "2.0", "id": .number(Double(id)), "method": .string(method)]
        if let params { msg["params"] = params }
        return try await withCheckedThrowingContinuation { cont in
            lock.lock(); pending[id] = cont; lock.unlock()
            send(.object(msg))
        }
    }

    public func notify(_ method: String, _ params: JSONValue? = nil) {
        var msg: [String: JSONValue] = ["jsonrpc": "2.0", "method": .string(method)]
        if let params { msg["params"] = params }
        send(.object(msg))
    }

    private func send(_ v: JSONValue) {
        guard var data = try? v.encoded() else { return }
        data.append(0x0A)
        log?("→ \(String(decoding: data.prefix(300), as: UTF8.self))")
        write(data)
    }

    // MARK: Incoming

    /// Feed raw bytes from the transport; complete lines are dispatched.
    public func receive(_ chunk: Data) {
        lock.lock(); buffer.append(chunk)
        var lines: [Data] = []
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer[buffer.startIndex..<nl]
            if !line.isEmpty { lines.append(Data(line)) }
            buffer.removeSubrange(buffer.startIndex...nl)
        }
        lock.unlock()
        for l in lines { dispatch(l) }
    }

    public func closed() {
        lock.lock(); let conts = pending.values; pending.removeAll(); lock.unlock()
        for c in conts { c.resume(throwing: RPCError(code: -32000, message: "Connection closed")) }
        onClose?()
    }

    private func dispatch(_ line: Data) {
        log?("← \(String(decoding: line.prefix(300), as: UTF8.self))")
        guard let m = try? JSONValue.parse(line) else { return }
        if let method = m["method"]?.string {
            if let idv = m["id"], !idv.isNull {
                Task { [weak self] in
                    guard let self else { return }
                    let result = await self.onRequest?(method, m["params"]) ?? .failure(.methodNotFound(method))
                    var reply: [String: JSONValue] = ["jsonrpc": "2.0", "id": idv]
                    switch result { case .success(let v): reply["result"] = v; case .failure(let e): reply["error"] = e.json }
                    self.send(.object(reply))
                }
            } else {
                Task { [weak self] in await self?.onNotification?(method, m["params"]) }
            }
        } else if let id = m["id"]?.int {
            lock.lock(); let cont = pending.removeValue(forKey: id); lock.unlock()
            if let err = m["error"] { cont?.resume(throwing: RPCError(code: err["code"]?.int ?? -1, message: err["message"]?.string ?? "error", data: err["data"])) }
            else { cont?.resume(returning: m["result"] ?? .null) }
        }
    }
}

/// Launches a child process and connects a JSON-RPC peer to its stdio. macOS/Linux only (iOS talks to a daemon instead).
public final class ProcessTransport: @unchecked Sendable {
    public let peer: JSONRPCPeer
    #if os(macOS) || os(Linux)
    private let process = Process()
    private let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
    #endif
    public private(set) var isRunning = false
    public var stderrLog: (@Sendable (String) -> Void)?

    public init(command: String, arguments: [String] = [], environment: [String: String] = [:], cwd: String? = nil) throws {
        #if os(macOS) || os(Linux)
        let stdinHandle = stdin.fileHandleForWriting
        peer = JSONRPCPeer { data in stdinHandle.write(data) }
        process.executableURL = URL(fileURLWithPath: Self.resolve(command))
        process.arguments = arguments
        var env = ProcessInfo.processInfo.environment
        for (k, v) in environment { env[k] = v }
        process.environment = env
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        process.standardInput = stdin; process.standardOutput = stdout; process.standardError = stderr
        let p = peer
        stdout.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil; p.closed() } else { p.receive(d) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { self?.stderrLog?(String(decoding: d, as: UTF8.self)) }
        }
        process.terminationHandler = { [weak self] _ in self?.isRunning = false; p.closed() }
        try process.run()
        isRunning = true
        #else
        throw JSONRPCPeer.RPCError(code: -32000, message: "Local agent processes are not available on this platform. Connect a Based server daemon instead.")
        #endif
    }

    public func terminate() {
        #if os(macOS) || os(Linux)
        if process.isRunning { process.terminate() }
        try? stdin.fileHandleForWriting.close()
        #endif
        isRunning = false
    }

    /// Resolve a bare command name through PATH plus common user locations (Homebrew, nvm, volta, cargo).
    public static func resolve(_ command: String) -> String {
        if command.hasPrefix("/") || command.hasPrefix(".") { return command }
        let home = ProcessInfo.processInfo.environment["HOME"] ?? NSHomeDirectory()
        var dirs = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        dirs += ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.volta/bin", "\(home)/.cargo/bin", "\(home)/.bun/bin", "/usr/bin", "/bin"]
        if let nvm = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.nvm/versions/node") {
            dirs += nvm.sorted().reversed().map { "\(home)/.nvm/versions/node/\($0)/bin" }
        }
        for d in dirs where FileManager.default.isExecutableFile(atPath: "\(d)/\(command)") { return "\(d)/\(command)" }
        return command
    }
}
