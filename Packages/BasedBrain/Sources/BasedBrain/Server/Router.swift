import Foundation

// BSD-34 (ADR 0006): based-server's routes live in one table. Every request passes the same middleware chain –
// CORS preflight → route lookup (404/405) → body limit (413) → authentication (header only, never `?token=`) →
// handler – so a new route is protected by default and can't forget its auth check.

/// Who may call a route.
public enum RouteAccess: Sendable, Equatable {
    /// No token: health, the web client page, link landing pages, published pages, accepting an invite.
    case `public`
    /// The owner token (the default). A shared principal gets 403, everyone else 401.
    case owner
    /// The owner, or a shared principal (device token `bdu_…`, access-link secret `bdl_…`); the handler sees who in
    /// `RouteContext.principal` and filters by role (docs/sharing.md).
    case ownerOrShared
    /// The owner, or the per-session MCP token (`bds_…`, BSD-33) of the session named by the first `*` capture.
    case session
    /// The owner token, and only when one is configured: an open loopback server never exposes these (sandboxes).
    case ownerConfigured
}

public struct RouteContext: Sendable {
    public var request: HTTPServer.Request
    /// The path segments matched by `*` in the route pattern, in order.
    public var captures: [String]
    /// `.owner` unless the route is `.ownerOrShared` and a shared principal called it.
    public var principal: SharePrincipal
}

public struct ServerRoute: Sendable {
    public typealias Handler = @Sendable (RouteContext) async -> HTTPServer.Response
    public let method: String
    /// Path pattern; `*` matches exactly one segment ("/sessions/*/prompt"). Trailing slashes are ignored.
    public let pattern: String
    public let access: RouteAccess
    /// Largest accepted request body in bytes.
    public let bodyLimit: Int
    public let handler: Handler

    /// The `*` captures when `path` matches the pattern, else nil.
    public func captures(for path: String) -> [String]? { ServerRouter.match(path, pattern) }

    /// A concrete example path for the pattern (each `*` replaced by `fill`), used by tests that walk the table.
    public func samplePath(fill: String = "x") -> String {
        let segs = pattern.split(separator: "/").map { $0 == "*" ? fill : String($0) }
        return "/" + segs.joined(separator: "/")
    }
}

public final class ServerRouter: @unchecked Sendable {
    public static let defaultBodyLimit = 1 << 20        // 1 MiB
    public static let largeBodyLimit = 32 << 20         // 32 MiB: sync pushes, MCP calls with page content

    public struct Config: Sendable {
        /// The owner token. Empty = open server (only allowed on loopback or with `--insecure-public`): everyone is owner.
        public var ownerToken: String
        /// Per-session MCP tokens for `.session` routes.
        public var sessionTokens: MCPSessionTokens?
        /// The only origin that gets CORS headers (from `BASED_PUBLIC_URL`); nil = no cross-origin access.
        public var allowedOrigin: String?
        /// Resolves a bearer token to a shared principal (device token or access link); nil = not shared.
        public var principal: (@Sendable (String) async -> SharePrincipal?)?

        public init(ownerToken: String, sessionTokens: MCPSessionTokens? = nil, allowedOrigin: String? = nil,
                    principal: (@Sendable (String) async -> SharePrincipal?)? = nil) {
            self.ownerToken = ownerToken; self.sessionTokens = sessionTokens
            self.allowedOrigin = allowedOrigin; self.principal = principal
        }
    }

    public let config: Config
    public private(set) var routes: [ServerRoute] = []

    public init(config: Config) { self.config = config }

    /// Registers a route. `access` defaults to `.owner`, `bodyLimit` to 1 MiB.
    public func add(_ method: String, _ pattern: String, access: RouteAccess = .owner, bodyLimit: Int = ServerRouter.defaultBodyLimit,
                    _ handler: @escaping ServerRoute.Handler) {
        routes.append(ServerRoute(method: method, pattern: pattern, access: access, bodyLimit: bodyLimit, handler: handler))
    }

    /// Body limit for a request line, before its body is read (`HTTPServer` answers 413 without reading it).
    public func bodyLimit(method: String, path: String) -> Int {
        routes.first { $0.method == method && $0.captures(for: path) != nil }?.bodyLimit ?? Self.defaultBodyLimit
    }

    /// The middleware chain plus dispatch.
    public func handle(_ req: HTTPServer.Request) async -> HTTPServer.Response {
        var resp = await dispatch(req)
        if let origin = req.headers["origin"], let allowed = config.allowedOrigin, origin == allowed {
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Vary"] = "Origin"
        }
        return resp
    }

    private func dispatch(_ req: HTTPServer.Request) async -> HTTPServer.Response {
        if req.method == "OPTIONS" {
            return HTTPServer.Response(status: 204, headers: ["Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                                                              "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Session-Id"])
        }
        let candidates = routes.compactMap { r in r.captures(for: req.path).map { (r, $0) } }
        guard !candidates.isEmpty else { return .json(["error": "not found"], status: 404) }
        guard let (route, caps) = candidates.first(where: { $0.0.method == req.method }) else {
            return HTTPServer.Response(status: 405, headers: ["Content-Type": "application/json",
                                                              "Allow": Set(candidates.map(\.0.method)).sorted().joined(separator: ", ")],
                                       body: Data(#"{"error":"method not allowed"}"#.utf8))
        }
        guard req.body.count <= route.bodyLimit else { return .json(["error": "request body too large"], status: 413) }
        switch await authenticate(req, route: route, captures: caps) {
        case .success(let principal):
            return await route.handler(RouteContext(request: req, captures: caps, principal: principal))
        case .failure(let denial):
            return .json(["error": .string(denial.message)], status: denial.status)
        }
    }

    struct Denial: Error { let status: Int; let message: String }

    private func authenticate(_ req: HTTPServer.Request, route: ServerRoute, captures: [String]) async -> Result<SharePrincipal, Denial> {
        let unauthorized = Denial(status: 401, message: "unauthorized")
        let bearer = req.bearerToken ?? ""
        let open = config.ownerToken.isEmpty
        let isOwner = open || SecureToken.equal(bearer, config.ownerToken)
        switch route.access {
        case .public:
            return .success(.owner)
        case .owner:
            if isOwner { return .success(.owner) }
            if !bearer.isEmpty, await config.principal?(bearer) != nil {
                return .failure(Denial(status: 403, message: "not available for shared access"))
            }
            return .failure(unauthorized)
        case .ownerOrShared:
            if isOwner { return .success(.owner) }
            guard !bearer.isEmpty, let p = await config.principal?(bearer) else { return .failure(unauthorized) }
            return .success(p)
        case .session:
            if isOwner { return .success(.owner) }
            guard let sid = captures.first, !sid.isEmpty, config.sessionTokens?.isValid(bearer, session: sid) == true else {
                return .failure(unauthorized)
            }
            return .success(.owner)
        case .ownerConfigured:
            guard !open, isOwner else { return .failure(unauthorized) }
            return .success(.owner)
        }
    }

    /// Path matcher for "/sessions/*/prompt"-style patterns.
    public static func match(_ path: String, _ pattern: String) -> [String]? {
        let p = path.split(separator: "/"), q = pattern.split(separator: "/")
        guard p.count == q.count else { return nil }
        var caps: [String] = []
        for (a, b) in zip(p, q) {
            if b == "*" { caps.append(String(a)) } else if a != b { return nil }
        }
        return caps
    }
}

/// BSD-34: how the server is exposed, decided from its options before it starts.
public enum ServerExposure {
    public struct Binding: Equatable, Sendable {
        /// Listen on 127.0.0.1 only.
        public var loopbackOnly: Bool
        /// A line for the log, if the configuration deserves one.
        public var warning: String?
    }

    /// Without a token the server only listens on loopback; `--insecure-public` is the explicit way to open it anyway.
    public static func binding(token: String, insecurePublic: Bool) -> Binding {
        if !token.isEmpty { return Binding(loopbackOnly: false, warning: nil) }
        if insecurePublic {
            return Binding(loopbackOnly: false, warning: "WARNING: --insecure-public without --token: every endpoint is open to anyone who can reach this server.")
        }
        return Binding(loopbackOnly: true, warning: "No --token set: listening on 127.0.0.1 only. Set BASED_TOKEN (or --token) to accept other machines.")
    }

    /// The origin (scheme://host[:port]) of `BASED_PUBLIC_URL`, the only one allowed cross-origin requests.
    public static func allowedOrigin(publicURL: String?) -> String? {
        guard let s = publicURL, let c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), let host = c.host?.lowercased(),
              scheme == "http" || scheme == "https" else { return nil }
        return "\(scheme)://\(host)" + (c.port.map { ":\($0)" } ?? "")
    }
}
