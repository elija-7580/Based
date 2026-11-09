import Foundation
import BasedCore

// Sharing endpoints (docs/sharing.md). BSD-34: registered on the server's router like every other route. The
// public ones need no token; the rest are `.ownerOrShared`: the owner token, a device token (bdu_…) or an access-link
// secret (bdl_…), with everything filtered by the caller's role.
//
//   GET  /s/<secret>                      link landing: the web client (access link) or the join page (invite)
//   GET  /p/<id>[/<pageID>]               published page, server-rendered, read-only
//   POST /share/v1/invites/accept         {secret, name} → {token, pageID}
//   GET  /share/v1/me                     who am I, which pages, which role
//   GET  /share/v1/snapshot               everything I can see + change-log position
//   GET  /share/v1/resolve?path=/s/…      page behind a share URL (owner; the app opens it natively)
//   GET  /share/v1/pages/<pageID>         access list (full access needed)
//   POST /share/v1/links                  {pageID, kind: access|invite|publish, role, label?, expiresInDays?, uses?}
//   POST /share/v1/links/<id>/revoke
//   POST /share/v1/grants                 {userID, pageID, role|null}
//   sync v2 (pull / push / wait) and /api/blocks/insert-after for shared principals (ServerRoutes.swift)
//   GET  /.well-known/apple-app-site-association   Universal Links → the app opens /s/* and /p/* links

enum ShareRoutes {
    /// Public URL of this server (links are built from it).
    static var publicURL: String {
        (ProcessInfo.processInfo.environment["BASED_PUBLIC_URL"] ?? "").trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }

    static func register(on r: ServerRouter, share: ShareService, store: WorkspaceStore) {
        // Public routes.
        r.add("GET", "/.well-known/apple-app-site-association", access: .public) { _ in aasa() }
        r.add("GET", "/s/*", access: .public) { ctx in
            let link = await MainActor.run { share.link(secret: ctx.captures[0]) }
            guard let link, link.isActive() else { return .text("This link has expired or was revoked.", status: 404) }
            switch link.kind {
            case .access: return html(WebApp.html)
            case .invite: return html(InvitePage.html(title: await MainActor.run { store.title(of: link.pageID) }, role: link.role))
            case .publish: return HTTPServer.Response(status: 302, headers: ["Location": "/p/\(link.id)"])
            }
        }
        r.add("GET", "/p/*", access: .public) { ctx in await published(ctx.request.path, share: share, store: store) }
        r.add("GET", "/p/*/*", access: .public) { ctx in await published(ctx.request.path, share: share, store: store) }
        r.add("POST", "/share/v1/invites/accept", access: .public) { ctx in
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            let result: Result<(ShareUser, String, RecordID), ShareError> = await MainActor.run {
                do { let r = try share.acceptInvite(secret: body["secret"]?.string ?? "", name: body["name"]?.string ?? ""); return .success((r.user, r.token, r.pageID)) }
                catch let e as ShareError { return .failure(e) } catch { return .failure(.invalid("\(error)")) }
            }
            switch result {
            case .success(let (user, token, page)):
                return .json(["token": .string(token), "user": .string(user.name), "pageID": .string(page)])
            case .failure(let e): return .json(["error": .string(e.description)], status: 400)
            }
        }

        // Owner or a shared principal.
        r.add("GET", "/share/v1/me", access: .ownerOrShared) { ctx in
            let p = ctx.principal
            let info: JSONValue = await MainActor.run {
                let roots = p == .owner ? [] : share.roots(for: p)
                return .object([
                    "kind": .string({ switch p { case .owner: "owner"; case .user: "user"; case .link: "link" } }()),
                    "name": .string(p.label),
                    "pages": .array(roots.map { .object(["id": .string($0.pageID), "title": .string(store.title(of: $0.pageID)),
                                                         "role": .string($0.role.rawValue)]) }),
                ])
            }
            return .json(info)
        }
        r.add("GET", "/share/v1/resolve", access: .ownerOrShared) { ctx in
            // The app opening one of this server's share URLs: which page is it? (owner only)
            guard ctx.principal == .owner else { return .json(["error": "forbidden"], status: 403) }
            let parts = (ctx.request.query["path"]?.removingPercentEncoding ?? "").split(separator: "/").map(String.init)
            let page: String? = await MainActor.run {
                if parts.count == 2, parts[0] == "s" { return share.link(secret: parts[1])?.pageID }
                if parts.count >= 2, parts[0] == "p" { return parts.count >= 3 ? parts[2] : share.publishedLink(id: parts[1])?.pageID }
                return nil
            }
            return .json(["pageID": page.map(JSONValue.string) ?? .null])
        }
        r.add("GET", "/share/v1/snapshot", access: .ownerOrShared) { ctx in
            let p = ctx.principal
            return encoded(await MainActor.run { share.snapshot(for: p) })
        }
        r.add("POST", "/share/v1/links", access: .ownerOrShared) { ctx in
            let p = ctx.principal
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            guard let pageID = body["pageID"]?.string,
                  let kind = SharingLink.Kind(rawValue: body["kind"]?.string ?? "access"),
                  let role = ShareRole(rawValue: body["role"]?.string ?? "view") else { return .json(["error": "pageID, kind, role"], status: 400) }
            let days = body["expiresInDays"]?.stringValue.flatMap(Double.init)
            let uses = body["uses"]?.stringValue.flatMap(Int.init)
            let result: Result<ShareService.CreatedLink, ShareError> = await MainActor.run {
                do {
                    return .success(try share.createLink(kind, pageID: pageID, role: role, by: p, label: body["label"]?.string,
                                                         expiresAt: days.map { Date().addingTimeInterval($0 * 86_400) }, uses: uses))
                } catch let e as ShareError { return .failure(e) } catch { return .failure(.invalid("\(error)")) }
            }
            switch result {
            case .success(let c):
                let url = kind == .publish ? "\(publicURL)/p/\(c.link.id)" : "\(publicURL)/s/\(c.secret)"
                return .json(["id": .string(c.link.id), "url": .string(url), "kind": .string(kind.rawValue), "role": .string(role.rawValue)])
            case .failure(let e): return failure(e)
            }
        }
        r.add("GET", "/share/v1/pages/*", access: .ownerOrShared) { ctx in
            let p = ctx.principal, pageID = ctx.captures[0]
            let out: JSONValue? = await MainActor.run {
                guard share.role(of: p, onPage: pageID)?.canShare == true else { return nil }
                let a = share.access(to: pageID)
                let names = Dictionary(uniqueKeysWithValues: share.state.users.map { ($0.id, $0.name) })
                return .object([
                    "people": .array(a.grants.map { .object(["id": .string($0.id), "userID": .string($0.userID), "name": .string(names[$0.userID] ?? "?"),
                                                             "pageID": .string($0.pageID), "role": .string($0.role.rawValue)]) }),
                    "links": .array(a.links.map { .object(["id": .string($0.id), "kind": .string($0.kind.rawValue), "role": .string($0.role.rawValue),
                                                           "pageID": .string($0.pageID), "label": $0.label.map(JSONValue.string) ?? .null,
                                                           "active": .bool($0.isActive())]) }),
                ])
            }
            return out.map { .json($0) } ?? .json(["error": "forbidden"], status: 403)
        }
        r.add("POST", "/share/v1/links/*/revoke", access: .ownerOrShared) { ctx in
            let p = ctx.principal, id = ctx.captures[0]
            let err: ShareError? = await MainActor.run {
                do { try share.revokeLink(id, by: p); return nil } catch let e as ShareError { return e } catch { return .invalid("\(error)") }
            }
            return err.map(failure) ?? .json(["ok": true])
        }
        r.add("POST", "/share/v1/grants", access: .ownerOrShared) { ctx in
            let p = ctx.principal
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            guard let user = body["userID"]?.string, let pageID = body["pageID"]?.string else { return .json(["error": "userID, pageID"], status: 400) }
            let role = body["role"]?.string.flatMap(ShareRole.init(rawValue:))
            let err: ShareError? = await MainActor.run {
                do { try share.setGrant(user: user, pageID: pageID, role: role, by: p); return nil } catch let e as ShareError { return e } catch { return .invalid("\(error)") }
            }
            return err.map(failure) ?? .json(["ok": true])
        }
    }

    // MARK: Shared principals on the sync / editing routes (the owner takes the normal path in ServerRoutes.swift)

    static func sharedPull(_ p: SharePrincipal, _ req: HTTPServer.Request, share: ShareService, sync: SyncServer) async -> HTTPServer.Response {
        let after = req.query["after"].flatMap { Int64($0) } ?? 0
        let limit = req.query["limit"].flatMap { Int($0) } ?? 500
        let page: SyncPage? = await MainActor.run { try? share.tryPullPage(for: p, sync: sync, after: after, limit: limit) }
        guard let page else { return .json(["error": "change log unavailable"], status: 500) }
        return encoded(page)
    }

    static func sharedPush(_ p: SharePrincipal, _ req: HTTPServer.Request, share: ShareService, sync: SyncServer) async -> HTTPServer.Response {
        guard let body = try? JSONDecoder().decode(SyncPush.self, from: req.body) else { return .json(["error": "bad body"], status: 400) }
        let result = await MainActor.run { share.push(for: p, sync: sync, body) }
        if !result.rejected.isEmpty { Log.info("share: rejected \(result.rejected.count) record(s) from \(p.label)", category: "share") }
        return encoded(result.reply)
    }

    static func sharedInsert(_ p: SharePrincipal, _ req: HTTPServer.Request, share: ShareService, store: WorkspaceStore) async -> HTTPServer.Response {
        let body = (try? JSONValue.parse(req.body)) ?? .object([:])
        guard let after = body["after"]?.string else { return .json(["error": "missing after"], status: 400) }
        let text = body["text"]?.string ?? ""
        let id: String? = await MainActor.run {
            guard share.canInsert(after: after, by: p) else { return nil }
            return store.insertBlock(.text, after: after, text: RichText(text))
        }
        guard let id else { return .json(["error": "forbidden"], status: 403) }
        return .json(["id": .string(id)])
    }

    // MARK: Helpers

    static func encoded<T: Encodable>(_ v: T) -> HTTPServer.Response {
        HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(v)) ?? Data())
    }

    /// BSD-35: with a nonce CSP (`WebSecurity`).
    static func html(_ s: String) -> HTTPServer.Response { WebSecurity.page(s) }

    static func failure(_ e: ShareError) -> HTTPServer.Response {
        switch e {
        case .notFound: return .json(["error": .string(e.description)], status: 404)
        case .forbidden: return .json(["error": .string(e.description)], status: 403)
        case .invalid: return .json(["error": .string(e.description)], status: 400)
        }
    }

    /// Published pages: the shared page and the pages inside it, rendered like the HTML export.
    static func published(_ path: String, share: ShareService, store: WorkspaceStore) async -> HTTPServer.Response {
        let parts = path.split(separator: "/").map(String.init)   // ["p", id, pageID?]
        guard parts.count >= 2 else { return .text("Not found", status: 404) }
        let out: String? = await MainActor.run {
            guard let link = share.publishedLink(id: parts[1]) else { return nil }
            let target = parts.count >= 3 ? parts[2] : link.pageID
            guard let b = store.blocks[target], b.trashedAt == nil, share.role(of: .link(link), on: .block(b)) != nil else { return nil }
            let exporter = HTMLExporter(store: store) { id in
                guard let p = store.blocks[id], share.role(of: .link(link), on: .block(p)) != nil else { return nil }
                return (store.title(of: id), "/p/\(link.id)/\(id)")
            }
            return exporter.export(page: target)
        }
        guard let out else { return .text("This page isn't published.", status: 404) }
        // BSD-35: CSP; MathJax/Mermaid come from jsDelivr, embeds/video/audio from https.
        return WebSecurity.page(out, scriptSources: ["https://cdn.jsdelivr.net"], embeds: true)
    }

    /// Universal Links: BASED_APPLE_APP_ID = "<TeamID>.<bundle id>" makes /s/* and /p/* open in the Based app.
    static func aasa() -> HTTPServer.Response {
        guard let app = ProcessInfo.processInfo.environment["BASED_APPLE_APP_ID"], !app.isEmpty else { return .text("Not configured", status: 404) }
        let json: JSONValue = .object(["applinks": .object(["details": .array([.object([
            "appIDs": .array([.string(app)]),
            "components": .array([.object(["/": .string("/s/*")]), .object(["/": .string("/p/*")])]),
        ])])])])
        return .json(json)
    }
}

/// Page shown when someone opens an invite link: enter a name, get access (the device token is kept in the browser).
enum InvitePage {
    static func html(title: String, role: ShareRole) -> String {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\"", with: "&quot;") }
        return """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Join “\(esc(title))” on Based</title>
        <style>body{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#37352f;max-width:420px;margin:12vh auto;padding:0 20px}
        input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #ddd;width:100%;box-sizing:border-box;margin-top:10px}
        button{background:#2383e2;color:#fff;border:none;cursor:pointer}.muted{color:#787774;font-size:14px}
        @media (prefers-color-scheme: dark){body{background:#191919;color:#d4d4d4}input{background:#252525;color:#d4d4d4;border-color:#373737}}</style></head>
        <body><h2>You're invited to “\(esc(title))”</h2>
        <p class="muted">\(esc(role.label)). Enter your name so others know who made changes.</p>
        <input id="name" placeholder="Your name" autofocus>
        <label class="muted" style="display:block;margin-top:10px"><input id="keep" type="checkbox" checked style="width:auto;margin:0 6px 0 0">Keep me signed in on this device</label>
        <button id="go">Join</button><p class="muted" id="msg"></p>
        <script>
        document.getElementById("go").onclick = async () => {
          const secret = location.pathname.split("/").pop();
          const r = await fetch("/share/v1/invites/accept", { method: "POST", headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({ secret, name: document.getElementById("name").value }) });
          const j = await r.json();
          if (!r.ok) { document.getElementById("msg").textContent = j.error || "Couldn't join."; return; }
          try { sessionStorage.setItem("based.token", j.token); if (document.getElementById("keep").checked) localStorage.setItem("based.token", j.token); } catch (e) {}
          location.href = "/app#" + j.pageID;
        };
        </script></body></html>
        """
    }
}
