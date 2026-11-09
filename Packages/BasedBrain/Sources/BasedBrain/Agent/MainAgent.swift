import Foundation
import BasedCore

// BSD-52 (ADR 0007): one main agent. The user talks to it in one continuous thread (a chat session with agent id
// "based-main"); it knows About, memories, skills and the active projects, does small things itself and delegates
// the rest to sub-agents (each a run with the main thread's run as parent, routed to a fitting model), posts updates
// into the projects' "Latest updates" and checks in on a heartbeat (its scheduled run, by default every 2 h) that
// costs nothing when nothing changed.

/// A job the main agent hands to a sub-agent.
public struct DelegatedJob: Sendable, Equatable {
    public enum Kind: String, CaseIterable, Sendable {
        case code, research, write, organize
        /// Route of the model router (BSD-49) for this kind of work.
        public var routeID: String {
            switch self {
            case .code: return "code"
            case .research: return "research"
            case .write: return "write"
            case .organize: return "general"
            }
        }
    }
    public var task: String
    public var kind: Kind
    public var projectID: RecordID?
    public var runID: RecordID
    public var parentRunID: RecordID?
    public var choice: ChatEngineChoice
    public var effort: String
}

/// Compact view of a project for the main agent's system prompt.
public struct ProjectBrief: Sendable, Equatable {
    public var id: RecordID
    public var name: String
    public var goal: String
    public var status: AgentProject.Status
    /// Newest first, at most three.
    public var updates: [String]
}

@MainActor
extension BrainStore {
    /// Agent id of the main agent's thread in the Sessions database.
    public nonisolated static let mainThreadAgentID = "based-main"
    public static let mainAgentName = "Main agent"

    /// The main agent's row, if one exists (Kind = main; adopts a row named "Main agent" from before the column).
    public func mainAgent() -> Agent? {
        let all = agents()
        return all.first(where: \.isMain) ?? all.first { $0.name == Self.mainAgentName }
    }

    /// Finds or creates the main agent: protected row in Agents with default instructions and a 2-hour heartbeat.
    @discardableResult
    public func ensureMainAgent() -> Agent {
        ensureColumn(agentsDB, AgentCol.kind, .text)
        let id: RecordID
        if let a = mainAgent() { id = a.id } else {
            id = saveAgent(name: Self.mainAgentName, instructions: MainAgent.defaultInstructions, schedule: "every 2h", model: nil)
        }
        if let p = propID(agentsDB, AgentCol.kind), text(store.blocks[id]!, agentsDB, AgentCol.kind) != AgentCol.mainKind {
            store.setValue(id, p, .text(RichText(AgentCol.mainKind)))
        }
        store.protectedIDs.insert(id)
        return agents().first { $0.id == id }!
    }

    /// The main agent's thread (a chat session), if it exists.
    public func mainThread() -> RecordID? {
        sessions().filter { $0.agentID == Self.mainThreadAgentID }.min { $0.startedAt < $1.startedAt }?.id
    }

    @discardableResult
    public func ensureMainThread(machine: String = "") -> RecordID {
        if let t = mainThread() { return t }
        return createSession(title: Self.mainAgentName, agentID: Self.mainThreadAgentID, machine: machine, cwd: "", encrypted: false)
    }

    public func isMainThread(_ sid: RecordID) -> Bool {
        sessions().first { $0.id == sid }?.agentID == Self.mainThreadAgentID
    }

    /// The newest entries of a project's "Latest updates" section.
    public func latestUpdates(ofProject id: RecordID, limit: Int = 3) -> [String] {
        let blocks = store.contentBlocks(of: id)
        guard let h = blocks.firstIndex(where: {
            [.heading1, .heading2, .heading3].contains($0.type) && $0.text.plainText.trimmingCharacters(in: .whitespaces) == Self.latestUpdatesHeading
        }) else { return [] }
        var out: [String] = []
        for b in blocks[(h + 1)...] {
            if [.heading1, .heading2, .heading3].contains(b.type) { break }
            let t = b.text.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            if !t.isEmpty { out.append(t) }
            if out.count == limit { break }
        }
        return out
    }

    /// Active projects for the main agent's prompt.
    public func projectBriefs() -> [ProjectBrief] {
        projects().filter { $0.status == .active }.map {
            ProjectBrief(id: $0.id, name: $0.name, goal: $0.goal, status: $0.status, updates: latestUpdates(ofProject: $0.id))
        }
    }

    /// Runs the main agent delegated (sub-agent runs charged to the main agent), newest first.
    public func delegatedRuns() -> [AgentRun] {
        guard let main = mainAgent() else { return [] }
        return runs(RunFilter(kinds: [.subagent], agentID: main.id))
    }

    /// Heartbeat (no model call): for each delegated run that ended since `lastBeat`, an update in its project and a
    /// notice in the thread; failed runs also land in the Inbox. Returns the number of runs reported.
    @discardableResult
    public func mainHeartbeat(lastBeat: Date?, now: Date = Date()) -> Int {
        guard let main = mainAgent() else { return 0 }
        let done = MainAgent.finishedDelegations(runs(RunFilter(kinds: [.subagent], agentID: main.id)), since: lastBeat)
        guard !done.isEmpty else { return 0 }
        let thread = mainThread()
        for r in done.reversed() {   // oldest first, so the newest update ends on top
            let line = MainAgent.updateLine(r)
            if let p = r.projectID { postProjectUpdate(p, line, at: r.endedAt ?? now) }
            if let thread { appendTranscript(thread, role: "Notice", markdown: line + " (run \(r.id))") }
            if r.status == .failed {
                addInbox(title: "Sub-agent failed: \(r.title)", kind: .notice, sessionID: thread, detail: r.result)
            }
        }
        let beat = startRun(title: "Heartbeat", kind: .main, agentID: main.id, engine: "based", at: now)
        finish(run: beat, result: "Reported \(done.count) finished run(s).", at: now)
        return done.count
    }
}

/// The main agent: system prompt, delegation tools and the chat backend for its thread.
public final class MainAgent: @unchecked Sendable {
    public let runtime: AgentRuntime
    public var router = ModelRouter()
    /// CLIs installed on this machine (a "code" job may go to Claude Code / Codex through `cliLauncher`).
    public var installed: Set<ChatEngineSpec.Kind> = []
    public var defaultModel = ""
    /// The main agent itself runs with low compute; sub-agents default to Auto.
    public var compute: ComputeLevel = .low
    public var permissions: AgentPermissions?
    /// Runs a job on a coding CLI and returns its final answer. Without it, CLI choices fall back to an API model.
    public var cliLauncher: (@Sendable (DelegatedJob) async throws -> String)?
    private let jobs = Locked<[Task<Void, Never>]>([])

    public init(runtime: AgentRuntime) { self.runtime = runtime }

    public static let defaultInstructions = """
    You are the user's main agent — like a chief of staff. Answer briefly. Do small things (a quick answer, a note, \
    a memory) yourself. Hand anything bigger — coding, research, writing, reorganising — to a sub-agent with the \
    delegate tool, one task per call, and tell the user in one sentence what you started. Use check_runs to see how \
    delegated work is going, and report to post a short update into a project when something worth knowing happened.
    """

    // MARK: Prompt

    /// Instructions plus a compact overview of the active projects (name, goal, last three updates).
    public static func systemPrompt(instructions: String, projects: [ProjectBrief]) -> String {
        var s = "# Main agent\n" + (instructions.isEmpty ? defaultInstructions : instructions)
        s += "\n\n# Active projects\n"
        if projects.isEmpty { s += "(none yet — delegate without a project, or create one when the user asks)\n" }
        for p in projects {
            s += "- \(p.name) (id \(p.id))" + (p.goal.isEmpty ? "" : ": \(p.goal)") + "\n"
            for u in p.updates { s += "  - \(String(u.prefix(200)))\n" }
        }
        s += "\nFor details of a project use get_project."
        return s
    }

    // MARK: Heartbeat (pure)

    /// Delegated runs that ended at or after `since`, newest first.
    public static func finishedDelegations(_ runs: [AgentRun], since: Date?) -> [AgentRun] {
        runs.filter { $0.kind == .subagent && $0.status.isTerminal && ($0.endedAt ?? $0.startedAt) >= (since ?? .distantPast) }
            .sorted { ($0.endedAt ?? $0.startedAt) > ($1.endedAt ?? $1.startedAt) }
    }

    /// Whether a heartbeat has anything to do: a delegated run of the main agent ended since the last beat. A cheap
    /// check without a model call — nothing changed, no run.
    public static func heartbeatNeeded(overview: RunOverview, mainAgentID: RecordID, lastBeat: Date?) -> Bool {
        !finishedDelegations(overview.runs.filter { $0.agentID == mainAgentID }, since: lastBeat).isEmpty
    }

    static func updateLine(_ r: AgentRun) -> String {
        let mark = r.status == .done ? "✓" : r.status == .failed ? "✗" : "–"
        let result = r.result.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        return "\(mark) \(r.title)" + (result.isEmpty ? "" : " — " + String(result.prefix(300)))
    }

    // MARK: Tools

    public static let toolSpecs: [ToolSpec] = [
        ToolSpec(name: "delegate", description: "Hand a task to a sub-agent. It runs in the background on a model chosen for the kind of work; its result is posted to the project and to this thread when it ends.",
                 inputSchema: .schema(["task": .str("Complete, self-contained instructions for the sub-agent"),
                                       "kind": .str("code | research | write | organize"),
                                       "project": .str("Optional project id or name"),
                                       "compute": .str("Optional: low | auto | high (default auto)")], required: ["task", "kind"])),
        ToolSpec(name: "check_runs", description: "List the sub-agent runs you delegated (newest first) with status and result.",
                 inputSchema: .schema([:])),
        ToolSpec(name: "report", description: "Post a short dated update into a project's \"Latest updates\".",
                 inputSchema: .schema(["project": .str("Project id or name"), "text": .str("One or two sentences")], required: ["project", "text"])),
    ]

    /// The delegation tools for a turn in the main thread `thread`.
    public func toolSet(thread: RecordID) -> AgentToolSet {
        AgentToolSet(specs: Self.toolSpecs) { [self] name, args in
            switch name {
            case "delegate": return await delegate(args, thread: thread)
            case "check_runs": return await checkRuns()
            case "report": return await report(args)
            default: return .init(text: "Unknown tool \(name)", isError: true)
            }
        }
    }

    /// Model for the main agent's own turns: the General route at its compute level.
    public func modelRef() -> String? {
        let d = router.decision(routeID: "general", reason: "main agent", compute: compute, forceLow: false,
                                registry: runtime.registry, installed: [], defaultModel: defaultModel)
        if case .model(let ref) = d.choice { return ref }
        return nil
    }

    func project(_ ref: String?) async -> (RecordID?, String?) {
        guard let ref = ref?.trimmingCharacters(in: .whitespaces), !ref.isEmpty else { return (nil, nil) }
        let brain = runtime.tools.brain
        return await MainActor.run {
            if let p = brain.project(ref) ?? brain.project(named: ref) { return (p.id, nil) }
            let names = brain.projects().map(\.name).joined(separator: ", ")
            return (nil, "Unknown project \"\(ref)\". Projects: \(names.isEmpty ? "none" : names).")
        }
    }

    func delegate(_ args: JSONValue, thread: RecordID) async -> AgentTools.ToolResult {
        let task = args["task"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !task.isEmpty else { return .init(text: "delegate needs a task.", isError: true) }
        let kind = DelegatedJob.Kind(rawValue: (args["kind"]?.stringValue ?? "").lowercased()) ?? .organize
        let level = ComputeLevel(rawValue: (args["compute"]?.stringValue ?? "").lowercased()) ?? .auto
        let (projectID, projectError) = await project(args["project"]?.stringValue)
        if let projectError { return .init(text: projectError, isError: true) }
        let d = router.decision(routeID: kind.routeID, reason: "delegated \(kind.rawValue) task", compute: level, forceLow: false,
                                registry: runtime.registry, installed: installed, defaultModel: defaultModel)
        // A CLI needs a launcher (the app's coding sessions); otherwise the next API model of the chain.
        var choice = d.choice
        if choice.isCLI, cliLauncher == nil {
            choice = d.fallbacks.first { if case .model = $0 { return true }; return false } ?? .none
        }
        let model: String, engine: String
        switch choice {
        case .model(let ref): model = ref; engine = "based"
        case .cli(let spec): model = spec.model; engine = spec.kind.rawValue
        case .none: return .init(text: "No model is available for a sub-agent. Add an API key in Settings → AI.", isError: true)
        }
        let brain = runtime.tools.brain
        let (runID, parentRunID, projectInfo) = await MainActor.run { () -> (RecordID, RecordID?, String) in
            let parent = brain.latestRun(forSession: thread)?.id
            let main = brain.mainAgent()?.id
            let id = brain.startRun(title: String(task.prefix(80)), kind: .subagent, agentID: main, parentID: parent,
                                    engine: engine, model: model, compute: level.runCompute, projectID: projectID)
            brain.logRun(id, "Delegated by the main agent (\(kind.rawValue), \(d.routeLabel.isEmpty ? "route" : d.routeLabel)). Task:\n\n" + task)
            let info = projectID.flatMap { brain.project($0) }.map { "\n\nProject: \($0.name)" + ($0.goal.isEmpty ? "" : " — goal: \($0.goal)") } ?? ""
            return (id, parent, info)
        }
        let job = DelegatedJob(task: task, kind: kind, projectID: projectID, runID: runID, parentRunID: parentRunID,
                               choice: choice, effort: d.effort)
        let t = Task { [self] in await execute(job, projectInfo: projectInfo) }
        jobs.sync { $0.append(t) }
        return .init(text: "Started sub-agent run \(runID) (\(kind.rawValue), \(model.isEmpty ? engine : model)). Its result is posted to the project and this thread when it ends; check_runs shows progress.", isError: false)
    }

    private func execute(_ job: DelegatedJob, projectInfo: String) async {
        let brain = runtime.tools.brain
        do {
            switch job.choice {
            case .cli:
                guard let cliLauncher else { throw AIError.unavailable("no coding CLI launcher") }
                let text = try await cliLauncher(job)
                await MainActor.run { brain.finish(run: job.runID, status: .done, result: text) }
            case .model(let ref):
                let o = try await runtime.run(
                    prompt: job.task,
                    modelRef: ref,
                    systemExtra: "You are a sub-agent started by the user's main agent. Do the task completely with the tools, then answer with a concise report (what you did, links/ids of pages you created)." + projectInfo,
                    permissions: permissions)
                await MainActor.run {
                    brain.finish(run: job.runID, status: .done, result: o.text, usage: o.usage,
                                 cost: ModelPricing.estimate(model: ref, usage: o.usage))
                }
            case .none:
                throw AIError.unavailable("no model")
            }
        } catch {
            await MainActor.run { brain.finish(run: job.runID, status: .failed, result: "Error: \(error)") }
        }
    }

    /// Waits until every delegated job started by this instance has ended (tests, shutdown).
    public func waitForDelegations() async {
        while true {
            let pending = jobs.sync { j -> [Task<Void, Never>] in let p = j; j = []; return p }
            if pending.isEmpty { return }
            for t in pending { await t.value }
        }
    }

    func checkRuns() async -> AgentTools.ToolResult {
        let brain = runtime.tools.brain
        let text = await MainActor.run { () -> String in
            let runs = brain.delegatedRuns().prefix(15)
            if runs.isEmpty { return "No delegated runs yet." }
            return runs.map { r in
                "- \(r.id) · \(r.status.rawValue) · \(r.title)" + (r.projectID.flatMap { brain.project($0)?.name }.map { " · project \($0)" } ?? "")
                    + (r.result.isEmpty ? "" : "\n  " + String(r.result.replacingOccurrences(of: "\n", with: " ").prefix(300)))
            }.joined(separator: "\n")
        }
        return .init(text: text, isError: false)
    }

    func report(_ args: JSONValue) async -> AgentTools.ToolResult {
        let text = args["text"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !text.isEmpty else { return .init(text: "report needs a text.", isError: true) }
        let (pid, err) = await project(args["project"]?.stringValue)
        guard let pid else { return .init(text: err ?? "report needs a project.", isError: true) }
        let brain = runtime.tools.brain
        await MainActor.run { brain.postProjectUpdate(pid, text) }
        return .init(text: "Posted to the project's Latest updates.", isError: false)
    }
}

/// Chat backend for the main thread: the API runtime with the main agent's prompt and delegation tools.
public struct MainAgentChatBackend: ChatBackend {
    public let agent: MainAgent
    public let modelRef: String
    /// BSD-98: approval card in the main thread (as `ModelChatBackend.approve`).
    public var approve: (@Sendable (PermissionCall, PermissionVerdict) async -> Bool)?
    public init(agent: MainAgent, modelRef: String, approve: (@Sendable (PermissionCall, PermissionVerdict) async -> Bool)? = nil) {
        self.agent = agent; self.modelRef = modelRef; self.approve = approve
    }
    public var resumeKind: String? { nil }
    public func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        let brain = agent.runtime.tools.brain
        let system = await MainActor.run { () -> String in
            let main = brain.ensureMainAgent()
            return MainAgent.systemPrompt(instructions: main.instructions, projects: brain.projectBriefs())
        }
        let o = try await agent.runtime.run(prompt: request.prompt, modelRef: modelRef, systemExtra: system, history: request.history,
                                            callerSession: session, permissions: agent.permissions, approve: approve,
                                            extraTools: agent.toolSet(thread: session), events: emit)
        try Task.checkCancellation()
        return ChatReply(text: o.text)
    }
}
