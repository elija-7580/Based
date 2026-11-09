import Foundation
import BasedCore

// BSD-98: permissions part 2 — rules per agent and per project (a "Permissions" text column in the Agents and
// Projects databases, same format as the Permissions page plus an optional `mode …` line), layered
// global → project → agent, and the approval card for API chats (an Inbox item of the chat's session, shown inline
// in the chat like the coding sessions' prompts; "Always allow" appends a rule to the Permissions page).

public extension AgentPermissions {
    /// One layer's text: rule lines as in `parseRules`, plus an optional line `mode plan` (or `mode: acceptEdits`,
    /// `mode bypass`, `mode ask`). The last mode line wins; an unknown mode is reported in `errors`.
    static func parseLayer(_ text: String) -> (mode: PermissionMode?, rules: [PermissionRule], errors: [String]) {
        var mode: PermissionMode?, errors: [String] = [], ruleLines: [Substring] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            let lower = line.lowercased()
            guard lower.hasPrefix("mode ") || lower.hasPrefix("mode:") else { ruleLines.append(raw); continue }
            let value = line.dropFirst(5).trimmingCharacters(in: CharacterSet(charactersIn: ": ").union(.whitespaces))
            if let m = PermissionMode.parse(value) { mode = m } else { errors.append(line) }
        }
        // JSON (Claude Code settings) is only recognised as a whole text; a mode line in front of it is allowed.
        let body = ruleLines.joined(separator: "\n")
        let parsed = parseRules(body)
        return (mode, parsed.rules, errors + parsed.errors)
    }

    /// This set with a layer's text on top (agent or project column).
    func layered(text: String) -> AgentPermissions {
        let l = Self.parseLayer(text)
        return layered(mode: l.mode, rules: l.rules)
    }
}

public extension PermissionMode {
    /// `plan`, `Plan mode`, `acceptEdits`, `accept edits`, `bypass`, `allow everything`, `ask`, `default` …
    static func parse(_ s: String) -> PermissionMode? {
        let k = s.lowercased().replacingOccurrences(of: " ", with: "").replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
        switch k {
        case "ask", "askpermissions", "default": return .ask
        case "acceptedits", "edits": return .acceptEdits
        case "plan", "planmode", "readonly": return .plan
        case "bypass", "bypasspermissions", "allowall", "alloweverything": return .bypass
        default: return nil
        }
    }
}

public extension PermissionRule {
    /// The rule "Always allow" writes for `call`: shell commands and file tools keep their argument (this exact
    /// command / path), Based's own and other tools are allowed as a whole.
    static func alwaysAllow(_ call: PermissionCall) -> PermissionRule {
        let keepsArgument: Bool = {
            switch call.tool.lowercased() {
            case "bash", "shell", "execute", "edit", "write", "multiedit", "notebookedit", "read", "webfetch": return true
            default: return false
            }
        }()
        let arg = call.argument?.trimmingCharacters(in: .whitespacesAndNewlines)
        // A pattern with parentheses would not parse back (`Tool(a(b))` is fine, but a lone ")" is not) — keep it simple.
        let usable = keepsArgument && !(arg ?? "").isEmpty && !(arg ?? "").contains("\n")
        return PermissionRule(.allow, tool: call.tool, pattern: usable ? arg : nil)
    }
}

enum PermissionCol {
    static let name = "Permissions"
}

@MainActor
public extension BrainStore {
    /// Adds the "Permissions" text column to the Agents and Projects databases (older brains get it on first use).
    func ensurePermissionColumns() {
        ensureColumn(agentsDB, PermissionCol.name, .text)
        if let db = existingProjectsDB { ensureColumn(db, PermissionCol.name, .text) }
    }

    /// The layered permissions: global mode + Permissions page, then the project's column, then the agent's column.
    func permissions(mode: PermissionMode, agent: Agent? = nil, project: RecordID? = nil) -> AgentPermissions {
        var p = permissions(mode: mode)
        if let project, let pr = self.project(project), !pr.permissions.isEmpty { p = p.layered(text: pr.permissions) }
        if let agent, !agent.permissions.isEmpty { p = p.layered(text: agent.permissions) }
        return p
    }

    /// Sets an agent's or a project's permission text (row of the Agents or Projects database).
    func setPermissions(row id: RecordID, _ text: String) {
        ensurePermissionColumns()
        guard let row = store.blocks[id], case .database(let db) = row.parent, let pid = propID(db, PermissionCol.name) else { return }
        store.transact("Set permissions", undoable: true) { tx in
            tx.update(id) { b in b.values[pid] = text.isEmpty ? nil : .text(RichText(text)) }
        }
    }

    /// Lines that can't be read, with where they are: the Permissions page, then every agent and project.
    func permissionProblems() -> [String] {
        var out = AgentPermissions.parseRules(permissionRulesText()).errors.map { "Permissions page: \($0)" }
        for a in agents() where !a.permissions.isEmpty {
            out += AgentPermissions.parseLayer(a.permissions).errors.map { "Agent “\(a.name)”: \($0)" }
        }
        for p in projects() where !p.permissions.isEmpty {
            out += AgentPermissions.parseLayer(p.permissions).errors.map { "Project “\(p.name)”: \($0)" }
        }
        return out
    }

    /// Appends a rule as a list item at the end of the Permissions page (creating the page if needed).
    /// Does nothing when an identical rule is already there.
    func appendPermissionRule(_ rule: PermissionRule) {
        let page = ensurePermissionsPage()
        guard !AgentPermissions.parseRules(permissionRulesText()).rules.contains(rule) else { return }
        store.insertImported(MarkdownImporter().parse("- `\(rule.description)`"), in: .block(page))
    }

    /// An approval prompt for an API chat: posts an Inbox permission item for `session` (the chat shows it as a card,
    /// the Inbox and other devices too), waits for the answer and applies "Always allow" as a rule.
    /// Unanswered after `timeout` = declined.
    nonisolated func inboxApprover(session: RecordID, timeout: TimeInterval = 600, poll: TimeInterval = 0.5)
        -> @Sendable (PermissionCall, PermissionVerdict) async -> Bool {
        { [weak self] call, verdict in
            guard let self else { return false }
            let rule = PermissionRule.alwaysAllow(call)
            let title = call.tool + (call.argument.map { "(\($0.prefix(120)))" } ?? "")
            let item = await MainActor.run { () -> RecordID in
                self.addInbox(title: title, kind: .permission, sessionID: session,
                              detail: "The assistant wants to run **\(call.tool)** (\(verdict.reason)).\n\n```\n\((call.argument ?? "").prefix(4000))\n```",
                              options: [("allow_once", "Allow"), ("allow_always", "Always allow (\(rule.description))"), ("reject_once", "Deny")])
            }
            let deadline = Date().addingTimeInterval(timeout)
            while Date() < deadline {
                if Task.isCancelled { break }
                try? await Task.sleep(nanoseconds: UInt64(poll * 1_000_000_000))
                let done = await MainActor.run { () -> (Bool, String?)? in
                    guard let d = self.inbox().first(where: { $0.id == item }), d.status != .pending else { return nil }
                    return (d.status == .approved, d.decision)
                }
                if let (approved, decision) = done {
                    if approved, decision == "allow_always" { await MainActor.run { self.appendPermissionRule(rule) } }
                    return approved
                }
            }
            await MainActor.run { _ = self.resolveInbox(item, decision: Task.isCancelled ? "cancelled" : "timeout", status: .rejected) }
            return false
        }
    }
}
