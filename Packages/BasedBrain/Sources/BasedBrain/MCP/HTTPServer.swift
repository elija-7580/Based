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
        public var bearerToken: String? {
            guard let a = headers["authorization"], a.lowercased().hasPrefix("bearer ") else { return query["token"] }
            return String(a.dropFirst(7)).trimmingCharacters(in: .whitespaces)
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
    private var fd: Int32 = -1
    private var thread: Thread?
    public private(set) var isRunning = false

    public init(port: UInt16, handler: @escaping Handler) { self.port = port; self.handler = handler }

    public func start() throws {
        fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        guard fd >= 0 else { throw NSError(domain: "http", code: 1, userInfo: [NSLocalizedDescriptionKey: "socket() failed"]) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = port.bigEndian
        addr.sin_addr = in_addr(s_addr: INADDR_ANY)
        let bound = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) } }
        guard bound == 0, listen(fd, 64) == 0 else { close(fd); throw NSError(domain: "http", code: 2, userInfo: [NSLocalizedDescriptionKey: "Cannot listen on port \(port)"]) }
        isRunning = true
        let t = Thread { [self] in
            while isRunning {
                let c = accept(fd, nil, nil)
                guard c >= 0 else { continue }
                Thread { self.serve(c) }.start()
            }
        }
        t.name = "based-http"; t.start(); thread = t
    }

    public func stop() { isRunning = false; if fd >= 0 { close(fd); fd = -1 } }

    private func serve(_ c: Int32) {
        defer { close(c) }
        guard let req = readRequest(c) else { return }
        let sem = DispatchSemaphore(value: 0)
        var resp = Response(status: 500)
        Task { resp = await handler(req); sem.signal() }
        sem.wait()
        var head = "HTTP/1.1 \(resp.status) \(Self.reason(resp.status))\r\n"
        var headers = resp.headers
        headers["Content-Length"] = String(resp.body.count)
        headers["Connection"] = "close"
        headers["Access-Control-Allow-Origin"] = headers["Access-Control-Allow-Origin"] ?? "*"
        for (k, v) in headers { head += "\(k): \(v)\r\n" }
        head += "\r\n"
        var out = Data(head.utf8); out.append(resp.body)
        out.withUnsafeBytes { p in
            var off = 0
            while off < p.count { let n = send(c, p.baseAddress! + off, p.count - off, 0); if n <= 0 { break }; off += n }
        }
    }

    private func readRequest(_ c: Int32) -> Request? {
        var buf = Data(), chunk = [UInt8](repeating: 0, count: 65536)
        var headerEnd: Range<Data.Index>?
        while headerEnd == nil {
            let n = recv(c, &chunk, chunk.count, 0)
            if n <= 0 { return nil }
            buf.append(chunk, count: n)
            headerEnd = buf.range(of: Data("\r\n\r\n".utf8))
            if buf.count > 1 << 20 { return nil }
        }
        guard let he = headerEnd, let headText = String(data: buf[..<he.lowerBound], encoding: .utf8) else { return nil }
        var lines = headText.components(separatedBy: "\r\n")
        let reqLine = lines.removeFirst().split(separator: " ")
        guard reqLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for l in lines { if let i = l.firstIndex(of: ":") { headers[l[..<i].lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces) } }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        var body = Data(buf[he.upperBound...])
        while body.count < length {
            let n = recv(c, &chunk, min(chunk.count, length - body.count), 0)
            if n <= 0 { break }
            body.append(chunk, count: n)
        }
        let target = String(reqLine[1])
        let comps = URLComponents(string: target)
        var query: [String: String] = [:]
        for item in comps?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(method: String(reqLine[0]), path: comps?.path ?? target, query: query, headers: headers, body: body)
    }

    static func reason(_ s: Int) -> String {
        switch s { case 200: return "OK"; case 201: return "Created"; case 204: return "No Content"; case 400: return "Bad Request"
        case 401: return "Unauthorized"; case 403: return "Forbidden"; case 404: return "Not Found"; case 405: return "Method Not Allowed"
        case 500: return "Internal Server Error"; default: return "Status" }
    }
}
