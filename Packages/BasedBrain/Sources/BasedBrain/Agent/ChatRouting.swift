import Foundation
import BasedCore

/// What answers a chat turn (BSD-94: chosen in BasedBrain, the app only shows the picker).
public enum ChatEngineChoice: Equatable, Sendable {
    /// An API / server / on-device model ("provider/model").
    case model(String)
    /// A coding-agent CLI on this Mac.
    case cli(ChatEngineSpec)
    case none

    public var isOnDevice: Bool { if case .model(let r) = self { return r.hasPrefix("apple/") }; return false }
    public var isCLI: Bool { if case .cli = self { return true }; return false }
}

/// Engine choice, system prompt and page context of the chat — pure functions, testable under Linux
/// (moved out of the app's `BrainModel.ask`, BSD-94 / ADR 0005).
public enum ChatRouting {
    /// Picks the engine for `spec`. Auto: an API / server model (tools, big context) → Claude Code (the user's
    /// subscription, tools via MCP) → Codex → Apple Intelligence on device (no tools, small window — last resort).
    public static func resolve(_ spec: ChatEngineSpec, registry: ModelRegistry, installed: Set<ChatEngineSpec.Kind>,
                               defaultModel: String) -> ChatEngineChoice {
        switch spec.kind {
        case .api where registry.resolve(spec.model) != nil: return .model(spec.model)
        case .claudeCode, .codex, .gemini, .opencode:
            if installed.contains(spec.kind) { return .cli(spec) }
        default: break
        }
        if let p = registry.byChatPreference.first(where: { !$0.isOnDevice }) {
            let useDefault = !defaultModel.isEmpty && registry.resolve(defaultModel)?.0.isOnDevice != true
            return .model(useDefault ? defaultModel : "\(p.id)/\(p.models.first ?? "")")
        }
        if installed.contains(.claudeCode) { return .cli(ChatEngineSpec(kind: .claudeCode)) }
        if installed.contains(.codex) { return .cli(ChatEngineSpec(kind: .codex)) }
        if let p = registry.all.first(where: \.isOnDevice) { return .model("\(p.id)/\(p.models.first ?? "")") }
        return .none
    }

    /// BSD-49: the engine for one turn. An explicit choice in the picker wins (the router is not asked; fallback
    /// only as in `resolve`); Auto asks `router` with the task and the compute level (Low / Auto / High).
    public static func route(_ spec: ChatEngineSpec, task: RouteTask, compute: ComputeLevel, forceLow: Bool = false,
                             router: ModelRouter = ModelRouter(), registry: ModelRegistry,
                             installed: Set<ChatEngineSpec.Kind>, defaultModel: String) -> RouteDecision {
        guard spec.kind == .auto else {
            let c = resolve(spec, registry: registry, installed: installed, defaultModel: defaultModel)
            let honoured: Bool = {
                switch c {
                case .cli(let s): return s == spec
                case .model(let r): return spec.kind == .api && r == spec.model
                case .none: return false
                }
            }()
            return RouteDecision(choice: c, effort: spec.effort, compute: compute,
                                 reason: honoured ? "chosen in the picker" : "\(spec.kind.title) is not available; Auto fallback")
        }
        return router.decide(task, compute: compute, forceLow: forceLow, registry: registry, installed: installed,
                             defaultModel: defaultModel)
    }

    /// Label for meta lines ("Claude Code · Opus 5.5").
    public static func label(_ c: ChatEngineChoice) -> String {
        switch c {
        case .model(let ref): return ref.hasPrefix("apple/") ? "Apple Intelligence (on device)" : ref
        case .cli(let s): return s.model.isEmpty ? s.kind.title : s.kind.title + " · " + CLICatalog.label(ChatEngineSpec(kind: s.kind, model: s.model))
        case .none: return "No AI configured"
        }
    }

    /// Tells the model how to produce artifacts the chat can show in its panel.
    public static let artifactHint = "For visual or interactive results (a web page, chart, small app, diagram, illustration) reply with ONE complete fenced block — ```html (self-contained, inline CSS/JS, CDNs allowed), ```svg, ```mermaid or ```jsx (a React component with `export default`, Tailwind classes work) — and keep the text around it short; the app shows it as a live artifact. For a longer standalone document the user may keep (a plan, report, letter, summary, notes) put it in ONE ```markdown block starting with a # title; the app shows it as a document they can read and save as a page. When you create or edit workspace pages with tools, the app shows them as cards, so do not repeat their content."

    /// Shown when nothing can answer.
    public static let noEngineMessage = "No AI is configured. Add an API key (Settings → Agent Brain) or install Claude Code (`npm install -g @anthropic-ai/claude-code`, then `claude` once to log in)."

    /// System prompt for coding-agent CLIs in the chat (API models get theirs from `AgentRuntime`).
    /// `context` is the Agent Brain's system context (About, memories, skills); it is cut to 6000 characters.
    public static func systemPrompt(for choice: ChatEngineChoice, context: String) -> String {
        guard choice.isCLI else { return "" }
        return "You are the assistant inside Based, a Notion-like notes app. Use the `based` MCP tools to search, read and edit the user's pages and databases. Answer in the user's language, concisely, in Markdown. \(artifactHint)\n\n"
            + BasedGuide.instructions + "\n\n" + Citations.instruction + "\n\n" + String(context.prefix(6000))
    }

    /// The prompt as sent: the user's text, attachment texts and the open page. On device there are no tools,
    /// so the page text itself goes along (first 1500 characters); otherwise only its title and id.
    public static func prompt(_ text: String, attachments: [String] = [], page: (id: RecordID, title: String, body: String)?,
                              onDevice: Bool) -> String {
        var p = text
        for a in attachments { p += "\n\n" + a }
        if let page {
            let title = page.title.isEmpty ? "Untitled" : page.title
            if onDevice {
                p += "\n\n---\nOpen page “\(title)”:\n" + String(page.body.prefix(1500))
            } else {
                p += "\n\n---\nContext: the user has the page “\(title)” open (page id \(page.id)). Read it with the tools only if the question is about it."
            }
        }
        return p
    }

    /// The open page for `prompt(…)`, or nil when it is gone or in the trash. The body is only exported on device.
    @MainActor public static func page(_ id: RecordID?, in store: WorkspaceStore, onDevice: Bool) -> (id: RecordID, title: String, body: String)? {
        guard let id, store.blocks[id] != nil, !store.isTrashed(id) else { return nil }
        let body = onDevice ? MarkdownExporter(store: store).export(page: id, includeTitle: false) : ""
        return (id, store.title(of: id), body)
    }
}

// MARK: - Sessions → ChatEvent

public extension ACPUpdate {
    /// The same update in the chat's vocabulary (BSD-94, ADR 0005), so a coding session can be folded by
    /// `ChatTurnBuilder` like a chat turn. Usage, mode changes and echoes of the user's text have no chat event.
    var chatEvent: ChatEvent? {
        switch self {
        case .agentText(let t): return .textDelta(t)
        case .agentThought(let t): return .thinkingDelta(t)
        case .toolCall(let id, let title, let kind, _):
            return .toolUse(id: id, name: kind.isEmpty ? "tool" : kind, input: ["title": .string(title)])
        case .toolCallUpdate(let id, let status, let output):
            guard status == "completed" || status == "failed" else { return nil }
            return .toolResult(id: id, output: output ?? "", isError: status == "failed")
        case .plan(let lines):
            let todos: [JSONValue] = lines.map { line in
                let status = line.hasPrefix("☒") ? "completed" : line.hasPrefix("◐") ? "in_progress" : "pending"
                var title = line
                for p in ["☒ ", "◐ ", "☐ ", "- "] where title.hasPrefix(p) { title = String(title.dropFirst(p.count)) }
                return ["content": .string(title), "status": .string(status)]
            }
            return .toolUse(id: "", name: "TodoWrite", input: ["todos": .array(todos)])
        case .diff(let path, let old, let new):
            return .toolUse(id: "", name: "Edit", input: ["file_path": .string(path), "old_string": .string(old), "new_string": .string(new)])
        case .notice(let n): return .notice(n)
        case .usage, .modeChanged, .userText, .other: return nil
        }
    }
}
