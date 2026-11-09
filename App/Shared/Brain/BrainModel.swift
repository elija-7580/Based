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
    /// BSD-49: why the router picked this engine (tooltip on the meta line).
    var why: String?
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
    /// BSD-102: merges Runs/Projects/Captures that another device created before syncing.
    @ObservationIgnored private var brainMergeToken: ObservationToken?
    let brain: BrainStore
    let tools: AgentTools
    let happier: HappierModel
    @ObservationIgnored private(set) var registry = ModelRegistry()
    @ObservationIgnored private(set) var runtime: AgentRuntime
    @ObservationIgnored private var scheduler: AgentScheduler?
    @ObservationIgnored private(set) var serverSync: ServerSync?
    @ObservationIgnored private var secretsObserver: NSObjectProtocol?

    var turns: [ChatTurn] = []
    /// A reply is running (set by the prompt queue).
    var isRunning = false
    /// BSD-48: messages sent while a reply runs, shown greyed under it; sent one after another.
    var queued: [QueuedPrompt] = []

    struct QueuedPrompt: Identifiable, Equatable { let id: UUID; var text: String }
    struct PendingAsk { var prompt: String; var pageContext: RecordID?; var attachments: [ChatAttachment] }
    @ObservationIgnored private lazy var promptQueue: ChatPromptQueue<PendingAsk> = {
        let q = ChatPromptQueue<PendingAsk> { [weak self] p in self?.startTurn(p.prompt, pageContext: p.pageContext, attachments: p.attachments) }
        q.onChange = { [weak self, weak q] in
            guard let self, let q else { return }
            self.isRunning = q.isBusy
            self.queued = q.waiting.map { QueuedPrompt(id: $0.id, text: $0.text) }
        }
        return q
    }()
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
    /// BSD-51: where scheduled agents run (default: the server when one is configured, otherwise this device).
    var scheduleHost: ScheduleHost {
        get { ScheduleHost.stored(UserDefaults.standard.string(forKey: "ai.scheduleHost"),
                                  legacyLocal: UserDefaults.standard.object(forKey: "ai.localScheduler") as? Bool) }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: "ai.scheduleHost"); configureScheduler() }
    }

    init(store: WorkspaceStore) {
        self.store = store
        brain = BrainStore(store: store)
        tools = AgentTools(store: store, brain: brain)
        happier = HappierModel(store: store, brain: brain, tools: tools)
        runtime = AgentRuntime(registry: registry, tools: tools)
        // BSD-58: coding agents / MCP clients on the local endpoint can hand work to the main agent too.
        happier.mainAgentProvider = { [weak self] in self?.mainAgent }
        brainMergeToken = brain.mergeDuplicatesAfterRemoteChanges()
        #if os(macOS)
        // BSD-111: catch up on voice notes that arrived without text (also when the server runs "Sort captures").
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            await self?.transcribeWaitingCaptures()
        }
        #endif
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

    typealias Engine = ChatEngineChoice

    /// BSD-50: permission mode for Based's own tools in the chat (composer menu; CLIs picked by Auto get the same
    /// mode as their permission flag). Rules come from Agent Brain → Permissions.
    var permissionMode: PermissionMode = PermissionMode(rawValue: UserDefaults.standard.string(forKey: "ai.permissionMode") ?? "") ?? .ask {
        didSet { UserDefaults.standard.set(permissionMode.rawValue, forKey: "ai.permissionMode") }
    }

    /// BSD-49: compute level for Auto (Low / Auto / High), picked under "Auto" in the model picker.
    var compute: ComputeLevel = ComputeLevel(rawValue: UserDefaults.standard.string(forKey: "ai.compute") ?? "") ?? .auto {
        didSet { UserDefaults.standard.set(compute.rawValue, forKey: "ai.compute") }
    }

    /// Auto: API model → Claude Code → Codex → on device (BSD-94: decided in BasedBrain, `ChatRouting.resolve`).
    var resolvedEngine: Engine {
        ChatRouting.resolve(engineSpec, registry: registry, installed: installedCLIs, defaultModel: defaultModel)
    }

    /// Label for meta lines ("Claude Code · Opus 5.5").
    var chatEngine: String { ChatRouting.label(resolvedEngine) }

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

    func newChat() { promptQueue.detach(); chatID = nil; turns = []; artifact = nil }

    // MARK: Main agent (BSD-52)

    /// The main agent for the current providers (delegation tools, routing, permissions).
    var mainAgent: MainAgent {
        let m = MainAgent(runtime: runtime)
        m.installed = []          // sub-agents use API models until coding sessions are wired as launcher (follow-up of BSD-52)
        m.defaultModel = defaultModel
        m.permissions = brain.permissions(mode: permissionMode)
        return m
    }

    /// Id of the main agent's thread (created on first use).
    func mainThreadID() -> RecordID {
        brain.ensureMainAgent()
        return brain.ensureMainThread(machine: happier.machineName)
    }

    var isMainThread: Bool { chatID.map { brain.isMainThread($0) } ?? false }

    func openChat(_ id: RecordID?) {
        guard let id else { newChat(); return }
        guard id != chatID || turns.isEmpty else { return }
        promptQueue.detach()
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

    /// Stops the engine; the turn still ends with its "Stopped." note and is saved. Waiting messages follow.
    func stop() { promptQueue.stopCurrent() }

    /// Sends a message, or queues it while a reply is running (BSD-48).
    func ask(_ prompt: String, pageContext: RecordID? = nil, attachments: [ChatAttachment] = []) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return }
        let shown = trimmed.isEmpty ? attachments.map(\.name).joined(separator: ", ") : trimmed
        promptQueue.submit(shown, PendingAsk(prompt: prompt, pageContext: pageContext, attachments: attachments))
    }

    /// Takes a waiting message back.
    func removeQueued(_ id: UUID) { promptQueue.remove(id) }
    /// Sends a waiting message now: the running reply stops (and is saved), this one goes next.
    func sendQueuedNow(_ id: UUID) { promptQueue.sendNow(id) }

    /// Starts one turn (called by the prompt queue when it is this message's turn).
    private func startTurn(_ prompt: String, pageContext: RecordID?, attachments: [ChatAttachment]) -> ChatTurnHandle? {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty || !attachments.isEmpty else { return nil }
        // BSD-49: Auto routes by task and compute level; an explicit picker choice wins. Within a chat, Auto stays
        // on the engine family of the previous turn so the conversation's context is kept.
        let attachmentTexts = attachments.map { $0.promptText() }
        let existingChat = chatID.flatMap { store.blocks[$0] != nil ? $0 : nil }
        let task = RouteTask(text: trimmed, attachmentChars: attachmentTexts.reduce(0) { $0 + $1.count },
                             folder: chatFolder == NSHomeDirectory() ? nil : chatFolder)
        let decision = ChatRouting.route(engineSpec, task: task, compute: compute, registry: registry,
                                         installed: installedCLIs, defaultModel: defaultModel)
            .keepingConversation(resumeKey: existingChat.flatMap { brain.resumeKey($0) }, hasHistory: !turns.isEmpty)
        // BSD-52: the main agent's thread always runs the main agent (low compute, delegation tools).
        let mainRef = existingChat.flatMap { brain.isMainThread($0) ? $0 : nil }.flatMap { _ in mainAgent.modelRef() }
        let engine = mainRef.map(ChatEngineChoice.model) ?? decision.choice
        let page = ChatRouting.page(pageContext, in: store, onDevice: engine.isOnDevice)
        let p = ChatRouting.prompt(trimmed, attachments: attachmentTexts, page: page, onDevice: engine.isOnDevice)
        let shown = trimmed.isEmpty ? attachments.map(\.name).joined(separator: ", ") : trimmed
        // Persist: the first message creates the chat.
        let sid: RecordID
        if let c = existingChat { sid = c } else {
            sid = brain.createSession(title: String(shown.prefix(60)), agentID: "based", machine: happier.machineName,
                                      cwd: engine.isCLI ? chatFolder : "", encrypted: false)
            chatID = sid
        }
        let attachNote = attachments.isEmpty ? "" : "\n\n" + attachments.map { "📎 \($0.name)" }.joined(separator: "  ")
        Log.breadcrumb("ask AI (\(trimmed.count) chars, \(attachments.count) files)")
        var user = ChatTurn(role: .user, text: trimmed)
        user.attachments = attachments.map(\.name)
        turns.append(user)
        var reply = ChatTurn(role: .assistant, text: "")
        reply.isRunning = true
        turns.append(reply)
        let replyID = reply.id
        // A queued turn can start before the previous reply's text was copied out of its builder.
        let history: [ChatMessage] = turns.dropLast(2).map { t in (t.role, t.text.isEmpty && t.role == .assistant ? t.reply.text : t.text) }
            .filter { !$0.1.isEmpty }.map { ChatMessage(role: $0.0, content: $0.1) }
        runtime.onProgress = nil
        // BSD-45: the turn runs in BasedBrain's ChatEngine; this view model only picks the backend and renders events.
        let backend: ChatBackend
        let system = ChatRouting.systemPrompt(for: engine, context: engine.isCLI ? brain.systemContext(query: trimmed) : "")
        switch engine {
        case .model(let ref) where mainRef != nil:
            backend = MainAgentChatBackend(agent: mainAgent, modelRef: ref)
        case .model(let ref):
            backend = ModelChatBackend(runtime: runtime, modelRef: ref, permissions: brain.permissions(mode: permissionMode))
        case .cli(var spec):
            // Auto picked a CLI: it runs with the composer's permission mode (an explicit CLI choice has its own).
            if engineSpec.kind == .auto, spec.permission.isEmpty { spec.permission = permissionMode.cliPermission(for: spec.kind) }
            if spec.kind == .claudeCode {
                backend = ClaudeCodeChatBackend(spec: spec, mcpConfig: happier.mcpConfig(session: sid))
            } else {
                // BSD-33: the chat's own short-lived MCP token, not the endpoint's master token.
                backend = CLIChatBackend(spec: spec, mcp: happier.runtime.mcpEndpoint.map { ("\($0.0)/mcp/session/\(sid)", happier.runtime.mcpToken(for: sid) ?? $0.1) })
            }
        case .none:
            backend = UnavailableChatBackend(ChatError.noEngine.description)
        }
        // The chat keeps the folder it started in (reopened chats resume there).
        let folder: String = {
            let saved = brain.sessions().first { $0.id == sid }?.cwd ?? ""
            return saved.isEmpty ? chatFolder : saved
        }()
        let chat = ChatEngine(sink: brain)
        let request = ChatRequest(prompt: p, displayPrompt: shown + attachNote, history: history,
                                  resume: chat.resume(for: sid, with: backend), cwd: folder, system: system)
        let engineLabel = mainRef != nil ? "Main agent · " + ChatRouting.label(engine)
            : [ChatRouting.label(engine), decision.routeLabel].filter { !$0.isEmpty }.joined(separator: " · ")
        let routeWhy = mainRef != nil || decision.route == nil ? nil : "\(decision.compute.title): \(decision.reason)"
        let turn = chat.send(request, session: sid, via: backend)
        if mainRef == nil { brain.noteRoute(session: sid, decision) }
        Task {
            // Events land on the reply turn (looked up by id: the list may change while it runs).
            for await e in turn.events {
                guard let i = turns.firstIndex(where: { $0.id == replyID }) else { continue }
                turns[i].reply.apply(e)
            }
            await turn.finished()
            if let i = turns.firstIndex(where: { $0.id == replyID }) {
                let r = turns[i].reply
                let failed = r.isError
                turns[i].text = r.text
                turns[i].isRunning = false
                turns[i].failed = failed
                var meta = [engineLabel, "\(Int(Date().timeIntervalSince(turns[i].started).rounded())) s"]
                if let c = r.costUSD { meta.append(String(format: "$%.3f", c)) }
                meta += r.notices   // BSD-46: "continued after the length limit" / "cut off"
                turns[i].meta = meta.joined(separator: " · ")
                turns[i].why = routeWhy
                if !failed, let a = ChatArtifact.extract(r.text).last { newArtifact = a }
            }
        }
        return turn
    }

    /// Inline AI ("space on an empty line"): writes Markdown to insert into `pageID` with the current engine.
    /// No chat is saved; the page is passed as context.
    func write(_ instruction: String, pageID: RecordID) async throws -> String {
        let title = store.title(of: pageID).nonEmptyOr("Untitled")
        let body = String(MarkdownExporter(store: store).export(page: pageID, includeTitle: false).prefix(8000))
        let system = "You write content that goes straight into a page of the user's notes app. Reply with the content only, in Markdown (headings, lists, to-dos, tables, code blocks allowed) — no preamble, no closing remarks, no code fence around the whole answer. Match the page's language unless asked otherwise."
        let prompt = "Page “\(title)”:\n\n\(body)\n\n---\nTask: \(instruction)"
        return try await complete(system: system, prompt: prompt, maxTokens: 4096)
    }


    enum ChatError: Error, CustomStringConvertible {
        case noEngine
        var description: String { ChatRouting.noEngineMessage }
    }

    func clearChat() { newChat() }

    // MARK: Agents & scheduler

    func runAgent(_ a: Agent) {
        schedulerLog.append("Running \(a.name)…")
        Task { if let o = await runtime.run(agent: a) { schedulerLog.append("\(a.name): \(o.usage.total) tokens") } else { schedulerLog.append("\(a.name) failed") } }
    }

    func configureScheduler() {
        scheduler?.stop(); scheduler = nil
        guard scheduleHost.runsOnThisDevice(serverConfigured: !serverURL.isEmpty), hasProvider else { return }
        let s = AgentScheduler(runtime: runtime, node: happier.machineName)
        s.onEvent = { [weak self] line in Task { @MainActor in self?.schedulerLog.append(line); if (self?.schedulerLog.count ?? 0) > 200 { self?.schedulerLog.removeFirst() } } }
        // BSD-111: waiting voice notes get their transcript before "Sort captures" looks at them.
        s.beforeRun = { [weak self] agent in
            guard agent.name == BrainStore.captureSorterName else { return }
            await self?.transcribeWaitingCaptures()
        }
        s.start(); scheduler = s
    }

    /// Transcribes voice notes in Captures that still have no text (on this device, with the meeting-notes model).
    func transcribeWaitingCaptures() async {
        guard let r = await VoiceCaptureService.transcribeWaiting(brain: brain, assets: assets) else { return }
        var line = "Transcribed \(r.transcribed) voice note(s)"
        if r.notOnDevice > 0 { line += ", \(r.notOnDevice) not on this Mac yet" }
        if !r.failed.isEmpty { line += ", \(r.failed.count) failed: " + r.failed.prefix(2).joined(separator: "; ") }
        schedulerLog.append(line)
        Log.notice("captures: " + line, category: "capture")
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
