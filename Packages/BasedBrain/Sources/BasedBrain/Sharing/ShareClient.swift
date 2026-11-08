import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The app's side of sharing: talks to based-server's /share/v1 API with the owner (or a device) token.
public struct ShareClient: Sendable {
    public var baseURL: URL
    public var token: String
    public var transport: (@Sendable (URLRequest) async throws -> (Int, Data))?

    public init(baseURL: URL, token: String) { self.baseURL = baseURL; self.token = token }

    public struct Access: Decodable, Sendable {
        public struct Person: Decodable, Sendable, Identifiable { public var id: String; public var userID: String; public var name: String; public var pageID: String; public var role: ShareRole }
        public struct Link: Decodable, Sendable, Identifiable { public var id: String; public var kind: SharingLink.Kind; public var role: ShareRole; public var pageID: String; public var label: String?; public var active: Bool }
        public var people: [Person]
        public var links: [Link]
    }

    public struct Created: Decodable, Sendable { public var id: String; public var url: String; public var kind: SharingLink.Kind; public var role: ShareRole }

    public struct Failure: LocalizedError { public var message: String; public var errorDescription: String? { message } }

    public func access(to pageID: String) async throws -> Access {
        try await call("GET", "share/v1/pages/\(pageID)", nil)
    }

    public func createLink(pageID: String, kind: SharingLink.Kind, role: ShareRole, expiresInDays: Int? = nil, uses: Int? = nil) async throws -> Created {
        var body: [String: Any] = ["pageID": pageID, "kind": kind.rawValue, "role": role.rawValue]
        if let expiresInDays { body["expiresInDays"] = expiresInDays }
        if let uses { body["uses"] = uses }
        return try await call("POST", "share/v1/links", body)
    }

    public func revokeLink(_ id: String) async throws {
        let _: [String: Bool] = try await call("POST", "share/v1/links/\(id)/revoke", [:])
    }

    public func setRole(user: String, pageID: String, role: ShareRole?) async throws {
        let _: [String: Bool] = try await call("POST", "share/v1/grants", ["userID": user, "pageID": pageID, "role": role?.rawValue ?? NSNull()])
    }

    /// The page behind a share URL of this server (owner only), so the app opens it instead of the browser.
    public func resolve(_ url: URL) async throws -> String? {
        struct R: Decodable { var pageID: String? }
        let r: R = try await call("GET", "share/v1/resolve?path=\(url.path.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")", nil)
        return r.pageID
    }

    private func call<T: Decodable>(_ method: String, _ path: String, _ body: [String: Any]?) async throws -> T {
        guard let url = URL(string: path, relativeTo: baseURL.appendingPathComponent("")) else { throw Failure(message: "Bad server URL") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (status, data): (Int, Data)
        if let transport { (status, data) = try await transport(req) } else {
            let (d, r) = try await URLSession.shared.data(for: req)
            (status, data) = ((r as? HTTPURLResponse)?.statusCode ?? 0, d)
        }
        guard (200..<300).contains(status) else {
            let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
            throw Failure(message: msg ?? (status == 404 ? "This server doesn't support sharing yet — update based-server." : "Server error \(status)"))
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
