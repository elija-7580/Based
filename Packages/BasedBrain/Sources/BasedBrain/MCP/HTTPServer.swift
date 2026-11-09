import Foundation
#if canImport(Glibc)
import Glibc
#elseif canImport(Darwin)
import Darwin
#endif

/// Tiny dependency-free HTTP/1.1 server (one thread per connection). Good enough for a personal
/// server behind Caddy/nginx; TLS and HTTP/2 are terminated by the reverse proxy.
public final class HTTPServer: @unchecked Sendable {
    public struct Request: Sendable {
        public var method: String
        public var path: String
        public var query: [String: String]
        public var headers: [String: String]
        public var body: Data
        /// The `Authorization: Bearer …` token. BSD-34: never taken from the query string (`?token=` ends up in logs).
        public var bearerToken: String? {
            guard let a = headers["authorization"], a.lowercased().hasPrefix("bearer ") else { return nil }
            return String(a.dropFirst(7)).trimmingCharacters(in: .whitespaces)
        }
        public init(method: String, path: String, query: [String: String] = [:], headers: [String: String] = [:], body: Data = Data()) {
            self.method = method; self.path = path; self.query = query; self.headers = headers; self.body = body
        }
    }
    public struct Response: Sendable {
        public var status: Int
        public var headers: [String: String]
        public var body: Data
        public init(status: Int = 200, headers: [String: String] = [:], body: Data = Data()) { self.status = status; self.headers = headers; self.body = body }
        public static func json(_ v: JSONValue, status: Int = 200) -> Response {
            Response(status: status, headers: ["Content-Type": "application/json"], body: (try? v.encoded()) ?? Data())
        }
        public static func text(_ s: String, status: Int = 200) -> Response {
            Response(status: status, headers: ["Content-Type": "text/plain; charset=utf-8"], body: Data(s.utf8))
        }
    }
    public typealias Handler = @Sendable (Request) async -> Response

    public let port: UInt16
    public let handler: Handler
    /// Bind to 127.0.0.1 only (the app's private endpoint for local agents).
    public let loopbackOnly: Bool
    private var fd: Int32 = -1
    private var thread: Thread?
    public private(set) var isRunning = false
    /// Actual port (differs from `port` when started with port 0 = random free port).
    public private(set) var boundPort: UInt16 = 0

    /// BSD-34 limits. More simultaneous connections than `maxConnections` get 503; a client that sends nothing for
    /// `receiveTimeout` seconds is dropped; a body larger than `bodyLimit(method, path)` gets 413 without being read.
    public let maxConnections: Int
    public let receiveTimeout: TimeInterval
    public let bodyLimit: @Sendable (_ method: String, _ path: String) -> Int
    public static let headerLimit = 64 << 10
    private let countLock = NSLock()
    private var active = 0
    /// Connections being served right now.
    public var activeConnections: Int { countLock.lock(); defer { countLock.unlock() }; return active }

    public init(port: UInt16, loopbackOnly: Bool = false, maxConnections: Int = 64, receiveTimeout: TimeInterval = 30,
                bodyLimit: @escaping @Sendable (_ method: String, _ path: String) -> Int = { _, _ in 32 << 20 },
                handler: @escaping Handler) {
        self.port = port; self.loopbackOnly = loopbackOnly; self.handler = handler
        self.maxConnections = maxConnections; self.receiveTimeout = receiveTimeout; self.bodyLimit = bodyLimit
    }

    public func start() throws {
        ProcessSupervisor.ignoreSIGPIPE()   // BSD-36: a client that hangs up mid-response must not kill the server
        #if canImport(Darwin)
        let sockStream = SOCK_STREAM
        #else
        let sockStream = Int32(SOCK_STREAM.rawValue)
        #endif
        fd = socket(AF_INET, sockStream, 0)
        guard fd >= 0 else { throw NSError(domain: "http", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket() failed"]) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: loopbackOnly ? UInt32(0x7F00_0001).bigEndian : INADDR_ANY)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, listen(fd, 64) == 0 else { close(fd); throw NSError(domain: "http", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot listen on port \(port)"]) }
        var actual = sockaddr_in()
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        _ = withUnsafeMutablePointer(to: &actual) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &len) } }
        boundPort = UInt16(bigEndian: actual.sin_port)
        isRunning = true
        let listener = fd
        let t = Thread { [self] in
            var backoff: useconds_t = 0
            while isRunning {
                let c = accept(listener, nil, nil)
                guard c >= 0 else {
                    // BSD-34: no busy loop when accept fails (e.g. out of file descriptors): back off up to 1 s.
                    guard isRunning else { break }
                    backoff = min(max(backoff * 2, 10_000), 1_000_000)
                    usleep(backoff)
                    continue
                }
                backoff = 0
                Self.setTimeouts(c, seconds: receiveTimeout)
                guard reserveSlot() else {
                    Self.write(c, Response.json(["error": "server busy"], status: 503))
                    close(c)
                    continue
                }
                Thread { self.serve(c); self.releaseSlot() }.start()
            }
        }
        t.name = "based-http"; t.start(); thread = t
    }

    public func stop() { isRunning = false; if fd >= 0 { close(fd); fd = -1 } }

    private func reserveSlot() -> Bool {
        countLock.lock(); defer { countLock.unlock() }
        guard active < maxConnections else { return false }
        active += 1; return true
    }
    private func releaseSlot() { countLock.lock(); active -= 1; countLock.unlock() }

    private static func setTimeouts(_ c: Int32, seconds: TimeInterval) {
        var tv = timeval()
        tv.tv_sec = time_t(seconds)
        tv.tv_usec = suseconds_t((seconds - floor(seconds)) * 1_000_000)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
    }

    private func serve(_ c: Int32) {
        defer { close(c) }
        let req: Request
        switch readRequest(c) {
        case .request(let r): req = r
        case .tooLarge: Self.write(c, .json(["error": "request body too large"], status: 413)); return
        case .headersTooLarge: Self.write(c, .json(["error": "request headers too large"], status: 431)); return
        case .invalid: return
        }
        let sem = DispatchSemaphore(value: 0)
        var resp = Response(status: 500)
        Task { resp = await handler(req); sem.signal() }
        sem.wait()
        Self.write(c, resp)
    }

    /// BSD-34: no blanket `Access-Control-Allow-Origin: *` any more; the router adds CORS for the configured origin only.
    private static func write(_ c: Int32, _ resp: Response) {
        var head = "HTTP/1.1 \(resp.status) \(Self.reason(resp.status))\r\n"
        var headers = resp.headers
        headers["Content-Length"] = String(resp.body.count)
        headers["Connection"] = "close"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8); out.append(resp.body)
        out.withUnsafeBytes { p in
            var off = 0
            while off < p.count { let n = send(c, p.baseAddress! + off, p.count - off, 0); if n <= 0 { break }; off += n }
        }
    }

    enum ReadResult { case request(Request), tooLarge, headersTooLarge, invalid }

    private func readRequest(_ c: Int32) -> ReadResult {
        var buf = Data(), chunk = [UInt8](repeating: 0, count: 65536)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = recv(c, &chunk, chunk.count, 0)
            if n <= 0 { return .invalid }   // closed, error or SO_RCVTIMEO
            buf.append(chunk, count: n)
            headerEnd = buf.range(of: Data("\r\n\r\n".utf8))
            if headerEnd == nil, buf.count > Self.headerLimit { return .headersTooLarge }
        }
        guard let he = headerEnd, let headText = String(data: buf[..<he.lowerBound], encoding: .utf8) else { return .invalid }
        var lines = headText.components(separatedBy: "\r\n")
        let reqLine = lines.removeFirst().split(separator: " ")
        guard reqLine.count >= 2 else { return .invalid }
        var headers: [String: String] = [:]
        for l in lines { if let i = l.firstIndex(of: ":") { headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let method = String(reqLine[0])
        let target = String(reqLine[1])
        let comps = URLComponents(string: target)
        let path = comps?.path ?? target
        let length = Int(headers["content-length"] ?? "0") ?? 0
        guard length >= 0 else { return .invalid }
        if length > bodyLimit(method, path) { return .tooLarge }
        var body = Data(buf[he.upperBound...])
        if body.count > length { body = body.prefix(length) }
        while body.count < length {
            let n = recv(c, &chunk, min(chunk.count, length - body.count), 0)
            if n <= 0 { return .invalid }   // timed out or closed before the announced body arrived
            body.append(chunk, count: n)
        }
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return .request(Request(method: method, path: path, query: query, headers: headers, body: body))
    }

    static func reason(_ s: Int) -> String {
        switch s { case 200: return "OK"; case 201: return "Created"; case 204: return "No Content"; case 400: return "Bad Request"
        case 401: return "Unauthorized"; case 403: return "Forbidden"; case 404: return "Not Found"; case 405: return "Method Not Allowed"
        case 409: return "Conflict"; case 413: return "Payload Too Large"; case 431: return "Request Header Fields Too Large"
        case 500: return "Internal Server Error"; case 503: return "Service Unavailable"; default: return "Status" }
    }
}
