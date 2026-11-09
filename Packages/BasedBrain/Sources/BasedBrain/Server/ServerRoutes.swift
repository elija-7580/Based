import Foundation
import BasedCore

/// BSD-34: everything based-server answers over HTTP, as one route table on `ServerRouter`. `main.swift` only parses
/// options, boots the services and starts the listener. Routes are owner-only unless registered otherwise
/// (ADR 0006); the handlers are the ones that used to live in `main.swift`, unchanged in behaviour.
public struct BasedServerServices {
    public var store: WorkspaceStore
    public var tools: AgentTools
    public var mcp: MCPServer
    public var sync: SyncServer
    public var runtime: AgentRuntime
    public var happier: HappierRuntime
    public var share: ShareService

    public init(store: WorkspaceStore, tools: AgentTools, mcp: MCPServer, sync: SyncServer, runtime: AgentRuntime,
                happier: HappierRuntime, share: ShareService) {
        self.store = store; self.tools = tools; self.mcp = mcp; self.sync = sync; self.runtime = runtime
        self.happier = happier; self.share = share
    }
}

public enum BasedServerRoutes {
    /// The router with every based-server route. `ownerToken` empty = open server (the caller binds it to loopback).
    @MainActor
    public static func router(_ s: BasedServerServices, ownerToken: String, allowedOrigin: String?) -> ServerRouter {
        let share = s.share
        let config = ServerRouter.Config(ownerToken: ownerToken, sessionTokens: s.happier.mcpSessionTokens, allowedOrigin: allowedOrigin,
                                         principal: { token in await MainActor.run { share.principal(forToken: token) } })
        let r = ServerRouter(config: config)
        register(on: r, s)
        ShareRoutes.register(on: r, share: share, store: s.store)
        return r
    }

    @MainActor
    static func register(on r: ServerRouter, _ s: BasedServerServices) {
        let store = s.store, tools = s.tools, mcp = s.mcp, sync = s.sync, runtime = s.runtime, happier = s.happier, share = s.share
        let large = ServerRouter.largeBodyLimit

        // MARK: Public
        let health: ServerRoute.Handler = { _ in .json(["ok": true, "name": "based-server", "time": .string(ISO8601DateFormatter().string(from: Date()))]) }
        r.add("GET", "/health", access: .public, health)
        r.add("GET", "/", access: .public, health)
        r.add("GET", "/mcp", access: .public) { _ in
            .text("SSE streaming is not supported; use POST /mcp (Streamable HTTP, JSON responses).", status: 405)
        }
        r.add("GET", "/app", access: .public) { _ in
            // Web client: loads the workspace through /sync/v2/pull. The token is entered in the page.
            WebSecurity.page(WebApp.html)   // BSD-35: nonce CSP
        }

        // MARK: MCP
        r.add("POST", "/mcp", bodyLimit: large) { ctx in
            guard let out = await mcp.handle(ctx.request.body) else { return HTTPServer.Response(status: 202) }
            return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
        }
        // BSD-33: the owner token, or this session's own token (only valid here, not for /mcp or /sync).
        r.add("POST", "/mcp/session/*", access: .session, bodyLimit: large) { ctx in
            guard let out = await mcp.handle(ctx.request.body, session: ctx.captures[0]) else { return HTTPServer.Response(status: 202) }
            return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: out)
        }

        // MARK: Diagnostics
        r.add("GET", "/logs") { ctx in
            let q = ctx.request.query
            let level = q["level"].flatMap(LogLevel.init(name:)) ?? .debug
            let limit = Int(q["limit"] ?? "") ?? 300
            let entries = Log.shared.recent(limit: limit, minLevel: level, category: q["category"], search: q["q"])
            if q["format"] == "text" { return .text(entries.map(\.line).joined(separator: "\n")) }
            let data = (try? JSONEncoder().encode(entries)) ?? Data("[]".utf8)
            return HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: data)
        }
        r.add("GET", "/cli-sessions") { ctx in
            let list = CLISessionIndex.scan(limit: Int(ctx.request.query["limit"] ?? "") ?? 200)
            let f = ISO8601DateFormatter()
            return .json(["sessions": .array(list.map { s in
                .object(["id": .string(s.id), "tool": .string(s.tool), "title": .string(s.title), "cwd": .string(s.cwd), "project": .string(s.project),
                         "updated": .string(f.string(from: s.updatedAt)), "branch": s.gitBranch.map(JSONValue.string) ?? .null,
                         "resume": .string(s.resumeCommand)]) })])
        }
        r.add("GET", "/cli-sessions/*/transcript") { ctx in
            let id = ctx.captures[0]
            guard let s = CLISessionIndex.scan(limit: 2000).first(where: { $0.id == id }) else { return .json(["error": "not found"], status: 404) }
            return .json(["messages": .array(CLISessionIndex.transcript(of: s).map { m in
                .object(["role": .string(m.role.rawValue), "text": .string(m.text), "tool": m.toolName.map(JSONValue.string) ?? .null]) })])
        }
        r.add("GET", "/doctor") { _ in
            let probed = AgentDoctor.probeTools()
            return .json(["environment": .string(ShellEnvironment.note),
                          "tools": .array(probed.map { t in .object(["id": .string(t.id), "name": .string(t.name), "path": t.path.map(JSONValue.string) ?? .null,
                                                                      "version": t.version.map(JSONValue.string) ?? .null, "install": .string(t.install)]) }),
                          "agents": .array(happier.agents.map { a in let st = AgentDoctor.status(of: a, tools: probed)
                              return .object(["id": .string(a.id), "state": .string(st.state.rawValue), "summary": .string(st.summary), "fix": st.fix.map(JSONValue.string) ?? .null]) })])
        }

        // MARK: Sync (v1 owner only; v2 also for shared principals, filtered by role)
        r.add("GET", "/sync/pull") { ctx in
            let since = ctx.request.query["since"].flatMap { try? JSONDecoder().decode(Stamp.self, from: Data($0.utf8)) }
            let env = await MainActor.run { sync.pull(since: since) }
            return json(env)
        }
        r.add("POST", "/sync/push", bodyLimit: large) { ctx in
            guard let env = try? JSONDecoder().decode(SyncEnvelope.self, from: ctx.request.body) else { return .json(["error": "bad envelope"], status: 400) }
            let reply = await MainActor.run { sync.push(env) }
            return json(reply)
        }
        r.add("GET", "/sync/v2/pull", access: .ownerOrShared) { ctx in
            // Sync v2 (docs/sync-protocol.md): page through the server's change log.
            guard ctx.principal == .owner else { return await ShareRoutes.sharedPull(ctx.principal, ctx.request, share: share, sync: sync) }
            let after = ctx.request.query["after"].flatMap { Int64($0) } ?? 0
            let limit = ctx.request.query["limit"].flatMap { Int($0) } ?? 500
            // BSD-34: a change-log read error is a 500, not an empty "you're up to date" page.
            let page: SyncPage? = await MainActor.run { try? sync.tryPullPage(after: after, limit: limit) }
            guard let page else { return .json(["error": "change log unavailable"], status: 500) }
            return json(page)
        }
        r.add("POST", "/sync/v2/push", access: .ownerOrShared, bodyLimit: large) { ctx in
            guard ctx.principal == .owner else { return await ShareRoutes.sharedPush(ctx.principal, ctx.request, share: share, sync: sync) }
            guard let p = try? JSONDecoder().decode(SyncPush.self, from: ctx.request.body) else { return .json(["error": "bad push"], status: 400) }
            let reply = await MainActor.run { sync.pushV2(p) }
            return json(reply)
        }
        r.add("GET", "/sync/v2/wait", access: .ownerOrShared) { ctx in
            let after = ctx.request.query["after"].flatMap { Int64($0) } ?? 0
            let timeout = ctx.request.query["timeout"].flatMap { Double($0) } ?? 25
            let seq = await sync.waitForChanges(after: after, timeout: timeout)
            return json(SyncWait(seq: seq))
        }
        r.add("GET", "/sync/v2/info") { _ in
            let seq = await MainActor.run { (store.persistence as? ChangeLogging)?.lastChangeSeq ?? 0 }
            return .json(["protocol": 2, "seq": .number(Double(seq))])
        }
        r.add("POST", "/api/blocks/insert-after", access: .ownerOrShared) { ctx in
            // Web client: new text block after `after` (the server computes the sort key with BasedCore).
            guard ctx.principal == .owner else { return await ShareRoutes.sharedInsert(ctx.principal, ctx.request, share: share, store: store) }
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            guard let after = body["after"]?.string else { return .json(["error": "missing after"], status: 400) }
            let text = body["text"]?.string ?? ""
            let id: String? = await MainActor.run { store.insertBlock(.text, after: after, text: RichText(text)) }
            guard let id else { return .json(["error": "no such block"], status: 404) }
            return .json(["id": .string(id)])
        }

        // MARK: Agents
        r.add("POST", "/agents/run") { ctx in
            let name = (try? JSONValue.parse(ctx.request.body))?["agent"]?.string ?? ""
            guard let agent = await MainActor.run(body: { tools.brain.agents().first { $0.name == name } }) else { return .json(["error": "no such agent"], status: 404) }
            let o = await runtime.run(agent: agent, trigger: "api")
            return .json(["ok": .bool(o != nil), "text": .string(o?.text ?? ""), "tokens": .number(Double(o?.usage.total ?? 0))])
        }
        r.add("POST", "/ask") { ctx in
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            do {
                let o = try await runtime.run(prompt: body["prompt"]?.string ?? "", modelRef: body["model"]?.string)
                return .json(["text": .string(o.text), "tokens": .number(Double(o.usage.total)), "steps": .number(Double(o.steps))])
            } catch { return .json(["error": .string("\(error)")], status: 500) }
        }

        // MARK: Happier-style control room (ACP agents, inbox, connections)
        r.add("GET", "/acp/agents") { _ in
            .json(["agents": .array(happier.agents.map { a in
                .object(["id": .string(a.id), "name": .string(a.name), "command": .string(a.command), "enabled": .bool(a.enabled),
                         "installed": .bool(FileManager.default.isExecutableFile(atPath: ProcessTransport.resolve(a.command)))]) })])
        }
        r.add("GET", "/sessions") { _ in
            let list = await MainActor.run { tools.brain.sessions() }
            return .json(["sessions": .array(list.map { sessionJSON($0, happier) })])
        }
        r.add("POST", "/sessions") { ctx in
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            let agent = body["agent"]?.string ?? "claude"
            let cwd = body["cwd"]?.string ?? FileManager.default.currentDirectoryPath
            do {
                let prompt = body["prompt"]?.string ?? ""
                if let parent = body["parent"]?.string, !parent.isEmpty, !prompt.isEmpty {
                    // Sub-agent: inherits directory/project, obeys depth and fan-out limits.
                    let sid = try await happier.spawn(agentID: agent, prompt: prompt, title: body["title"]?.string, cwd: body["cwd"]?.string,
                                                      project: body["project"]?.string, parentID: parent)
                    return .json(["id": .string(sid)])
                }
                let sid = try await happier.startSession(agentID: agent, cwd: cwd, title: body["title"]?.string,
                                                         project: body["project"]?.string, parentID: body["parent"]?.string)
                if !prompt.isEmpty {
                    Task { _ = try? await happier.prompt(sid, prompt) }
                }
                return .json(["id": .string(sid)])
            } catch { return .json(["error": .string("\(error)")], status: 500) }
        }
        r.add("POST", "/sessions/*/prompt") { ctx in
            let sid = ctx.captures[0]
            let text = (try? JSONValue.parse(ctx.request.body))?["prompt"]?.string ?? ""
            do {
                if happier.connection(for: sid) == nil { try await happier.attach(sid) }
                let stop = try await happier.prompt(sid, text)
                return .json(["stop": .string(stop.rawValue)])
            } catch { return .json(["error": .string("\(error)")], status: 500) }
        }
        r.add("GET", "/sessions/*/transcript") { ctx in
            let sid = ctx.captures[0]
            let md = await MainActor.run { tools.brain.transcript(sid, cipher: happier.cipher) }
            return .json(["markdown": .string(md)])
        }
        r.add("POST", "/sessions/*/cancel") { ctx in happier.cancel(ctx.captures[0]); return .json(["ok": true]) }
        r.add("POST", "/sessions/*/stop") { ctx in happier.stop(ctx.captures[0]); return .json(["ok": true]) }
        r.add("POST", "/sessions/*/switch") { ctx in
            let agent = (try? JSONValue.parse(ctx.request.body))?["agent"]?.string ?? "codex"
            do { try await happier.switchAgent(ctx.captures[0], to: agent); return .json(["ok": true]) }
            catch { return .json(["error": .string("\(error)")], status: 500) }
        }
        r.add("GET", "/inbox") { ctx in
            let pending = ctx.request.query["pending"] != "false"
            let items = await MainActor.run { tools.brain.inbox(pendingOnly: pending) }
            return .json(["items": .array(items.map(inboxJSON))])
        }
        r.add("POST", "/inbox/*/resolve") { ctx in
            let iid = ctx.captures[0]
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            let decision = body["decision"]?.string ?? "reject_once"
            let approved = decision.hasPrefix("allow") || decision == "approve" || body["approved"]?.bool == true
            let device = body["device"]?.string ?? "server"
            let first = await MainActor.run { tools.brain.resolveInbox(iid, decision: decision, status: approved ? .approved : .rejected, device: device) }
            // BSD-50: the first answer wins; a second device gets 409 instead of overwriting it.
            return first ? .json(["ok": true]) : .json(["ok": false, "error": "already answered"], status: 409)
        }

        // MARK: Sandboxes (BSD-53) – owner only, and only with a configured token (an open server never exposes them).
        r.add("GET", "/sandboxes", access: .ownerConfigured) { _ in
            .json(["sandbox": .string(happier.sandbox?.kind ?? "none"),
                   "sandboxes": .array(happier.sandboxes.sorted { $0.key < $1.key }.map { sandboxJSON($0.key, $0.value) })])
        }
        r.add("POST", "/sandboxes/*/snapshot", access: .ownerConfigured) { ctx in
            let sid = ctx.captures[0]
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            let name = body["name"]?.string ?? "snap-\(Int(Date().timeIntervalSince1970))"
            do { return .json(sandboxJSON(sid, try await happier.snapshotSandbox(sid, name: name))) }
            catch SandboxError.invalidName(let n) { return .json(["error": .string("invalid name \(n)")], status: 400) }
            catch { return .json(["error": .string("\(error)")], status: 500) }
        }
        r.add("POST", "/sandboxes/*/restore", access: .ownerConfigured) { ctx in
            let sid = ctx.captures[0]
            let body = (try? JSONValue.parse(ctx.request.body)) ?? .object([:])
            guard let name = body["snapshot"]?.string else { return .json(["error": "snapshot missing"], status: 400) }
            do { return .json(sandboxJSON(sid, try await happier.restoreSandbox(sid, snapshot: name))) }
            catch SandboxError.unknownSnapshot(let n) { return .json(["error": .string("unknown snapshot \(n)")], status: 404) }
            catch { return .json(["error": .string("\(error)")], status: 500) }
        }
        r.add("POST", "/sandboxes/*/destroy", access: .ownerConfigured) { ctx in
            let sid = ctx.captures[0]
            happier.stop(sid)
            await happier.destroySandbox(sid)
            return .json(["ok": true])
        }

        // MARK: Connections
        r.add("GET", "/connections") { _ in
            let list = await MainActor.run { tools.brain.connections() }
            return .json(["connections": .array(list.map { c in
                .object(["id": .string(c.id), "name": .string(c.name), "transport": .string(c.transport.rawValue), "command": .string(c.command),
                         "enabled": .bool(c.enabled), "exposeToAgents": .bool(c.exposeToAgents), "status": .string(c.status)]) })])
        }
        r.add("POST", "/connections/reload") { _ in
            await happier.connections?.reload(); return .json(["ok": true])
        }
    }

    // MARK: JSON helpers

    static func json<T: Encodable>(_ v: T) -> HTTPServer.Response {
        HTTPServer.Response(status: 200, headers: ["Content-Type": "application/json"], body: (try? JSONEncoder().encode(v)) ?? Data())
    }

    static func sandboxJSON(_ sid: RecordID, _ h: SandboxHandle) -> JSONValue {
        .object(["session": .string(sid), "provider": .string(h.provider), "id": .string(h.id), "reference": .string(h.reference),
                 "project": .string(h.project), "workdir": .string(h.workdir), "image": .string(h.image),
                 "snapshots": .array(h.snapshots.map { .object(["name": .string($0.name), "image": .string($0.image),
                                                                 "created": .string(ISO8601DateFormatter().string(from: $0.createdAt))]) })])
    }

    static func sessionJSON(_ s: AgentSession, _ happier: HappierRuntime) -> JSONValue {
        .object(["id": .string(s.id), "title": .string(s.title), "agent": .string(s.agentID), "status": .string(s.status.rawValue),
                 "machine": .string(s.machine), "cwd": .string(s.cwd), "tokens": .number(Double(s.tokens)),
                 "started": .string(ISO8601DateFormatter().string(from: s.startedAt)), "encrypted": .bool(s.encrypted),
                 "live": .bool(happier.liveSessionIDs.contains(s.id)), "project": .string(s.project),
                 "parent": s.parentID.map(JSONValue.string) ?? .null, "task": .string(s.task), "result": .string(String(s.result.suffix(2000))),
                 "working": .bool(happier.isWorking(s.id))])
    }

    static func inboxJSON(_ i: InboxItem) -> JSONValue {
        .object(["id": .string(i.id), "title": .string(i.title), "kind": .string(i.kind.rawValue), "status": .string(i.status.rawValue),
                 "session": i.sessionID.map(JSONValue.string) ?? .null, "detail": .string(i.detail),
                 "options": .array(i.options.map(JSONValue.string)), "decision": i.decision.map(JSONValue.string) ?? .null])
    }
}
