import Foundation
import BasedCore

// BSD-116: the main thread from the server (iPhone / web client: POST /main/ask), the heartbeat interval as a
// setting, and coding sub-agents on based-server.

/// Presets of the main agent's heartbeat (its schedule) for the settings picker.
public enum MainAgentHeartbeat: String, CaseIterable, Sendable, Identifiable {
    case every30m = "every 30m", every1h = "every 1h", every2h = "every 2h", every6h = "every 6h", off = ""
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .every30m: return "Every 30 minutes"
        case .every1h: return "Every hour"
        case .every2h: return "Every 2 hours"
        case .every6h: return "Every 6 hours"
        case .off: return "Off"
        }
    }

    /// The preset for a stored schedule ("hourly" = every 1h); nil for anything else (a custom schedule).
    public init?(schedule: String?) {
        let s = (schedule ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        if s.isEmpty { self = .off; return }
        if s == "hourly" { self = .every1h; return }
        guard let kind = Schedule.parse(s)?.kind,
              let p = Self.allCases.first(where: { $0 != .off && Schedule.parse($0.rawValue)?.kind == kind }) else { return nil }
        self = p
    }
}

@MainActor
public extension BrainStore {
    /// The main agent's heartbeat schedule ("" = off).
    var mainAgentHeartbeat: String { ensureMainAgent().schedule ?? "" }

    /// Writes the heartbeat into the Schedule column of the row "Main agent" (empty = no heartbeat).
    func setMainAgentHeartbeat(_ schedule: String) {
        let id = ensureMainAgent().id
        guard let p = propID(agentsDB, "Schedule") else { return }
        let s = schedule.trimmingCharacters(in: .whitespaces)
        store.transact("Main agent heartbeat") { tx in
            tx.update(id) { b in b.values[p] = s.isEmpty ? nil : .text(RichText(s)) }
        }
    }
}

public extension MainAgent {
    /// One turn in the main thread outside the app (server route): the user's text is saved in the thread, the
    /// main agent answers with `options`; returns the thread, the answer and whether it failed.
    func ask(_ text: String, options: MainTurnOptions = .default, device: String = "server") async -> (thread: RecordID, text: String, failed: Bool) {
        let brain = runtime.tools.brain
        let thread = await MainActor.run { () -> RecordID in brain.ensureMainAgent(); return brain.ensureMainThread(machine: device) }
        let t = turn(options)
        guard let ref = t.modelRef else { return (thread, ChatRouting.noEngineMessage, true) }
        let permissions = await MainActor.run { options.permission.map { brain.permissions(mode: $0) } }
        let backend = MainAgentChatBackend(agent: self, modelRef: ref, effort: t.effort, permissions: permissions)
        let handle = await MainActor.run {
            ChatEngine(sink: brain).send(ChatRequest(prompt: text, displayPrompt: text), session: thread, via: backend)
        }
        var builder = ChatTurnBuilder()
        for await e in handle.events { builder.apply(e) }
        await handle.finished()
        return (thread, builder.text, builder.isError)
    }
}

public extension ChatEngineSpec.Kind {
    /// The coding-agent CLIs found on this machine (login-shell PATH), for the main agent's "code" jobs.
    static func installedCLIs() async -> Set<ChatEngineSpec.Kind> {
        var out: Set<ChatEngineSpec.Kind> = []
        for k in [ChatEngineSpec.Kind.claudeCode, .codex, .gemini, .opencode] {
            if let cmd = k.command, await ShellEnvironment.locate(cmd) != nil { out.insert(k) }
        }
        return out
    }
}
