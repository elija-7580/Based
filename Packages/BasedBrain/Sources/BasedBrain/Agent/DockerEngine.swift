import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

// BSD-106: the Docker Engine API over its Unix socket (`/var/run/docker.sock`, HTTP/JSON) as a second runner for
// container sandboxes — the server image then needs no docker CLI for create / exec / snapshot / restore / destroy.
// The calls happen in the same order as the CLI provider's. Environment values of `exec` travel in the request body
// over the socket (never in argv). Long-running interactive agents (`wrap`) still use `docker exec -i` (stdio over
// a hijacked API connection is a follow-up).

/// One HTTP exchange with the Docker Engine.
public struct DockerAPIResponse: Sendable, Equatable {
    public var status: Int
    public var headers: [String: String]
    public var body: Data
    public init(status: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.status = status; self.headers = headers; self.body = body
    }
    public var json: JSONValue? { try? JSONValue.parse(body) }
}

public protocol DockerAPITransport: Sendable {
    func send(_ method: String, _ path: String, body: JSONValue?) async throws -> DockerAPIResponse
}

/// HTTP/1.1 over a Unix domain socket, one connection per request (`Connection: close`).
public struct UnixSocketHTTPTransport: DockerAPITransport {
    public var socketPath: String
    /// Prefix for every path, e.g. "/v1.43" (empty = the daemon's default version).
    public var apiVersion: String
    public var timeout: TimeInterval

    public init(socketPath: String = "/var/run/docker.sock", apiVersion: String = "/v1.43", timeout: TimeInterval = 600) {
        self.socketPath = socketPath; self.apiVersion = apiVersion; self.timeout = timeout
    }

    public func send(_ method: String, _ path: String, body: JSONValue?) async throws -> DockerAPIResponse {
        let payload = try body.map { try $0.encoded() } ?? Data()
        var head = "\(method) \(apiVersion)\(path) HTTP/1.1\r\nHost: docker\r\nUser-Agent: Based\r\nConnection: close\r\n"
        if body != nil { head += "Content-Type: application/json\r\n" }
        head += "Content-Length: \(payload.count)\r\n\r\n"
        let request = Data(head.utf8) + payload
        let (socketPath, timeout) = (self.socketPath, self.timeout)
        return try await withCheckedThrowingContinuation { cont in
            DispatchQueue.global(qos: .utility).async {
                do { cont.resume(returning: try Self.parse(try Self.exchange(socketPath, request, timeout: timeout))) }
                catch { cont.resume(throwing: error) }
            }
        }
    }

    /// Writes `request`, reads until the daemon closes the connection.
    static func exchange(_ path: String, _ request: Data, timeout: TimeInterval) throws -> Data {
        #if canImport(Glibc)
        let fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
        #else
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        #endif
        guard fd >= 0 else { throw SandboxError.unavailable("socket() failed") }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        let capacity = MemoryLayout.size(ofValue: addr.sun_path)
        guard bytes.count < capacity else { throw SandboxError.unavailable("socket path too long: \(path)") }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = b }
            raw[bytes.count] = 0
        }
        let ok = withUnsafePointer(to: &addr) { p in
            p.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { throw SandboxError.unavailable("Docker is not reachable at \(path)") }
        try request.withUnsafeBytes { raw in
            var sent = 0
            while sent < raw.count {
                let n = write(fd, raw.baseAddress! + sent, raw.count - sent)
                guard n > 0 else { throw SandboxError.unavailable("write to \(path) failed") }
                sent += n
            }
        }
        var out = Data()
        var buf = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = read(fd, &buf, buf.count)
            if n > 0 { out.append(buf, count: n) } else { break }
        }
        return out
    }

    /// Status line, headers and body (chunked transfer encoding decoded).
    static func parse(_ raw: Data) throws -> DockerAPIResponse {
        guard let sep = raw.range(of: Data("\r\n\r\n".utf8)) else { throw SandboxError.unavailable("malformed HTTP response from Docker") }
        let head = String(decoding: raw[raw.startIndex..<sep.lowerBound], as: UTF8.self).components(separatedBy: "\r\n")
        let statusParts = head.first?.split(separator: " ") ?? []
        guard statusParts.count >= 2, let status = Int(statusParts[1]) else { throw SandboxError.unavailable("malformed HTTP status from Docker") }
        var headers: [String: String] = [:]
        for line in head.dropFirst() {
            guard let c = line.firstIndex(of: ":") else { continue }
            headers[line[..<c].lowercased()] = line[line.index(after: c)...].trimmingCharacters(in: .whitespaces)
        }
        var body = Data(raw[sep.upperBound...])
        if headers["transfer-encoding"]?.lowercased().contains("chunked") == true { body = dechunk(body) }
        else if let len = headers["content-length"].flatMap(Int.init), body.count > len { body = body.prefix(len) }
        return DockerAPIResponse(status: status, headers: headers, body: body)
    }

    static func dechunk(_ data: Data) -> Data {
        var out = Data()
        var i = data.startIndex
        while i < data.endIndex {
            guard let lineEnd = data[i...].range(of: Data("\r\n".utf8)) else { break }
            let sizeText = String(decoding: data[i..<lineEnd.lowerBound], as: UTF8.self).split(separator: ";").first ?? ""
            guard let size = Int(sizeText.trimmingCharacters(in: .whitespaces), radix: 16), size > 0 else { break }
            let start = lineEnd.upperBound
            let end = min(data.endIndex, start + size)
            out.append(data[start..<end])
            i = min(data.endIndex, end + 2)
        }
        return out
    }
}

/// Docker's multiplexed stdout/stderr stream (`exec` without a TTY): 8-byte frame headers [type,0,0,0,size BE].
enum DockerStream {
    static func demux(_ data: Data) -> (stdout: String, stderr: String) {
        var out = Data(), err = Data()
        let b = [UInt8](data)
        var i = 0
        while i + 8 <= b.count {
            let type = b[i]
            let size = Int(b[i + 4]) << 24 | Int(b[i + 5]) << 16 | Int(b[i + 6]) << 8 | Int(b[i + 7])
            let start = i + 8, end = min(b.count, start + size)
            guard type <= 2 else { return (String(decoding: data, as: UTF8.self), "") }   // not multiplexed (TTY)
            if type == 2 { err.append(contentsOf: b[start..<end]) } else { out.append(contentsOf: b[start..<end]) }
            i = end
        }
        return (String(decoding: out, as: UTF8.self), String(decoding: err, as: UTF8.self))
    }
}

/// Container sandboxes through the Docker Engine API (same behaviour as `DockerSandboxProvider`).
public struct DockerEngineSandboxProvider: SandboxProvider {
    public let kind = "docker"
    public var api: DockerAPITransport
    /// Still used for workspace archives (tar) and for `wrap` (`docker exec -i`).
    public var cli: DockerSandboxProvider

    public init(api: DockerAPITransport, cli: DockerSandboxProvider) { self.api = api; self.cli = cli }

    private func call(_ method: String, _ path: String, _ body: JSONValue? = nil, ok: Set<Int> = [200, 201, 204]) async throws -> DockerAPIResponse {
        let r = try await api.send(method, path, body: body)
        guard ok.contains(r.status) else {
            let message = r.json?["message"]?.string ?? String(decoding: r.body.prefix(300), as: UTF8.self)
            throw SandboxError.commandFailed(command: "\(method) \(path.split(separator: "?").first ?? "")", exitCode: Int32(r.status), stderr: message)
        }
        return r
    }

    static func query(_ items: [(String, String)]) -> String {
        var allowed = CharacterSet.alphanumerics; allowed.insert(charactersIn: "-._~")
        return items.map { "\($0.0)=\($0.1.addingPercentEncoding(withAllowedCharacters: allowed) ?? $0.1)" }.joined(separator: "&")
    }

    /// The `docker run` options of `runArguments` as a create body.
    public func createBody(_ spec: SandboxSpec, image: String? = nil) -> JSONValue {
        let wd = DockerSandboxProvider.workdir(spec.project)
        var labels: [String: JSONValue] = ["based.sandbox": "1", "based.project": .string(SandboxNames.slug(spec.project))]
        if let run = spec.runID { labels["based.run"] = .string(run) }
        var binds: [JSONValue] = [.string("\(spec.hostWorkspace):\(wd)")]
        for m in spec.readOnlyMounts { binds.append(.string("\(m.host):\(m.container):ro")) }
        var host: [String: JSONValue] = [
            "Init": true, "NanoCpus": .number(Double(Int(spec.cpus * 1_000_000_000))), "Memory": .number(Double(spec.memoryMB * 1024 * 1024)),
            "PidsLimit": 1024, "SecurityOpt": ["no-new-privileges"], "Binds": .array(binds),
        ]
        if !spec.network { host["NetworkMode"] = "none" }
        if spec.network && spec.hostGateway { host["ExtraHosts"] = [.string("\(SandboxMCP.hostName):host-gateway")] }
        return ["Image": .string(image ?? spec.image), "Cmd": ["sleep", "infinity"], "WorkingDir": .string(wd),
                "Labels": .object(labels), "HostConfig": .object(host)]
    }

    private func createAndStart(_ spec: SandboxSpec, image: String? = nil, name: String) async throws -> String {
        let r = try await call("POST", "/containers/create?" + Self.query([("name", name)]), createBody(spec, image: image))
        guard let id = r.json?["Id"]?.string, !id.isEmpty else { throw SandboxError.unavailable("Docker returned no container id") }
        _ = try await call("POST", "/containers/\(id)/start", ok: [204, 304])
        return id
    }

    public func create(_ spec: SandboxSpec) async throws -> SandboxHandle {
        let suffix = spec.runID.map(SandboxNames.slug) ?? String(UUID().uuidString.prefix(8)).lowercased()
        let id = try await createAndStart(spec, name: "based-\(SandboxNames.slug(spec.project))-\(suffix.prefix(24))")
        return SandboxHandle(provider: kind, id: id, project: spec.project, workdir: DockerSandboxProvider.workdir(spec.project),
                             hostWorkspace: spec.hostWorkspace, image: spec.image)
    }

    public func exec(_ sandbox: SandboxHandle, _ command: [String], environment: [String: String]) async throws -> SandboxExecResult {
        let env: [JSONValue] = environment.keys.sorted().map { .string("\($0)=\(environment[$0]!)") }
        let created = try await call("POST", "/containers/\(sandbox.id)/exec",
                                     ["AttachStdout": true, "AttachStderr": true, "Tty": false, "WorkingDir": .string(sandbox.workdir),
                                      "Env": .array(env), "Cmd": .array(command.map(JSONValue.string))])
        guard let execID = created.json?["Id"]?.string else { throw SandboxError.unavailable("Docker returned no exec id") }
        let started = try await call("POST", "/exec/\(execID)/start", ["Detach": false, "Tty": false])
        let (out, err) = DockerStream.demux(started.body)
        let info = try await call("GET", "/exec/\(execID)/json")
        let code = Int32(info.json?["ExitCode"]?.int ?? -1)
        return SandboxExecResult(exitCode: code, stdout: out, stderr: err)
    }

    public func wrap(_ agent: AgentDefinition, in sandbox: SandboxHandle, environment: [String: String]) -> AgentDefinition {
        cli.wrap(agent, in: sandbox, environment: environment)
    }

    public func snapshot(_ sandbox: SandboxHandle, name: String) async throws -> SandboxHandle {
        guard SandboxNames.validSnapshot(name) else { throw SandboxError.invalidName(name) }
        let image = cli.snapshotImage(sandbox, name)
        let (repo, tag) = (String(image.split(separator: ":").first ?? ""), name)
        _ = try await call("POST", "/commit?" + Self.query([("container", sandbox.id), ("repo", repo), ("tag", tag),
                                                            ("comment", "Based snapshot \(name)"), ("pause", "true")]))
        let archive = cli.archivePath(sandbox, name)
        try await LocalSandboxProvider.archive(sandbox.hostWorkspace, to: archive, runner: cli.runner, env: cli.baseEnvironment)
        var h = sandbox
        h.snapshots.removeAll { $0.name == name }
        h.snapshots.append(SandboxSnapshot(name: name, image: image, archive: archive, createdAt: cli.now()))
        return h
    }

    public func restore(_ sandbox: SandboxHandle, snapshot name: String) async throws -> SandboxHandle {
        guard let snap = sandbox.snapshots.first(where: { $0.name == name }) else { throw SandboxError.unknownSnapshot(name) }
        _ = try await call("DELETE", "/containers/\(sandbox.id)?force=true", ok: [204, 404])
        try await LocalSandboxProvider.unarchive(snap.archive, into: sandbox.hostWorkspace, runner: cli.runner, env: cli.baseEnvironment, now: cli.now())
        let spec = SandboxSpec(project: sandbox.project, hostWorkspace: sandbox.hostWorkspace, image: snap.image)
        let id = try await createAndStart(spec, image: snap.image,
                                          name: "based-\(SandboxNames.slug(sandbox.project))-\(SandboxNames.slug(name))-\(Int(cli.now().timeIntervalSince1970))")
        var h = sandbox
        h.id = id
        h.image = snap.image
        return h
    }

    public func destroy(_ sandbox: SandboxHandle) async throws {
        _ = try await call("DELETE", "/containers/\(sandbox.id)?force=true", ok: [204, 404])
    }
}
