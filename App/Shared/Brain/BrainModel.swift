import SwiftUI
import Observation
import BasedCore
import BasedBrain

struct ChatTurn: Identifiable, Equatable {
    let id = UUID()
    var role: ChatMessage.Role
    var text: String
    var progress: [String] = []
    /// Assistant turns: thinking, tool calls, to-dos and text, in order (Claude-style rendering).
    var reply = ChatTurnBuilder()
    /// User turns: names of attached files.
    var attachments: [String] = []
    /// Assistant turns: "Claude Code · 12 s · $0.01".
    var meta: String?
    var isRunning = false
    var failed = false
    var started = Date()
}

/// A file attached to the next message (composer chips).
struct ChatAttachment: Identifiable, Equatable {
    let id = UUID()
    var url: URL
    var name: String { url.lastPathComponent }
    var isImage: Bool { FileDrop.imageExt.contains(url.pathExtension.lowercased()) }

    /// Prompt text for the attachment: text files inline (up to 60 KB), others by path — Claude Code and the
    /// coding agents can open the path themselves.
    func promptText() -> String {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let textExt: Set<String> = ["md", "markdown", "txt", "csv", "json", "swift", "js", "ts", "tsx", "py", "rb", "go", "rs", "html", "css", "yml", "yaml", "toml", "xml", "sh", "c", "h", "m", "java", "kt", "sql", "log"]
        if textExt.contains(url.pathExtension.lowercased()), let d = try? Data(contentsOf: url), d.count <= 60_000, let s = String(data: d, encoding: .utf8) {
            return "Attached file `\(name)`:\n```\(url.pathExtension.lowercased())\n\(s)\n```"
        }
        return "Attached file: \(url.path)"
    }
}

/// App-side owner of the Agent Brain: providers, runtime, scheduler, server sync, chat state.
@MainActor @Observable
final class BrainModel {
    let store: WorkspaceStore
    /// Where imported files go (set by the app model).
    @ObservationIgnored weak var assets: FileAssetStore?
    let brain: BrainStore
    let tools: AgentTools
    let happier: HappierModel
    @ObservationIgnored private(set) var registry = ModelRegistry()
    @ObservationIgnored private(set) var runtime: AgentRuntime
    @ObservationIgnored private var scheduler: AgentScheduler?
    @ObservationIgnored private(set) var serverSync: ServerSync?
    @ObservationIgnored private var secretsObserver: NSObjectProtocol?

    var turns: [ChatTurn] = []
    var isRunning = false
    /// Artifact shown in the panel next to the chat (nil = closed).
    var artifact: ChatArtifact?
    /// Set when a reply finishes with an artifact; the full-page chat opens it (the docked panel only shows the card).
    var newArtifact: ChatArtifact?
    var showPanel = false
    var serverStatus = "Off"
    var schedulerLog: [String] = []

    // Settings (non-secret)
    var defaultModel: String {
        get { UserDefaults.standard.string(forKey: "ai.model") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "ai.model") }
    }
    var serverURL: String {
        get { UserDefaults.standard.string(forKey: "server.url") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "server.url") }
    }
    var ollamaURL: String {
        get { UserDefaults.standard.string(forKey: "ai.ollama") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "ai.ollama") }
    }
    var runSchedulesLocally: Bool {
        get { UserDefaults.standard.object(forKey: "ai.localScheduler") as? Bool ?? false }
        set { UserDefaults.standard.set(newValue, forKey: "ai.localScheduler"); configureScheduler() }
    }

    init(store: WorkspaceStore) {
        self.store = store
        brain = BrainStore(store: store)
        tools = AgentTools(store: store, brain: brain)
        happier = HappierModel(store: store, brain: brain, tools: tools)
        runtime = AgentRuntime(registry: registry, tools: tools)
        reloadProviders()
        configureScheduler()
        startServerSyncIfConfigured()
        detectClaude()
        // Keys arrive from the Keychain in the background (see `Secrets`): pick them up when they do.
        secretsObserver = NotificationCenter.default.addObserver(forName: Secrets.didLoad, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.secretsLoaded() }
        }
    }

    private func secretsLoaded() {
        reloadProviders()
        if serverSync == nil { startServerSyncIfConfigured() }
        happier.secretsLoaded()
    }

    // MARK: Providers

    var hasProvider: Bool { !registry.all.isEmpty }
    var providerSummary: String { registry.all.map(\.displayName).joined(separator: ", ").nonEmptyOr("None configured") }

    func reloadProviders() {
        let r = ModelRegistry()
        if let k = Secrets.get("anthropic"), !k.isEmpty {
            let effort = engineSpec.kind == .api && !engineSpec.effort.isEmpty ? engineSpec.effort : nil
            r.register(AnthropicProvider(apiKey: k, effort: effort))
        }
        if let k = Secrets.get("openai"), !k.isEmpty { r.register(OpenAIProvider(apiKey: k)) }
        if let u = URL(string: ollamaURL), !ollamaURL.isEmpty { r.register(OpenAIProvider.ollama(baseURL: u)) }
        if AppleIntelligenceProvider.isAvailable { r.register(AppleIntelligenceProvider()) }
        registry = r
        runtime = AgentRuntime(registry: r, tools: tools)
        configureScheduler()
    }

    var modelChoices: [String] {
        registry.all.flatMap { p in p.models.map { "\(p.id)/\($0)" } }
    }

    // MARK: Chat (⌘J panel and full-page chat)

    /// The conversation shown in the chat panel; persisted as a session with agent id "based".
    var chatID: RecordID?
    /// What answers in the chat (picker under the composer): Auto, a coding-agent CLI with model / effort /
    /// permission mode, or an API model. Stored as JSON; old plain values ("auto", "claude-code", refs) still load.
    var engineSpec: ChatEngineSpec = ChatEngineSpec.decode(UserDefaults.standard.string(forKey: "ai.chatEngine")) {
        didSet {
            UserDefaults.standard.set(engineSpec.encoded, forKey: "ai.chatEngine")
            if engineSpec.effort != oldValue.effort || engineSpec.kind != oldValue.kind { reloadProviders() }
        }
    }

    enum Engine: Equatable { case model(String), cli(ChatEngineSpec), none }

    /// Auto: an API / server model (tools, big context) → Claude Code (the user's subscription, tools via MCP)
    /// → Codex → Apple Intelligence on device (no tools, small window — last resort).
    var resolvedEngine: Engine {
        switch engineSpec.kind {
        case .api where registry.resolve(engineSpec.model) != nil: return .model(engineSpec.model)
        case .claudeCode, .codex, .gemini, .opencode:
            if installedCLIs.contains(engineSpec.kind) { return .cli(engineSpec) }
        default: break
        }
        if let p = registry.byChatPreference.first(where: { !$0.isOnDevice }) {
            let ref = defaultModel.isEmpty || registry.resolve(defaultModel)?.0.isOnDevice == true ? "\(p.id)/\(p.models.first ?? "")" : defaultModel
            return .model(ref)
        }
        if installedCLIs.contains(.claudeCode) { return .cli(ChatEngineSpec(kind: .claudeCode)) }
        if installedCLIs.contains(.codex) { return .cli(ChatEngineSpec(kind: .codex)) }
        if let p = registry.all.first(where: \.isOnDevice) { return .model("\(p.id)/\(p.models.first ?? "")") }
        return .none
    }

    /// Label for meta lines ("Claude Code · Opus 5.5").
    var chatEngine: String {
        switch resolvedEngine {
        case .model(let ref): return ref.hasPrefix("apple/") ? "Apple Intelligence (on device)" : ref
        case .cli(let s): return s.model.isEmpty ? s.kind.title : s.kind.title + " · " + CLICatalog.label(ChatEngineSpec(kind: s.kind, model: s.model))
        case .none: return "No AI configured"
        }
    }

    /// API models grouped by provider for the picker.
    var apiModelGroups: [(provider: String, onDevice: Bool, models: [String])] {
        registry.byChatPreference.map { p in (p.displayName, p.isOnDevice, p.models.map { m in "\(p.id)/\(m)" }) }
    }

    /// Working folder for coding-agent CLIs in the chat (Claude Code app: the project you work in).
    var chatFolder: String = UserDefaults.standard.string(forKey: "ai.chatFolder") ?? NSHomeDirectory() {
        didSet {
            UserDefaults.standard.set(chatFolder, forKey: "ai.chatFolder")
            var recent = recentFolders.filter { $0 != chatFolder }
            recent.insert(chatFolder, at: 0)
            recentFolders = Array(recent.prefix(6))
        }
    }
    var recentFolders: [String] = UserDefaults.standard.stringArray(forKey: "ai.recentFolders") ?? [] {
        didSet { UserDefaults.standard.set(recentFolders, forKey: "ai.recentFolders") }
    }

    /// Coding-agent CLIs found on this Mac (login-shell PATH), resolved in the background at launch.
    var installedCLIs: Set<ChatEngineSpec.Kind> = []
    /// Claude Code installed (used for chat when no API key is configured — runs on the user's subscription).
    var claudeAvailable: Bool { installedCLIs.contains(.claudeCode) }

    func detectClaude() {
        #if os(macOS)
        Task.detached(priority: .utility) { [weak self] in
            var found: Set<ChatEngineSpec.Kind> = []
            for k in [ChatEngineSpec.Kind.claudeCode, .codex, .gemini, .opencode] {
                if let c = k.command, ShellEnvironment.which(c) != nil { found.insert(k) }
            }
            if !found.contains(.opencode), FileManager.default.fileExists(atPath: "/Applications/OpenCode.app/Contents/MacOS/opencode-cli") {
                found.insert(.opencode)
            }
            let f = found
            await MainActor.run { self?.installedCLIs = f }
        }
        #endif
    }

    func newChat() { chatID = nil; turns = []; isRunning = false; artifact = nil }

    func openChat(_ id: RecordID?) {
        guard let id else { newChat(); return }
        guard id != chatID || turns.isEmpty else { return }
        chatID = id
        artifact = nil
        // Group everything between two user messages into one assistant turn with its parts.
        var out: [ChatTurn] = []
        var pending: [TranscriptItem] = []
        func flushReply() {
            guard !pending.isEmpty else { return }
            var t = ChatTurn(role: .assistant, text: "")
            for part in ChatTurnBuilder.parts(from: pending) { t.reply.restore(part) }
            t.text = t.reply.text
            t.failed = pending.contains { $0.kind == .error }
            out.append(t)
            pending = []
        }
        for item in TranscriptParser.parse(brain.transcript(id)) {
            if item.kind == .user { flushReply(); out.append(ChatTurn(role: .user, text: item.text)) }
            else { pending.append(item) }
        }
        flushReply()
        turns = out
    }

    /// The running reply (Stop button).
    @ObservationIgnored private var runningTask: Task<Void, Never>?
    func stop() { runningTask?.cancel() }

    func ask(_ prompt: String, pageContext: RecordID? = nil, attachments: [ChatAttachment] = []) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty, !isRunning else { return }
        let engine = resolvedEngine
        let onDevice: Bool = { if case .model(let r) = engine { return r.hasPrefix("apple/") }; return false }()
        var p = trimmed
        for a in attachments { p += "\n\n" + a.promptText() }
        if let pageContext, store.blocks[pageContext] != nil, !store.isTrashed(pageContext) {
            let title = store.title(of: pageContext).nonEmptyOr("Untitled")
            if onDevice {
                // No tools on device: hand over the page text itself (short).
                let body = MarkdownExporter(store: store).export(page: pageContext, includeTitle: false)
                p += "\n\n---\nOpen page “\(title)”:\n" + String(body.prefix(1500))
            } else {
                p += "\n\n---\nContext: the user has the page “\(title)” open (page id \(pageContext)). Read it with the tools only if the question is about it."
            }
        }
        let shown = trimmed.isEmpty ? attachments.map(\.name).joined(separator: ", ") : trimmed
        // Persist: the first message creates the chat.
        let sid: RecordID
        if let c = chatID, store.blocks[c] != nil { sid = c } else {
            sid = brain.createSession(title: String(shown.prefix(60)), agentID: "based", machine: happier.machineName,
                                      cwd: cliSpecForSession(engine) ? chatFolder : "", encrypted: false)
            chatID = sid
        }
        let attachNote = attachments.isEmpty ? "" : "\n\n" + attachments.map { "📎 \($0.name)" }.joined(separator: "  ")
        brain.appendTranscript(sid, role: "You", markdown: shown + attachNote)
        brain.updateSession(sid, status: .running)
        Log.breadcrumb("ask AI (\(trimmed.count) chars, \(attachments.count) files)")
        var user = ChatTurn(role: .user, text: trimmed)
        user.attachments = attachments.map(\.name)
        turns.append(user)
        var reply = ChatTurn(role: .assistant, text: "")
        reply.isRunning = true
        turns.append(reply)
        let replyID = reply.id
        isRunning = true
        let history: [ChatMessage] = turns.dropLast(2).filter { !$0.text.isEmpty }.map { ChatMessage(role: $0.role, content: $0.text) }
        let rt = runtime
        // Events land on the reply turn (looked up by id: the list may change while it runs).
        let apply: @MainActor (ChatEvent) -> Void = { [weak self] e in
            guard let self, let i = self.turns.firstIndex(where: { $0.id == replyID }) else { return }
            self.turns[i].reply.apply(e)
        }
        rt.onEvent = { e in Task { @MainActor in apply(e) } }
        rt.onProgress = nil
        let cliSpec: ChatEngineSpec? = { if case .cli(let s) = engine { return s }; return nil }()
        // A chat remembers its CLI session as "<kind>:<id>"; switching the engine starts a fresh CLI session.
        let resumeKey = (cliSpec?.kind.rawValue ?? "") + ":"
        let stored = brain.sessions().first { $0.id == sid }?.acpSessionID
        let resume: String? = {
            guard let stored, let spec = cliSpec else { return nil }
            if spec.kind == .claudeCode, stored.hasPrefix("claude:") { return String(stored.dropFirst(7)) }
            return stored.hasPrefix(resumeKey) ? String(stored.dropFirst(resumeKey.count)) : nil
        }()
        let context = cliSpec != nil ? brain.systemContext(query: trimmed) : ""
        let mcp = cliSpec != nil ? happier.mcpConfig(session: sid) : nil
        let engineLabel = chatEngine
        let mcpEndpoint = happier.runtime.mcpEndpoint
        // The chat keeps the folder it started in (reopened chats resume there).
        let folder: String = {
            let saved = brain.sessions().first { $0.id == sid }?.cwd ?? ""
            return saved.isEmpty ? chatFolder : saved
        }()
        runningTask = Task {
            var failed = false
            do {
                if case .model(let ref) = engine {
                    let o = try await rt.run(prompt: p, modelRef: ref, history: history, callerSession: sid)
                    try Task.checkCancellation()
                    apply(.result(text: o.text.isEmpty ? "(done)" : o.text, sessionID: nil, costUSD: nil, isError: false))
                } else if let spec = cliSpec {
                    let system = "You are the assistant inside Based, a Notion-like notes app. Use the `based` MCP tools to search, read and edit the user's pages and databases. Answer in the user's language, concisely, in Markdown. \(Self.artifactHint)\n\n" + BasedGuide.instructions + "\n\n" + String(context.prefix(6000))
                    let result: Result<ClaudePrint.Reply, Error>
                    var sessionFromStream: String?
                    let track: @MainActor (ChatEvent) -> Void = { e in
                        if case .started(_, let s?) = e { sessionFromStream = s }
                        apply(e)
                    }
                    switch spec.kind {
                    case .claudeCode:
                        result = await ClaudePrint.stream(p, resume: resume, cwd: folder, appendSystemPrompt: system, mcpConfig: mcp,
                                                          allowedTools: mcp == nil ? [] : ["mcp__based"],
                                                          model: spec.model.isEmpty ? nil : spec.model,
                                                          effort: spec.effort.isEmpty ? nil : spec.effort,
                                                          permissionMode: spec.permission.isEmpty ? nil : spec.permission,
                                                          permissionPromptTool: mcp != nil && spec.permission != "bypassPermissions" ? "mcp__based__approval" : nil,
                                                          onEvent: track)
                    default:
                        result = await Self.runCLI(spec, prompt: p, resume: resume, system: system, cwd: folder,
                                                   mcp: mcpEndpoint.map { ("\($0.0)/mcp/session/\(sid)", $0.1) }, onEvent: track)
                    }
                    switch result {
                    case .success(let r):
                        if let cs = r.sessionID ?? sessionFromStream {
                            brain.updateSession(sid, acpSessionID: (spec.kind == .claudeCode ? "claude" : spec.kind.rawValue) + ":" + cs)
                        }
                    case .failure(let e): throw e
                    }
                } else {
                    throw ChatError.noEngine
                }
            } catch {
                failed = true
                let msg = Task.isCancelled ? "Stopped." : "⚠️ \(error)"
                apply(.result(text: "", sessionID: nil, costUSD: nil, isError: true))
                if let i = turns.firstIndex(where: { $0.id == replyID }) {
                    turns[i].reply.restore(ChatPart(id: "err", kind: .text, text: msg))
                }
                brain.appendTranscript(sid, role: "Error", markdown: msg)
                Log.error("Chat failed: \(error)", category: "ai")
            }
            if let i = turns.firstIndex(where: { $0.id == replyID }) {
                let r = turns[i].reply
                turns[i].text = r.text
                turns[i].isRunning = false
                turns[i].failed = failed
                var meta = [engineLabel, "\(Int(Date().timeIntervalSince(turns[i].started).rounded())) s"]
                if let c = r.costUSD { meta.append(String(format: "$%.3f", c)) }
                turns[i].meta = meta.joined(separator: " · ")
                if !failed, let a = ChatArtifact.extract(r.text).last { newArtifact = a }
                for (role, md) in r.transcriptSections where !(failed && role == "Agent" && md.isEmpty) {
                    brain.appendTranscript(sid, role: role, markdown: md)
                }
                brain.updateSession(sid, status: failed ? .failed : .done, result: r.text)
            }
            rt.onEvent = nil
            isRunning = false
            runningTask = nil
        }
    }

    /// Inline AI ("space on an empty line"): writes Markdown to insert into `pageID` with the current engine.
    /// No chat is saved; the page is passed as context.
    func write(_ instruction: String, pageID: RecordID) async throws -> String {
        let title = store.title(of: pageID).nonEmptyOr("Untitled")
        let body = String(MarkdownExporter(store: store).export(page: pageID, includeTitle: false).prefix(8000))
        let system = "You write content that goes straight into a page of the user's notes app. Reply with the content only, in Markdown (headings, lists, to-dos, tables, code blocks allowed) — no preamble, no closing remarks, no code fence around the whole answer. Match the page's language unless asked otherwise."
        let prompt = "Page “\(title)”:\n\n\(body)\n\n---\nTask: \(instruction)"
        switch resolvedEngine {
        case .model(let ref):
            guard let (provider, model) = registry.resolve(ref) else { throw ChatError.noEngine }
            let r = try await provider.complete([.system(system), .user(prompt)], model: model, tools: [], maxTokens: 4096)
            return r.message.content
        case .cli(let spec):
            if spec.kind == .claudeCode {
                switch await ClaudePrint.ask(prompt, cwd: chatFolder, appendSystemPrompt: system, model: spec.model.isEmpty ? nil : spec.model) {
                case .success(let r): return r.text
                case .failure(let e): throw e
                }
            }
            let collected = TextCollector()
            let result = await Self.runCLI(spec, prompt: prompt, resume: nil, system: system, cwd: chatFolder, mcp: nil) { e in
                if case .text(let t) = e { collected.parts.append(t) }
            }
            if case .failure(let e) = result { throw e }
            return collected.parts.joined(separator: "\n\n")
        case .none:
            throw ChatError.noEngine
        }
    }

    @MainActor final class TextCollector { var parts: [String] = [] }

    private func cliSpecForSession(_ e: Engine) -> Bool { if case .cli = e { return true }; return false }

    /// Codex / Gemini / OpenCode: streamed through `CLIChatRunner` with the matching line parser.
    nonisolated static func runCLI(_ spec: ChatEngineSpec, prompt: String, resume: String?, system: String, cwd: String,
                                   mcp: (url: String, token: String)?,
                                   onEvent: @escaping @MainActor (ChatEvent) -> Void) async -> Result<ClaudePrint.Reply, Error> {
        #if os(macOS)
        guard let cmd = spec.kind.command else { return .failure(ChatError.noEngine) }
        let exe = ShellEnvironment.which(cmd)
            ?? (spec.kind == .opencode ? "/Applications/OpenCode.app/Contents/MacOS/opencode-cli" : nil)
        guard let exe, FileManager.default.isExecutableFile(atPath: exe) else {
            return .failure(ClaudePrint.Failure(description: "\(spec.kind.title) is not installed."))
        }
        var env = ShellEnvironment.environment()
        let args: [String]
        let parse: @Sendable (String) -> [ChatEvent]
        switch spec.kind {
        case .codex:
            if let mcp { env["BASED_MCP_TOKEN"] = mcp.token }
            args = CLIChatArguments.codex(prompt: prompt, spec: spec, resume: resume, mcpURL: mcp?.url, systemPrompt: system)
            parse = CodexChatStream.events(fromLine:)
        case .gemini:
            args = CLIChatArguments.gemini(prompt: prompt, spec: spec, resume: resume, systemPrompt: system)
            parse = GeminiChatStream.events(fromLine:)
        case .opencode:
            args = CLIChatArguments.opencode(prompt: prompt, spec: spec, resume: resume, systemPrompt: system)
            parse = OpenCodeChatStream.events(fromLine:)
        default:
            return .failure(ChatError.noEngine)
        }
        let dir = FileManager.default.fileExists(atPath: cwd) ? cwd : NSHomeDirectory()
        return await CLIChatRunner.run(executable: exe, arguments: args, environment: env, cwd: dir,
                                       parse: parse, onEvent: onEvent)
        #else
        return .failure(ChatError.noEngine)
        #endif
    }

    /// Tells the model how to produce artifacts the chat can show in its panel.
    static let artifactHint = "For visual or interactive results (a web page, chart, small app, diagram, illustration) reply with ONE complete fenced block — ```html (self-contained, inline CSS/JS, CDNs allowed), ```svg, ```mermaid or ```jsx (a React component with `export default`, Tailwind classes work) — and keep the text around it short; the app shows it as a live artifact. For a longer standalone document the user may keep (a plan, report, letter, summary, notes) put it in ONE ```markdown block starting with a # title; the app shows it as a document they can read and save as a page. When you create or edit workspace pages with tools, the app shows them as cards, so do not repeat their content."

    enum ChatError: Error, CustomStringConvertible {
        case noEngine
        var description: String {
            "No AI is configured. Add an API key (Settings → Agent Brain) or install Claude Code (`npm install -g @anthropic-ai/claude-code`, then `claude` once to log in)."
        }
    }

    func clearChat() { newChat() }

    // MARK: Agents & scheduler

    func runAgent(_ a: Agent) {
        schedulerLog.append("Running \(a.name)…")
        Task { if let o = await runtime.run(agent: a) { schedulerLog.append("\(a.name): \(o.usage.total) tokens") } else { schedulerLog.append("\(a.name) failed") } }
    }

    private func configureScheduler() {
        scheduler?.stop(); scheduler = nil
        guard runSchedulesLocally, hasProvider else { return }
        let s = AgentScheduler(runtime: runtime)
        s.onEvent = { [weak self] line in Task { @MainActor in self?.schedulerLog.append(line); if (self?.schedulerLog.count ?? 0) > 200 { self?.schedulerLog.removeFirst() } } }
        s.start(); scheduler = s
    }

    // MARK: Smart properties

    /// Fill a property for the given rows with the configured model (Apple Intelligence preferred when available).
    func autofill(databaseID: RecordID, propertyID: String, rows: [RecordID], instruction: String? = nil) async {
        guard let db = store.databases[databaseID], let p = db.properties.first(where: { $0.id == propertyID }) else { return }
        let ref = registry.provider("apple") != nil ? "apple/on-device" : defaultModel
        guard let (provider, model) = registry.resolve(ref) else { return }
        for id in rows {
            let text = store.title(of: id) + "\n" + MarkdownExporter(store: store).export(page: id, includeTitle: false)
            do {
                switch p.type {
                case .select, .status:
                    let names = (p.options ?? []).map(\.name)
                    if let pick = try await SmartTasks.categorise(text: text, options: names, using: provider, model: model),
                       let oid = p.option(named: pick)?.id { store.setValue(id, p.id, p.type == .status ? .status(oid) : .select(oid)) }
                case .multiSelect:
                    let names = (p.options ?? []).map(\.name)
                    let picks = try await SmartTasks.fill(property: p.name, instruction: "Choose zero or more from: \(names.joined(separator: ", ")). Comma-separated.", text: text, using: provider, model: model)
                    let ids = picks.split(separator: ",").compactMap { p.option(named: $0.trimmingCharacters(in: .whitespaces))?.id }
                    store.setValue(id, p.id, .multiSelect(ids))
                case .checkbox:
                    let v = try await SmartTasks.fill(property: p.name, instruction: "Answer yes or no.", text: text, using: provider, model: model)
                    store.setValue(id, p.id, .checkbox(v.lowercased().hasPrefix("y")))
                default:
                    let v = try await SmartTasks.fill(property: p.name, instruction: instruction, text: text, using: provider, model: model)
                    store.setValue(id, p.id, .text(RichText(v)))
                }
            } catch { schedulerLog.append("Autofill failed: \(error)") }
        }
    }

    // MARK: Server sync

    func startServerSyncIfConfigured() {
        serverSync?.stop(); serverSync = nil
        guard let url = URL(string: serverURL), !serverURL.isEmpty, let token = Secrets.get("server.token"), !token.isEmpty else { serverStatus = "Off"; return }
        let s = ServerSync(store: store, baseURL: url, token: token)
        s.onStatus = { [weak self] st in self?.serverStatus = st }
        s.start(); serverSync = s
        serverStatus = "Connecting…"
    }

    func syncServerNow() { Task { await serverSync?.syncNow() } }

    // MARK: Notion import

    func importFromNotion(token: String, memoriesDB: String, skillsDB: String, aboutPage: String, pages: [String]) async -> String {
        let imp = NotionAPIImporter(token: token)
        imp.onProgress = { [weak self] s in Task { @MainActor in self?.schedulerLog.append(s) } }
        do {
            let r = try await imp.importBrain(memoriesDatabaseID: memoriesDB.nonEmptyOrNil, skillsDatabaseID: skillsDB.nonEmptyOrNil, aboutPageID: aboutPage.nonEmptyOrNil, into: brain)
            // Pages and databases go through the full-fidelity importer (views, formulas, relations, files).
            let targets = pages.compactMap { NotionTarget($0.hasPrefix("db:") ? String($0.dropFirst(3)) : $0) }
            var n = 0
            if !targets.isEmpty {
                let pr = try await NotionWorkspaceImport(token: token).run(targets, into: store, assets: assets)
                n = pr.pages + pr.databases
            }
            return "Imported \(r.memories) memories, \(r.skills) skills, \(n) pages & databases."
        } catch { return "Import failed: \(error)" }
    }
}

extension String {
    func nonEmptyOr(_ alt: String) -> String { isEmpty ? alt : self }
    var nonEmptyOrNil: String? { isEmpty ? nil : self }
}
