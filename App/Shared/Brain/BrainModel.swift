import SwiftUI
import Observation
import BasedCore
import BasedBrain
#if canImport(Security)
import Security
#endif

/// Secrets live in the Keychain (API keys, server token); everything else in UserDefaults.
enum Secrets {
    static func get(_ key: String) -> String? {
        #if canImport(Security)
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.based.app",
                                kSecAttrAccount as String: key, kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
        #else
        return UserDefaults.standard.string(forKey: "secret." + key)
        #endif
    }

    static func set(_ key: String, _ value: String?) {
        #if canImport(Security)
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "com.based.app", kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        guard let value, !value.isEmpty else { return }
        var add = base
        add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
        #else
        UserDefaults.standard.set(value, forKey: "secret." + key)
        #endif
    }
}

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
    let brain: BrainStore
    let tools: AgentTools
    @ObservationIgnored private(set) var registry = ModelRegistry()
    @ObservationIgnored private(set) var runtime: AgentRuntime
    @ObservationIgnored private var scheduler: AgentScheduler?
    @ObservationIgnored private(set) var serverSync: ServerSync?

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
        runtime = AgentRuntime(registry: registry, tools: tools)
        reloadProviders()
        configureScheduler()
        startServerSyncIfConfigured()
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

    // MARK: Chat (⌘J)

    func ask(_ prompt: String, pageContext: RecordID? = nil) {
        guard !prompt.trimmingCharacters(in: .whitespaces).isEmpty, !isRunning else { return }
        var p = prompt
        if let pageContext { p += "\n\n(The user is currently looking at page id \(pageContext): \"\(store.title(of: pageContext))\".)" }
        turns.append(ChatTurn(role: .user, text: prompt))
        turns.append(ChatTurn(role: .assistant, text: ""))
        isRunning = true
        let history: [ChatMessage] = turns.dropLast(2).map { ChatMessage(role: $0.role, content: $0.text) }
        let rt = runtime, model = defaultModel
        let idx = turns.count - 1
        rt.onProgress = { [weak self] line in Task { @MainActor in self?.turns[idx].progress.append(line) } }
        Task {
            do {
                let o = try await rt.run(prompt: p, modelRef: model.isEmpty ? nil : model, history: history)
                turns[idx].text = o.text.isEmpty ? "(done)" : o.text
            } catch {
                turns[idx].text = "⚠️ \(error)"
            }
            isRunning = false
        }
    }

    func clearChat() { turns = [] }

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
            var n = 0
            for p in pages where !p.isEmpty {
                if p.hasPrefix("db:") { try await imp.importDatabase(String(p.dropFirst(3)), into: store, parent: .workspace) }
                else { try await imp.importPage(p, into: store, parent: .workspace, brain: brain) }
                n += 1
            }
            return "Imported \(r.memories) memories, \(r.skills) skills, \(n) page tree(s)."
        } catch { return "Import failed: \(error)" }
    }
}

extension String {
    func nonEmptyOr(_ alt: String) -> String { isEmpty ? alt : self }
    var nonEmptyOrNil: String? { isEmpty ? nil : self }
}
