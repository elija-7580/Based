import Foundation
import BasedCore

// BSD-105: main agent part 2 — its monthly budget also holds in the chat (low compute from 80 %, no model call and no
// delegation at 100 %), long sub-agent results become a page under the project (linked from the run and the
// update line), "code" jobs can go to a coding session (Claude Code / Codex …) under the main thread, and ⌘J can
// open the main thread.

/// Budget state of the main agent (monthly budget in the Agents database, spending summed from Runs).
public struct MainAgentBudget: Sendable, Equatable {
    public var level: AgentBudget.Level
    public var spent: Double
    public var budget: Double?

    public static let unlimited = MainAgentBudget(level: .ok, spent: 0, budget: nil)

    /// Reply in the main thread when the budget is used up (no model call).
    public var exhaustedMessage: String {
        String(format: "The main agent's monthly budget is used up (€%.2f of €%.2f). I won't call a model or start sub-agents until next month — raise the budget in Agent Brain → Agents (row “Main agent”, column Monthly budget) to continue now.",
               spent, budget ?? 0)
    }

    public var warningNotice: String {
        String(format: "Main agent budget at %d %% (€%.2f of €%.2f): sub-agents run on low compute.",
               Int(((spent / max(budget ?? 1, 0.0001)) * 100).rounded()), spent, budget ?? 0)
    }
}

@MainActor
public extension BrainStore {
    /// The main agent's budget this month (unlimited when there is no main agent or no budget).
    func mainAgentBudget(now: Date = Date(), calendar: Calendar = .current) -> MainAgentBudget {
        guard let main = mainAgent(), let budget = main.monthlyBudget else { return .unlimited }
        let spent = spentThisMonth(agent: main.id, now: now, calendar: calendar)
        return MainAgentBudget(level: AgentBudget.level(spent: spent, budget: budget), spent: spent, budget: budget)
    }

    /// Writes a sub-agent's result as a page under `project` ("Result: <title>"), returns its id.
    @discardableResult
    func createResultPage(title: String, markdown: String, in project: RecordID) -> RecordID? {
        guard store.blocks[project] != nil else { return nil }
        let name = "Result: " + (title.isEmpty ? "sub-agent" : String(title.prefix(80)))
        let id = store.createPage(title: RichText(name), in: .block(project), icon: .emoji("📄"), name: "Create result page")
        store.insertImported(MarkdownImporter().parse(markdown), in: .block(id))
        return id
    }
}

public extension MainAgent {
    /// Results longer than this become their own page under the project.
    static let resultPageThreshold = 1000

    /// Agent id of the coding session for a CLI choice ("claude", "codex", "gemini", "opencode").
    static func sessionAgentID(for kind: ChatEngineSpec.Kind) -> String? {
        switch kind {
        case .claudeCode: return "claude"
        case .codex: return "codex"
        case .gemini: return "gemini"
        case .opencode: return "opencode"
        default: return nil
        }
    }

    func budget() async -> MainAgentBudget {
        let brain = runtime.tools.brain
        return await MainActor.run { brain.mainAgentBudget() }
    }
}

public extension HappierRuntime {
    /// `MainAgent.cliLauncher` on top of coding sessions: a "code" job starts a session of the matching agent as a
    /// sub-agent of the main thread (`thread()`), in the project's folder, and returns its final answer.
    func mainAgentLauncher(thread: @escaping @Sendable () async -> RecordID?,
                           timeout: TimeInterval = 3600) -> @Sendable (DelegatedJob) async throws -> String {
        { [weak self] job in
            guard let self else { throw AIError.unavailable("agent sessions are not running") }
            guard case .cli(let spec) = job.choice, let agentID = MainAgent.sessionAgentID(for: spec.kind) else {
                throw AIError.unavailable("no coding agent for this job")
            }
            let parent = await thread()
            let (folder, projectName) = await self.mainQueue.run { () -> (String?, String?) in
                guard let pid = job.projectID, let p = self.brain.project(pid) else { return (nil, nil) }
                return (p.folder.isEmpty ? nil : p.folder, p.name)
            }
            let sid = try await self.spawn(agentID: agentID, prompt: job.task, title: String(job.task.prefix(60)),
                                           cwd: folder, project: projectName, parentID: parent)
            await self.mainQueue.run { self.brain.logRun(job.runID, "Coding session \(sid) (\(agentID))") }
            let r = await self.waitFor([sid], timeout: timeout)
            guard let e = r.first else { throw AIError.unavailable("session \(sid) vanished") }
            guard e.finished else { throw AIError.unavailable("session \(sid) still running after \(Int(timeout / 60)) min — see Agents") }
            if e.session?.status == .failed { throw AIError.unavailable("session \(sid) failed: \(e.session?.result ?? "")") }
            let answer = e.session?.result ?? ""
            return answer.isEmpty ? "Coding session \(sid) finished without a final answer." : answer
        }
    }
}

/// What ⌘J opens (Settings → Agents & AI).
public enum ChatShortcutTarget: String, CaseIterable, Sendable {
    case mainAgent = "main"
    case lastChat = "last"

    public var title: String { self == .mainAgent ? "Main agent" : "Last chat" }

    /// The chat to show when the panel opens: the main thread, unless the user is in the middle of another chat
    /// (a reply still running) — then that one stays.
    public func chatToOpen(current: RecordID?, currentIsRunning: Bool, mainThread: () -> RecordID) -> RecordID? {
        switch self {
        case .lastChat: return current
        case .mainAgent: return currentIsRunning ? current : mainThread()
        }
    }
}
