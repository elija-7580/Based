import Foundation
import Testing
import BasedCore
@testable import BasedBrain
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// BSD-106: the Docker Engine API runner (fake transport, a real fake Unix-socket server, and — only with
/// BASED_DOCKER_TESTS=1 — a real Docker daemon).

private final class Recorder: CommandRunner, DockerAPITransport, @unchecked Sendable {
    struct Request: Equatable { var method: String; var path: String; var body: JSONValue? }
    private let lock = NSLock()
    private(set) var steps: [String] = []
    private(set) var requests: [Request] = []
    private var counter = 0

    func run(_ executable: String, _ arguments: [String], environment: [String: String], cwd: String?) async throws -> SandboxExecResult {
        lock.lock(); defer { lock.unlock() }
        steps.append(arguments.first == "-p" ? "mkdir" : (arguments.first ?? executable))
        return SandboxExecResult(exitCode: 0)
    }

    func send(_ method: String, _ path: String, body: JSONValue?) async throws -> DockerAPIResponse {
        lock.lock(); defer { lock.unlock() }
        requests.append(Request(method: method, path: path, body: body))
        let p = path.split(separator: "?").first.map(String.init) ?? path
        if p == "/containers/create" { counter += 1; steps.append("create"); return DockerAPIResponse(status: 201, body: Data("{\"Id\":\"c0ffee\(counter)\"}".utf8)) }
        if p.hasSuffix("/start") { steps.append("start"); return DockerAPIResponse(status: 204) }
        if p == "/commit" { steps.append("commit"); return DockerAPIResponse(status: 201, body: Data("{\"Id\":\"sha256:1\"}".utf8)) }
        if method == "DELETE" { steps.append("rm"); return DockerAPIResponse(status: 204) }
        return DockerAPIResponse(status: 404, body: Data("{\"message\":\"no such thing\"}".utf8))
    }
}

private func engine(_ r: Recorder) -> DockerEngineSandboxProvider {
    DockerEngineSandboxProvider(api: r, cli: DockerSandboxProvider(runner: r, snapshotDirectory: "/srv/based/snaps", baseEnvironment: ["PATH": "/usr/bin"],
                                                                   now: { Date(timeIntervalSince1970: 1_800_000_000) }))
}

private let spec = SandboxSpec(project: "Based App", hostWorkspace: "/srv/projects/based", image: "based-sandbox:1", cpus: 2, memoryMB: 4096,
                               network: false, readOnlyMounts: [(host: "/home/based/.claude", container: "/root/.claude")], runID: "run42")

/// Serves canned HTTP responses on a Unix socket, one connection per request (like the Docker daemon with
/// `Connection: close`), and records the raw requests.
private final class FakeDockerSocket: @unchecked Sendable {
    let path: String
    private let fd: Int32
    private let lock = NSLock()
    private var _requests: [String] = []
    var requests: [String] { lock.lock(); defer { lock.unlock() }; return _requests }

    init(responses: @escaping @Sendable (String) -> Data) throws {
        path = "/tmp/based-dk-\(UUID().uuidString.prefix(8)).sock"
        #if canImport(Glibc)
        fd = socket(AF_UNIX, Int32(SOCK_STREAM.rawValue), 0)
        #else
        fd = socket(AF_UNIX, SOCK_STREAM, 0)
        #endif
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in for (i, b) in bytes.enumerated() { raw[i] = b }; raw[bytes.count] = 0 }
        let ok = withUnsafePointer(to: &addr) { p in p.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
        guard ok == 0, listen(fd, 8) == 0 else { throw SandboxError.unavailable("bind failed") }
        let server = fd
        Thread.detachNewThread { [weak self] in
            while true {
                let c = accept(server, nil, nil)
                guard c >= 0 else { return }
                var data = Data()
                var buf = [UInt8](repeating: 0, count: 4096)
                // Read headers, then Content-Length bytes of body.
                while true {
                    let n = read(c, &buf, buf.count)
                    if n <= 0 { break }
                    data.append(buf, count: n)
                    if let sep = data.range(of: Data("\r\n\r\n".utf8)) {
                        let head = String(decoding: data[..<sep.lowerBound], as: UTF8.self)
                        let len = head.components(separatedBy: "\r\n").first { $0.lowercased().hasPrefix("content-length:") }
                            .flatMap { Int($0.split(separator: ":")[1].trimmingCharacters(in: .whitespaces)) } ?? 0
                        if data.count - sep.upperBound >= len { break }
                    }
                }
                let request = String(decoding: data, as: UTF8.self)
                self?.lock.lock(); self?._requests.append(request); self?.lock.unlock()
                let reply = responses(request)
                reply.withUnsafeBytes { raw in _ = write(c, raw.baseAddress!, raw.count) }
                close(c)
            }
        }
    }

    func stop() { shutdown(fd, Int32(SHUT_RDWR)); close(fd); unlink(path) }
}

private func http(_ status: String, _ body: Data, chunked: Bool = false, type: String = "application/json") -> Data {
    if chunked {
        let half = body.count / 2
        var d = Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nTransfer-Encoding: chunked\r\n\r\n".utf8)
        for part in [body.prefix(half), body.dropFirst(half)] where !part.isEmpty {
            d += Data((String(part.count, radix: 16) + "\r\n").utf8) + part + Data("\r\n".utf8)
        }
        return d + Data("0\r\n\r\n".utf8)
    }
    return Data("HTTP/1.1 \(status)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n\r\n".utf8) + body
}

private func frame(_ type: UInt8, _ s: String) -> Data {
    let b = Array(s.utf8)
    return Data([type, 0, 0, 0, UInt8(b.count >> 24 & 0xff), UInt8(b.count >> 16 & 0xff), UInt8(b.count >> 8 & 0xff), UInt8(b.count & 0xff)] + b)
}

@Suite struct DockerEngineTests {
    @Test func createSendsTheRunOptionsAsJSON() async throws {
        let r = Recorder()
        let h = try await engine(r).create(spec)
        #expect(h.id == "c0ffee1" && h.workdir == "/workspace/based-app" && h.reference == "docker:c0ffee1")
        #expect(r.requests.map(\.method) == ["POST", "POST"])
        #expect(r.requests[0].path == "/containers/create?name=based-based-app-run42")
        #expect(r.requests[1].path == "/containers/c0ffee1/start")
        let b = try #require(r.requests[0].body)
        #expect(b["Image"]?.string == "based-sandbox:1" && b["WorkingDir"]?.string == "/workspace/based-app")
        #expect(b["Cmd"] == ["sleep", "infinity"])
        #expect(b["Labels"]?["based.run"]?.string == "run42" && b["Labels"]?["based.project"]?.string == "based-app")
        let host = try #require(b["HostConfig"])
        #expect(host["Binds"] == ["/srv/projects/based:/workspace/based-app", "/home/based/.claude:/root/.claude:ro"])
        #expect(host["NetworkMode"]?.string == "none" && host["Memory"]?.int == 4096 * 1024 * 1024 && host["NanoCpus"]?.int == 2_000_000_000)
        #expect(host["SecurityOpt"] == ["no-new-privileges"] && host["PidsLimit"]?.int == 1024 && host["Init"] == true)
    }

    @Test func snapshotAndRestoreFollowTheCLIOrder() async throws {
        let r = Recorder()
        let p = engine(r)
        var h = try await p.create(spec)
        h = try await p.snapshot(h, name: "before-tests")
        #expect(h.snapshots.map(\.image) == ["based-snapshot/based-app:before-tests"])
        #expect(h.snapshots[0].archive == "/srv/based/snaps/based-app-before-tests.tar.gz")
        let commit = try #require(r.requests.first { $0.path.hasPrefix("/commit") })
        #expect(commit.path == "/commit?container=c0ffee1&repo=based-snapshot%2Fbased-app&tag=before-tests&comment=Based%20snapshot%20before-tests&pause=true")
        #expect(Array(r.steps.suffix(3)) == ["commit", "mkdir", "tar"], "commit, then archive the workspace — like `docker commit` + tar")
        let before = r.steps.count
        let restored = try await p.restore(h, snapshot: "before-tests")
        // Same as the CLI provider: remove container, move folder aside, unpack, start from the snapshot image.
        #expect(Array(r.steps.dropFirst(before)) == ["rm", "/srv/projects/based", "mkdir", "tar", "create", "start"])
        #expect(r.requests.last { $0.path.hasPrefix("/containers/create") }?.body?["Image"]?.string == "based-snapshot/based-app:before-tests")
        #expect(restored.id == "c0ffee2" && restored.image == "based-snapshot/based-app:before-tests" && restored.snapshots == h.snapshots)
        try await p.destroy(restored)
        #expect(r.requests.last?.method == "DELETE" && r.requests.last?.path == "/containers/c0ffee2?force=true")
        await #expect(throws: SandboxError.unknownSnapshot("nope")) { _ = try await p.restore(h, snapshot: "nope") }
        await #expect(throws: SandboxError.invalidName("../x")) { _ = try await p.snapshot(h, name: "../x") }
    }

    @Test func wrapStillUsesDockerExecInteractive() {
        let r = Recorder()
        let h = SandboxHandle(provider: "docker", id: "c1", project: "p", workdir: "/workspace/p", hostWorkspace: "/srv/p")
        let d = engine(r).wrap(AgentDefinition(id: "claude", name: "Claude", command: "claude-code-acp"), in: h, environment: ["LANG": "C"])
        #expect(d.command == "docker" && d.arguments == ["exec", "-i", "-w", "/workspace/p", "-e", "LANG", "c1", "claude-code-acp"])
    }

    @Test func socketTransportExecOverAFakeDaemon() async throws {
        let server = try FakeDockerSocket { req in
            let line = req.components(separatedBy: "\r\n").first ?? ""
            if line.hasPrefix("POST /v1.43/containers/c1/exec ") { return http("201 Created", Data("{\"Id\":\"e1\"}".utf8)) }
            if line.hasPrefix("POST /v1.43/exec/e1/start ") {
                return http("200 OK", frame(1, "hello ") + frame(2, "warn\n") + frame(1, "world\n"), chunked: true, type: "application/vnd.docker.raw-stream")
            }
            if line.hasPrefix("GET /v1.43/exec/e1/json ") { return http("200 OK", Data("{\"ExitCode\":3,\"Running\":false}".utf8), chunked: true) }
            return http("404 Not Found", Data("{\"message\":\"page not found\"}".utf8))
        }
        defer { server.stop() }
        let p = DockerEngineSandboxProvider(api: UnixSocketHTTPTransport(socketPath: server.path, timeout: 5),
                                            cli: DockerSandboxProvider(runner: Recorder(), snapshotDirectory: "/tmp"))
        let h = SandboxHandle(provider: "docker", id: "c1", project: "p", workdir: "/workspace/p", hostWorkspace: "/srv/p")
        let r = try await p.exec(h, ["sh", "-c", "echo hi"], environment: ["TOKEN_X": "s3cret"])
        #expect(r.exitCode == 3 && r.stdout == "hello world\n" && r.stderr == "warn\n")
        let reqs = server.requests
        #expect(reqs.count == 3)
        #expect(reqs[0].contains("Host: docker") && reqs[0].contains("Connection: close"))
        let body = try #require(reqs[0].components(separatedBy: "\r\n\r\n").last).data(using: .utf8)!
        let json = try JSONValue.parse(body)
        #expect(json["Env"] == ["TOKEN_X=s3cret"] && json["WorkingDir"]?.string == "/workspace/p" && json["Cmd"] == ["sh", "-c", "echo hi"])
        // Errors carry Docker's message; removing a container that is already gone is fine.
        await #expect(throws: SandboxError.commandFailed(command: "POST /containers/zz/exec", exitCode: 404, stderr: "page not found")) {
            _ = try await p.exec(SandboxHandle(provider: "docker", id: "zz", project: "p", workdir: "/w", hostWorkspace: "/h"), ["true"], environment: [:])
        }
        try await p.destroy(SandboxHandle(provider: "docker", id: "zz", project: "p", workdir: "/w", hostWorkspace: "/h"))
        await #expect(throws: SandboxError.unavailable("Docker is not reachable at /tmp/no-such-based.sock")) {
            _ = try await UnixSocketHTTPTransport(socketPath: "/tmp/no-such-based.sock").send("GET", "/_ping", body: nil)
        }
    }

    @Test func parsesChunkedAndContentLength() throws {
        let r = try UnixSocketHTTPTransport.parse(http("200 OK", Data("{\"a\":1}".utf8), chunked: true))
        #expect(r.status == 200 && r.json?["a"]?.int == 1)
        let r2 = try UnixSocketHTTPTransport.parse(http("204 No Content", Data()))
        #expect(r2.status == 204 && r2.body.isEmpty)
        #expect(throws: SandboxError.self) { try UnixSocketHTTPTransport.parse(Data("garbage".utf8)) }
        #expect(DockerStream.demux(Data("plain tty output".utf8)).stdout == "plain tty output")
    }

    /// Real daemon: BASED_DOCKER_TESTS=1 swift test --filter DockerEngineTests (needs docker, pulls alpine).
    @Test(.enabled(if: ProcessInfo.processInfo.environment["BASED_DOCKER_TESTS"] == "1"))
    func realDockerRoundTrip() async throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("based-docker-\(UUID().uuidString.prefix(6))").path
        try fm.createDirectory(atPath: root + "/ws", withIntermediateDirectories: true)
        try "one".write(toFile: root + "/ws/a.txt", atomically: true, encoding: .utf8)
        defer { try? fm.removeItem(atPath: root) }
        let cli = DockerSandboxProvider(runner: ProcessCommandRunner(), snapshotDirectory: root + "/snaps")
        try fm.createDirectory(atPath: root + "/snaps", withIntermediateDirectories: true)
        for p: SandboxProvider in [cli, DockerEngineSandboxProvider(api: UnixSocketHTTPTransport(), cli: cli)] {
            var h = try await p.create(SandboxSpec(project: "it-\(p is DockerSandboxProvider ? "cli" : "api")", hostWorkspace: root + "/ws", image: "alpine:3.20", cpus: 1, memoryMB: 256))
            let r = try await p.exec(h, ["sh", "-c", "cat a.txt; echo $X"], environment: ["X": "y"])
            #expect(r.exitCode == 0 && r.stdout == "oney\n")
            h = try await p.snapshot(h, name: "s1")
            try "two".write(toFile: root + "/ws/a.txt", atomically: true, encoding: .utf8)
            h = try await p.restore(h, snapshot: "s1")
            let after = try await p.exec(h, ["cat", "a.txt"], environment: [:])
            #expect(after.stdout == "one")
            try await p.destroy(h)
        }
    }
}
