import SwiftUI
import Observation
import BasedCore
import BasedBrain

struct ChatTurn: Identifiable, Equatable {
    let id = UUID()
    var role: ChatMessage.Role
    var text: String
    var progress: [String] = []
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
        if let k = Secrets.get("anthropic"), !k.isEmpty { r.register(AnthropicProvider(apiKey: k)) }
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
    /// The chat engine the user picked under the composer: "auto", "claude-code" or a model ref
    /// ("anthropic/claude-…", "apple/on-device", …).
    var chatEngineChoice: String = UserDefaults.standard.string(forKey: "ai.chatEngine") ?? "auto" {
        didSet { UserDefaults.standard.set(chatEngineChoice, forKey: "ai.chatEngine") }
    }

    enum Engine: Equatable { case model(String), claudeCode, none }

    /// Auto: an API / server model (tools, big context) → Claude Code (the user's subscription, tools via MCP)
    /// → Apple Intelligence on device (no tools, small window — last resort). Before, Apple Intelligence
    /// counted as "a provider" and won over Claude Code, which produced echo-like answers.
    var resolvedEngine: Engine {
        switch chatEngineChoice {
        case "claude-code" where claudeAvailable: return .claudeCode
        case let ref where ref != "auto" && ref != "claude-code" && registry.resolve(ref) != nil: return .model(ref)
        default: break
        }
        if let p = registry.byChatPreference.first(where: { !$0.isOnDevice }) {
            let ref = defaultModel.isEmpty || registry.resolve(defaultModel)?.0.isOnDevice == true ? "\(p.id)/\(p.models.first ?? "")" : defaultModel
            return .model(ref)
        }
        if claudeAvailable { return .claudeCode }
        if let p = registry.all.first(where: \.isOnDevice) { return .model("\(p.id)/\(p.models.first ?? "")") }
        return .none
    }

    /// Label shown under the composer.
    var chatEngine: String {
        switch resolvedEngine {
        case .model(let ref): return ref.hasPrefix("apple/") ? "Apple Intelligence (on device)" : ref
        case .claudeCode: return "Claude Code"
        case .none: return "No AI configured"
        }
    }

    struct EngineChoice: Identifiable, Hashable { let id: String; let label: String }

    /// Choices for the engine picker.
    var engineChoices: [EngineChoice] {
        var out = [EngineChoice(id: "auto", label: "Auto · " + chatEngine)]
        if claudeAvailable { out.append(EngineChoice(id: "claude-code", label: "Claude Code")) }
        for p in registry.byChatPreference {
            for m in p.models { out.append(EngineChoice(id: "\(p.id)/\(m)", label: p.isOnDevice ? "Apple Intelligence (on device)" : "\(p.id)/\(m)")) }
        }
        return out
    }

    /// Claude Code installed (used for chat when no API key is configured — runs on the user's subscription).
    /// Resolved in the background at launch (the login-shell PATH lookup can take seconds).
    var claudeAvailable = false

    func detectClaude() {
        #if os(macOS)
        Task.detached(priority: .utility) { [weak self] in
            let path = ShellEnvironment.which("claude")
            await MainActor.run { self?.claudeAvailable = path != nil }
        }
        #endif
    }

    func newChat() { chatID = nil; turns = []; isRunning = false }

    func openChat(_ id: RecordID?) {
        guard let id else { newChat(); return }
        guard id != chatID || turns.isEmpty else { return }
        chatID = id
        turns = TranscriptParser.parse(brain.transcript(id)).compactMap { item in
            switch item.kind {
            case .user: return ChatTurn(role: .user, text: item.text)
            case .agent: return ChatTurn(role: .assistant, text: item.text)
            case .error: return ChatTurn(role: .assistant, text: "⚠️ " + item.text)
            case .tool: return nil
            default: return nil
            }
        }
    }

    func ask(_ prompt: String, pageContext: RecordID? = nil) {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isRunning else { return }
        let engine = resolvedEngine
        let onDevice: Bool = { if case .model(let r) = engine { return r.hasPrefix("apple/") }; return false }()
        var p = trimmed
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
        // Persist: the first message creates the chat.
        let sid: RecordID
        if let c = chatID, store.blocks[c] != nil { sid = c } else {
            sid = brain.createSession(title: String(trimmed.prefix(60)), agentID: "based", machine: happier.machineName, cwd: "", encrypted: false)
            chatID = sid
        }
        brain.appendTranscript(sid, role: "You", markdown: trimmed)
        brain.updateSession(sid, status: .running)
        Log.breadcrumb("ask AI (\(trimmed.count) chars)")
        turns.append(ChatTurn(role: .user, text: trimmed))
        turns.append(ChatTurn(role: .assistant, text: ""))
        isRunning = true
        let history: [ChatMessage] = turns.dropLast(2).map { ChatMessage(role: $0.role, content: $0.text) }
        let rt = runtime
        let idx = turns.count - 1
        rt.onProgress = { [weak self] line in Task { @MainActor in if let self, idx < self.turns.count { self.turns[idx].progress.append(line) } } }
        let useClaude = engine == .claudeCode
        let resume = brain.sessions().first { $0.id == sid }?.acpSessionID.flatMap { $0.hasPrefix("claude:") ? String($0.dropFirst(7)) : nil }
        let context = useClaude ? brain.systemContext(query: trimmed) : ""
        let mcp = useClaude ? happier.mcpConfig(session: sid) : nil
        Task {
            var answer = ""
            do {
                if case .model(let ref) = engine {
                    let o = try await rt.run(prompt: p, modelRef: ref, history: history, callerSession: sid)
                    answer = o.text.isEmpty ? "(done)" : o.text
                } else if useClaude {
                    let system = "You are the assistant inside Based, a Notion-like notes app. Use the `based` MCP tools to search, read and edit the user's pages and databases. Answer in the user's language, concisely, in Markdown.\n\n" + String(context.prefix(6000))
                    switch await ClaudePrint.ask(p, resume: resume, appendSystemPrompt: system, mcpConfig: mcp, allowedTools: mcp == nil ? [] : ["mcp__based"]) {
                    case .success(let r):
                        answer = r.text.isEmpty ? "(done)" : r.text
                        if let cs = r.sessionID { brain.updateSession(sid, acpSessionID: "claude:" + cs) }
                    case .failure(let e): throw e
                    }
                } else {
                    throw ChatError.noEngine
                }
                if idx < turns.count { turns[idx].text = answer }
                brain.appendTranscript(sid, role: "Agent", markdown: answer)
                brain.updateSession(sid, status: .done, result: answer)
            } catch {
                if idx < turns.count { turns[idx].text = "⚠️ \(error)" }
                brain.appendTranscript(sid, role: "Error", markdown: "\(error)")
                brain.updateSession(sid, status: .failed)
                Log.error("Chat failed: \(error)", category: "ai")
            }
            isRunning = false
        }
    }

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
