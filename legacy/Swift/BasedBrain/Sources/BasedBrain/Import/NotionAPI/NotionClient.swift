import Foundation
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// HTTP layer of the Notion client (swappable in tests).
public protocol NotionTransport: Sendable {
    func send(method: String, url: URL, headers: [String: String], body: Data?) async throws -> (status: Int, headers: [String: String], data: Data)
}

public struct URLSessionNotionTransport: NotionTransport {
    public init() {}
    public func send(method: String, url: URL, headers: [String: String], body: Data?) async throws -> (status: Int, headers: [String: String], data: Data) {
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 120
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        req.httpBody = body
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = resp as? HTTPURLResponse
        var h: [String: String] = [:]
        for (k, v) in http?.allHeaderFields ?? [:] { h[String(describing: k).lowercased()] = String(describing: v) }
        return (http?.statusCode ?? 0, h, data)
    }
}

public enum NotionAPIError: Error, LocalizedError, Equatable {
    case unauthorized(String)
    case notFound(String)
    case restricted(String)
    case http(Int, String)
    case cancelled

    public var errorDescription: String? {
        switch self {
        case .unauthorized(let m): return "Notion rejected the integration token. \(m)"
        case .notFound(let m): return "Not found or not shared with the integration: \(m)"
        case .restricted(let m): return "The integration lacks access: \(m)"
        case .http(let c, let m): return "Notion API error \(c): \(m)"
        case .cancelled: return "Import cancelled"
        }
    }
}

/// Minimal Notion REST client: API version 2026-03-11, ~3 requests/s, retries on 429 / 5xx (Retry-After), pagination.
public actor NotionClient {
    public static let version = "2026-03-11"
    public let baseURL: URL
    let token: String
    let transport: NotionTransport
    let minInterval: TimeInterval
    private var nextSlot = Date.distantPast
    public private(set) var requestCount = 0

    public init(token: String, transport: NotionTransport = URLSessionNotionTransport(),
                baseURL: URL = URL(string: "https://api.notion.com/v1")!, requestsPerSecond: Double = 3) {
        self.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        self.transport = transport
        self.baseURL = baseURL
        self.minInterval = requestsPerSecond > 0 ? 1 / requestsPerSecond : 0
    }

    private func waitForSlot() async throws {
        let now = Date()
        let slot = max(now, nextSlot)
        nextSlot = slot.addingTimeInterval(minInterval)
        let delay = slot.timeIntervalSince(now)
        if delay > 0 { try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
        try Task.checkCancellation()
    }

    /// `path` segments are used as given (ids and Notion's already-encoded property ids).
    func url(_ path: String, query: [String: String] = [:]) -> URL {
        var c = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
        c.percentEncodedPath = (c.percentEncodedPath.hasSuffix("/") ? String(c.percentEncodedPath.dropLast()) : c.percentEncodedPath) + "/" + path
        if !query.isEmpty { c.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) } }
        return c.url!
    }

    /// Last failed request ("HTTP 404 [GET /v1/pages/…]: message") for diagnostic reports.
    public private(set) var lastFailure: String?

    public func request(_ method: String, _ path: String, query: [String: String] = [:], body: JSONValue? = nil) async throws -> JSONValue {
        let headers = ["Authorization": "Bearer \(token)", "Notion-Version": Self.version, "Content-Type": "application/json"]
        let data = try body?.encoded()
        var attempt = 0
        while true {
            try await waitForSlot()
            requestCount += 1
            let r: (status: Int, headers: [String: String], data: Data)
            do {
                r = try await transport.send(method: method, url: url(path, query: query), headers: headers, body: data)
            } catch is CancellationError {
                throw NotionAPIError.cancelled
            } catch {
                attempt += 1
                if attempt > 3 { throw error }
                try await Task.sleep(nanoseconds: UInt64(pow(2, Double(attempt)) * 500_000_000))
                continue
            }
            if (200..<300).contains(r.status) {
                return r.data.isEmpty ? .null : try JSONValue.parse(r.data)
            }
            let err = (try? JSONValue.parse(r.data)) ?? .null
            let message = err["message"]?.string ?? String(decoding: r.data.prefix(300), as: UTF8.self)
            let code = err["code"]?.string ?? ""
            if r.status == 429 || code == "rate_limited" || (500..<600).contains(r.status) {
                attempt += 1
                if attempt > 6 { throw NotionAPIError.http(r.status, message) }
                let wait = Double(r.headers["retry-after"] ?? "") ?? min(30, pow(2, Double(attempt)) * 0.5)
                nextSlot = Date().addingTimeInterval(wait)
                continue
            }
            // Which request failed (no token / body) — makes user-reported errors actionable.
            let where_ = " [\(method) /v1/\(path)\(query.isEmpty ? "" : "?" + query.keys.sorted().joined(separator: "&"))\(code.isEmpty ? "" : ", " + code)]"
            lastFailure = "HTTP \(r.status)\(where_): \(message)"
            switch r.status {
            case 401: throw NotionAPIError.unauthorized(message)
            case 404: throw NotionAPIError.notFound(message + where_)
            case 403: throw NotionAPIError.restricted(message + where_)
            default: throw NotionAPIError.http(r.status, message + where_)
            }
        }
    }

    public func get(_ path: String, query: [String: String] = [:]) async throws -> JSONValue { try await request("GET", path, query: query) }
    public func post(_ path: String, _ body: JSONValue) async throws -> JSONValue { try await request("POST", path, body: body) }

    /// All `results` of a paginated GET endpoint.
    public func paginateGet(_ path: String, query: [String: String] = [:], limit: Int = .max) async throws -> [JSONValue] {
        var out: [JSONValue] = []
        var cursor: String?
        repeat {
            var q = query
            q["page_size"] = "100"
            if let cursor { q["start_cursor"] = cursor }
            let r = try await get(path, query: q)
            out += r["results"]?.array ?? []
            cursor = r["has_more"]?.bool == true ? r["next_cursor"]?.string : nil
        } while cursor != nil && out.count < limit
        return out
    }

    /// All `results` of a paginated POST endpoint (query, search).
    public func paginatePost(_ path: String, body: [String: JSONValue] = [:], limit: Int = .max) async throws -> [JSONValue] {
        var out: [JSONValue] = []
        var cursor: String?
        repeat {
            var b = body
            b["page_size"] = 100
            if let cursor { b["start_cursor"] = .string(cursor) }
            let r = try await post(path, .object(b))
            out += r["results"]?.array ?? []
            cursor = r["has_more"]?.bool == true ? r["next_cursor"]?.string : nil
        } while cursor != nil && out.count < limit
        return out
    }

    /// Page ids of a view in the view's order (Views API: create a query, page through it, delete it).
    public func viewOrder(_ viewID: String) async throws -> [String] {
        let first = try await post("views/\(viewID)/queries", ["page_size": 100])
        var ids = (first["results"]?.array ?? []).compactMap { $0["id"]?.string }
        let qid = first["id"]?.string
        var cursor = first["has_more"]?.bool == true ? first["next_cursor"]?.string : nil
        while let c = cursor, let qid {
            let r = try await get("views/\(viewID)/queries/\(qid)", query: ["start_cursor": c, "page_size": "100"])
            ids += (r["results"]?.array ?? []).compactMap { $0["id"]?.string }
            cursor = r["has_more"]?.bool == true ? r["next_cursor"]?.string : nil
        }
        if let qid { _ = try? await request("DELETE", "views/\(viewID)/queries/\(qid)") }
        return ids
    }

    /// Downloads a Notion-hosted file (signed URL, no auth header) into `dir`.
    public func download(_ remote: URL, to dir: URL, name: String? = nil) async throws -> URL {
        var attempt = 0
        while true {
            let r = try await transport.send(method: "GET", url: remote, headers: [:], body: nil)
            if (200..<300).contains(r.status) {
                let base = (name ?? remote.lastPathComponent.removingPercentEncoding ?? remote.lastPathComponent)
                let safe = base.replacingOccurrences(of: "/", with: "-").isEmpty ? "file" : base.replacingOccurrences(of: "/", with: "-")
                let folder = dir.appendingPathComponent(UUID().uuidString, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                let u = folder.appendingPathComponent(safe)
                try r.data.write(to: u)
                return u
            }
            attempt += 1
            if attempt > 2 || (400..<500).contains(r.status) { throw NotionAPIError.http(r.status, "download \(remote.lastPathComponent)") }
            try await Task.sleep(nanoseconds: 800_000_000)
        }
    }
}

/// What to import: a page / database link or id.
public struct NotionTarget: Hashable, Sendable {
    public var id: String          // dashed lowercase UUID

    /// Accepts notion.so / notion.site / app.notion.com links (with titles, `?v=` view ids, `?p=` peeks) or raw ids.
    public init?(_ raw: String) {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if let u = URL(string: s), u.scheme != nil {
            let comps = URLComponents(url: u, resolvingAgainstBaseURL: false)
            if let p = comps?.queryItems?.first(where: { $0.name == "p" })?.value, let id = ImportIDs.notion(p) { self.id = id; return }
            guard let id = ImportIDs.notionID(inName: u.path) else { return nil }
            self.id = id
        } else {
            guard let id = ImportIDs.notion(s) ?? ImportIDs.notionID(inName: s) else { return nil }
            self.id = id
        }
    }

    /// Several targets from free text (one link or id per line / separated by spaces or commas).
    public static func parseList(_ text: String) -> [NotionTarget] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "\n" || $0 == " " || $0 == "," || $0 == "\t" }).compactMap { NotionTarget(String($0)) }
            .filter { seen.insert($0.id).inserted }
    }
}
