import Foundation
import BasedCore

// BSD-50: what an agent may do without asking, like Claude Code — a mode plus allow / ask / deny rules for tools,
// paths and commands. Precedence: deny > ask > allow > "always ask" list > mode.
// Rule syntax follows Claude Code's settings.json: `Tool` or `Tool(argument pattern)`, e.g.
//   allow Bash(git status:*)        ← command prefix
//   deny  Write(/Users/e/secret/**) ← path glob (also Edit/Read); paths are normalised, symlinks resolved
//   ask   based.trash_page          ← Based's own tools, `based.*` for all of them
//   allow Web(*)                    ← WebFetch / WebSearch
//   allow mcp__gmail__*             ← tools of a connected MCP server

/// The mode of the composer's permission menu (Shift+Tab in Claude Code).
public enum PermissionMode: String, Codable, CaseIterable, Sendable {
    /// Read freely, ask before edits, commands and anything external (default).
    case ask
    /// Edit workspace pages and files without asking; still ask for commands and external actions.
    case acceptEdits
    /// Read only: anything that changes something is refused.
    case plan
    /// Everything allowed — except the "always ask" list (permanent deletion, sending out, shell outside a sandbox).
    case bypass

    public var title: String {
        switch self {
        case .ask: return "Ask permissions"
        case .acceptEdits: return "Accept edits"
        case .plan: return "Plan mode"
        case .bypass: return "Allow everything"
        }
    }

    public var detail: String {
        switch self {
        case .ask: return "Read freely, ask before edits and commands"
        case .acceptEdits: return "Edit pages and files without asking"
        case .plan: return "Explore and propose, change nothing"
        case .bypass: return "Run everything except deleting for good and sending out"
        }
    }

    public var symbol: String {
        switch self {
        case .ask: return "hand.raised"
        case .acceptEdits: return "pencil.and.outline"
        case .plan: return "list.bullet.clipboard"
        case .bypass: return "exclamationmark.shield"
        }
    }

    /// The same mode for a coding-agent CLI's own permission flag ("" = the CLI's default).
    public func cliPermission(for kind: ChatEngineSpec.Kind) -> String {
        switch (kind, self) {
        case (.claudeCode, .ask): return ""
        case (.claudeCode, .acceptEdits): return "acceptEdits"
        case (.claudeCode, .plan): return "plan"
        case (.claudeCode, .bypass): return "bypassPermissions"
        case (.codex, .ask), (.codex, .plan): return ""
        case (.codex, .acceptEdits): return "workspace-write"
        case (.codex, .bypass): return "danger-full-access"
        case (.gemini, .ask), (.gemini, .plan): return ""
        case (.gemini, .acceptEdits): return "auto_edit"
        case (.gemini, .bypass): return "yolo"
        default: return ""
        }
    }
}

public enum PermissionEffect: String, Codable, Sendable, Comparable {
    case allow, ask, deny
    private var rank: Int { switch self { case .allow: return 0; case .ask: return 1; case .deny: return 2 } }
    public static func < (a: PermissionEffect, b: PermissionEffect) -> Bool { a.rank < b.rank }
}

/// What kind of action a tool call is.
public enum ToolCategory: String, Sendable {
    case read, edit, destructive, shell, web, external
}

/// One tool call to decide on.
public struct PermissionCall: Sendable, Equatable {
    /// Tool name as the rules see it: `Bash`, `Edit`, `Write`, `Read`, `WebFetch`, `based.update_row`, `mcp__x__y` …
    public var tool: String
    /// The command (shell), path (file tools), URL (web) or main argument; nil when there is none.
    public var argument: String?
    public var category: ToolCategory
    /// Shell commands: running inside a sandbox (only then may a mode allow them without asking).
    public var sandboxed: Bool

    public init(tool: String, argument: String? = nil, category: ToolCategory, sandboxed: Bool = false) {
        self.tool = tool; self.argument = argument; self.category = category; self.sandboxed = sandboxed
    }

    /// Never allowed by a mode alone, only by an explicit allow rule: deleting for good, sending something out,
    /// a shell outside a sandbox.
    public var alwaysAsks: Bool {
        let t = tool.lowercased()
        // BSD-58: answering an inbox item decides for the user (approves another agent's action) — never by mode alone.
        if t.hasSuffix("resolve_inbox") { return true }
        if ["permanent", "empty_trash", "purge", "destroy", "delete_forever"].contains(where: t.contains) { return true }
        if category == .external, ["send", "post", "publish", "email", "mail", "message", "tweet", "reply", "share", "invite", "transfer", "pay"]
            .contains(where: t.contains) { return true }
        if category == .shell, !sandboxed { return true }
        return false
    }
}

public struct PermissionVerdict: Sendable, Equatable {
    public var effect: PermissionEffect
    public var reason: String
    public init(_ effect: PermissionEffect, _ reason: String) { self.effect = effect; self.reason = reason }
}

/// One rule line: `allow|ask|deny Tool(pattern)`.
public struct PermissionRule: Sendable, Equatable, CustomStringConvertible {
    public var effect: PermissionEffect
    /// Tool name pattern (`*` wildcard, case-insensitive).
    public var tool: String
    /// Argument pattern; nil = any argument.
    public var pattern: String?

    public init(_ effect: PermissionEffect, tool: String, pattern: String? = nil) {
        self.effect = effect; self.tool = tool; self.pattern = pattern
    }

    /// `Bash(git status:*)` → tool `Bash`, pattern `git status:*`.
    public init?(effect: PermissionEffect, spec: String) {
        let s = spec.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return nil }
        if let open = s.firstIndex(of: "("), s.hasSuffix(")") {
            let name = s[..<open].trimmingCharacters(in: .whitespaces)
            let arg = String(s[s.index(after: open)..<s.index(before: s.endIndex)]).trimmingCharacters(in: .whitespaces)
            guard !name.isEmpty else { return nil }
            self.init(effect, tool: name, pattern: arg.isEmpty || arg == "*" ? nil : arg)
        } else {
            guard !s.contains("("), !s.contains(")") else { return nil }
            self.init(effect, tool: s, pattern: nil)
        }
    }

    public var description: String { "\(effect.rawValue) \(tool)" + (pattern.map { "(\($0))" } ?? "") }

    /// File-editing tools share `Edit` / `Write` rules (as in Claude Code); `Web` covers fetch and search.
    static let aliases: [String: Set<String>] = [
        "edit": ["edit", "write", "multiedit", "notebookedit"],
        "write": ["edit", "write", "multiedit", "notebookedit"],
        "web": ["webfetch", "websearch", "fetch", "web"],
        "bash": ["bash", "shell", "execute"],
    ]

    func matches(_ call: PermissionCall, home: String) -> Bool {
        let name = call.tool.lowercased(), want = tool.lowercased()
        let toolOK = Self.aliases[want]?.contains(name) == true || Glob.match(want, name)
        guard toolOK else { return false }
        guard let pattern else { return true }
        guard let arg = call.argument else { return false }
        switch name {
        case "bash", "shell", "execute":
            // Claude Code: `cmd:*` = prefix match on the command (word boundary); otherwise glob.
            if pattern.hasSuffix(":*") {
                let prefix = String(pattern.dropLast(2)).trimmingCharacters(in: .whitespaces)
                let cmd = arg.trimmingCharacters(in: .whitespaces)
                return cmd == prefix || cmd.hasPrefix(prefix + " ")
            }
            return Glob.match(pattern, arg.trimmingCharacters(in: .whitespaces))
        case "read", "edit", "write", "multiedit", "notebookedit":
            return PathScope.matches(pattern: pattern, path: arg, home: home)
        default:
            return Glob.match(pattern, arg)
        }
    }
}

/// Mode plus rules; global settings, agent and project layer on top of each other.
public struct AgentPermissions: Sendable, Equatable {
    public var mode: PermissionMode
    public var rules: [PermissionRule]
    public var home: String

    public init(mode: PermissionMode = .ask, rules: [PermissionRule] = [], home: String = NSHomeDirectory()) {
        self.mode = mode; self.rules = rules; self.home = home
    }

    /// Parses rule text: one rule per line (`allow …`, `ask …`, `deny …`; Markdown bullets, `#` comments and code
    /// fences are ignored) or Claude Code's JSON (`{"permissions": {"allow": [...], "ask": [...], "deny": [...]}}`).
    /// Lines that can't be read are returned in `errors` instead of being dropped silently.
    public static func parseRules(_ text: String) -> (rules: [PermissionRule], errors: [String]) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix("{"), let v = try? JSONValue.parse(Data(trimmed.utf8)) {
            let p = v["permissions"] ?? v
            var out: [PermissionRule] = [], errors: [String] = []
            for e in [PermissionEffect.deny, .ask, .allow] {
                for s in p[e.rawValue]?.array?.compactMap(\.string) ?? [] {
                    if let r = PermissionRule(effect: e, spec: s) { out.append(r) } else { errors.append(s) }
                }
            }
            return (out, errors)
        }
        var out: [PermissionRule] = [], errors: [String] = []
        for raw in text.split(whereSeparator: \.isNewline) {
            var line = raw.trimmingCharacters(in: .whitespaces)
            for b in ["- [ ] ", "- [x] ", "- ", "* ", "• "] where line.hasPrefix(b) { line = String(line.dropFirst(b.count)) }
            line = Self.unescapeMarkdown(line.replacingOccurrences(of: "`", with: ""))
            guard !line.isEmpty, !line.hasPrefix("#"), !line.hasPrefix("//"), !line.hasPrefix("```") else { continue }
            let parts = line.split(separator: " ", maxSplits: 1).map(String.init)
            let head = parts[0].lowercased().trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            guard parts.count == 2, let e = PermissionEffect(rawValue: head), let r = PermissionRule(effect: e, spec: parts[1]) else {
                errors.append(line); continue
            }
            out.append(r)
        }
        return (out, errors)
    }

    /// The page text comes from the Markdown exporter, which escapes `_`, `*`, `(` … with a backslash.
    static func unescapeMarkdown(_ s: String) -> String {
        var out = "", escaping = false
        for ch in s {
            if escaping { if !(ch.isPunctuation || ch.isSymbol) { out.append("\\") }; out.append(ch); escaping = false }
            else if ch == "\\" { escaping = true }
            else { out.append(ch) }
        }
        if escaping { out.append("\\") }
        return out
    }

    public init(mode: PermissionMode, rulesText: String, home: String = NSHomeDirectory()) {
        self.init(mode: mode, rules: Self.parseRules(rulesText).rules, home: home)
    }

    /// A more specific layer (agent, project, this chat): its rules are added, its mode wins when given.
    public func layered(mode: PermissionMode?, rules more: [PermissionRule]) -> AgentPermissions {
        AgentPermissions(mode: mode ?? self.mode, rules: rules + more, home: home)
    }

    /// Only what the rules say (nil when no rule matches) — for places that keep their own mode, like the coding
    /// sessions' inbox policy.
    public func ruleVerdict(_ call: PermissionCall) -> PermissionVerdict? {
        rules.contains { $0.matches(call, home: home) } ? decide(call) : nil
    }

    public func decide(_ call: PermissionCall) -> PermissionVerdict {
        let hits = rules.filter { $0.matches(call, home: home) }
        if let r = hits.first(where: { $0.effect == .deny }) { return PermissionVerdict(.deny, "rule “\(r)”") }
        if let r = hits.first(where: { $0.effect == .ask }) { return PermissionVerdict(.ask, "rule “\(r)”") }
        if let r = hits.first(where: { $0.effect == .allow }) {
            // Plan mode stays read-only even with allow rules for changing tools.
            if mode == .plan, call.category != .read, call.category != .web { return PermissionVerdict(.deny, "plan mode (read only)") }
            return PermissionVerdict(.allow, "rule “\(r)”")
        }
        let byMode = modeEffect(call.category)
        if call.alwaysAsks, byMode == .allow { return PermissionVerdict(.ask, "always asks (\(Self.alwaysReason(call)))") }
        return PermissionVerdict(byMode, "\(mode.title.lowercased()) mode")
    }

    func modeEffect(_ c: ToolCategory) -> PermissionEffect {
        switch (mode, c) {
        case (_, .read): return .allow
        case (.plan, .web): return .allow
        case (.plan, _): return .deny
        case (.bypass, _): return .allow
        case (.acceptEdits, .edit): return .allow
        case (.acceptEdits, _), (.ask, _): return .ask
        }
    }

    static func alwaysReason(_ call: PermissionCall) -> String {
        switch call.category {
        case .shell: return "shell outside a sandbox"
        case .external: return "sends something out"
        default: return "deletes for good"
        }
    }
}

// MARK: - Paths and globs

/// Path checks with separators and symlinks: `/p/proj` contains `/p/proj/a` but not `/p/proj-secret`.
public enum PathScope {
    /// Absolute, standardised path with symlinks resolved (for paths that don't exist yet: the deepest existing
    /// ancestor is resolved and the rest appended). `~` is expanded.
    public static func normalize(_ path: String, home: String = NSHomeDirectory()) -> String {
        var p = path
        if p == "~" { p = home } else if p.hasPrefix("~/") { p = home + String(p.dropFirst(1)) }
        var url = URL(fileURLWithPath: p).standardizedFileURL
        var tail: [String] = []
        while !FileManager.default.fileExists(atPath: url.path), url.pathComponents.count > 1 {
            tail.insert(url.lastPathComponent, at: 0)
            url.deleteLastPathComponent()
        }
        var resolved = url.resolvingSymlinksInPath()
        for c in tail { resolved.appendPathComponent(c) }
        let out = resolved.standardizedFileURL.path
        return out.count > 1 && out.hasSuffix("/") ? String(out.dropLast()) : out
    }

    /// `path` is `root` or inside it (component-wise).
    public static func contains(root: String, path: String, home: String = NSHomeDirectory()) -> Bool {
        let r = normalize(root, home: home), p = normalize(path, home: home)
        if r == "/" { return true }
        return p == r || p.hasPrefix(r + "/")
    }

    /// Rule pattern against a path: `dir/**` = the folder and everything below, other globs on the normalised path.
    static func matches(pattern: String, path: String, home: String) -> Bool {
        let p = normalize(path, home: home)
        if pattern.hasSuffix("/**") {
            return contains(root: String(pattern.dropLast(3)), path: p, home: home)
        }
        var pat = pattern
        if pat == "~" || pat.hasPrefix("~/") { pat = home + String(pat.dropFirst(1)) }
        if !pat.contains("*") && !pat.contains("?") { return normalize(pat, home: home) == p }
        return Glob.match(pat, p, pathAware: true)
    }
}

/// Small glob: `*` (within a path component when `pathAware`), `**` (anything), `?`.
enum Glob {
    static func match(_ pattern: String, _ text: String, pathAware: Bool = false) -> Bool {
        let p = Array(pattern), t = Array(text)
        var memo: [Int: Bool] = [:]
        func go(_ i: Int, _ j: Int) -> Bool {
            let key = i * (t.count + 1) + j
            if let m = memo[key] { return m }
            let r: Bool
            if i == p.count { r = j == t.count }
            else if p[i] == "*" {
                let double = i + 1 < p.count && p[i + 1] == "*"
                let next = double ? i + 2 : i + 1
                if go(next, j) { r = true }
                else if j < t.count, (double || !pathAware || t[j] != "/") { r = go(i, j + 1) }
                else { r = false }
            } else if j < t.count, p[i] == "?" || p[i] == t[j] || (!pathAware && String(p[i]).lowercased() == String(t[j]).lowercased()) {
                r = go(i + 1, j + 1)
            } else { r = false }
            memo[key] = r
            return r
        }
        return go(0, 0)
    }
}

// MARK: - Calls of the different agents

public extension PermissionCall {
    /// Based's own tools (`AgentTools`): reads, edits, and destructive edits.
    static func based(_ name: String, _ args: JSONValue) -> PermissionCall {
        let reads: Set<String> = ["based_guide", "search", "read_page", "list_pages", "query_database", "list_databases", "memory_search",
                                  "list_skills", "load_skill", "about_user", "list_connections", "list_trash", "backlinks", "list_views",
                                  "inbox", "list_runs", "list_projects", "get_project", "get_run", "list_captures"]
        let arg = args["page_id"]?.string ?? args["database_id"]?.string ?? args["id"]?.string ?? args["query"]?.string
        if reads.contains(name) { return PermissionCall(tool: "based." + name, argument: arg, category: .read) }
        let destructive: Bool = {
            switch name {
            case "delete_view", "replace_page_content": return true
            case "update_database":
                let s = args.text.lowercased()
                return s.contains("delete") || s.contains("remove") || args["type"] != nil || s.contains("\"retype\"")
            default: return false
            }
        }()
        return PermissionCall(tool: "based." + name, argument: arg, category: destructive ? .destructive : .edit)
    }

    /// A Claude Code tool (permission-prompt tool / hooks): `Bash`, `Edit`, `Read`, `WebFetch`, `mcp__…`.
    static func claude(_ tool: String, _ input: JSONValue, sandboxed: Bool = false) -> PermissionCall {
        switch tool {
        case "Bash", "BashOutput", "KillShell": return PermissionCall(tool: "Bash", argument: input["command"]?.string, category: .shell, sandboxed: sandboxed)
        case "Edit", "Write", "MultiEdit", "NotebookEdit":
            return PermissionCall(tool: tool, argument: input["file_path"]?.string ?? input["notebook_path"]?.string, category: .edit)
        case "Read", "Glob", "Grep", "LS", "NotebookRead", "TodoWrite", "Task":
            return PermissionCall(tool: tool, argument: input["file_path"]?.string ?? input["path"]?.string ?? input["pattern"]?.string, category: .read)
        case "WebFetch", "WebSearch": return PermissionCall(tool: tool, argument: input["url"]?.string ?? input["query"]?.string, category: .web)
        default:
            if tool.hasPrefix("mcp__based__") {
                var c = based(String(tool.dropFirst("mcp__based__".count)), input)
                c.tool = tool.replacingOccurrences(of: "mcp__based__", with: "based.")
                return c
            }
            if tool.hasPrefix("mcp__") { return PermissionCall(tool: tool, argument: nil, category: .external) }
            return PermissionCall(tool: tool, argument: nil, category: .edit)
        }
    }

    /// An ACP permission request (kind + raw input as text).
    static func acp(kind: String, title: String, detail: String, sandboxed: Bool = false) -> PermissionCall {
        let raw = (try? JSONValue.parse(Data(detail.utf8))) ?? .null
        switch kind {
        case "execute": return PermissionCall(tool: "Bash", argument: raw["command"]?.string ?? (raw == .null ? detail : nil), category: .shell, sandboxed: sandboxed)
        case "edit", "delete", "move":
            return PermissionCall(tool: kind == "edit" ? "Edit" : kind.capitalized, argument: raw["path"]?.string ?? raw["file_path"]?.string ?? raw["abs_path"]?.string,
                                  category: kind == "edit" ? .edit : .destructive)
        case "read", "search", "think": return PermissionCall(tool: "Read", argument: raw["path"]?.string ?? raw["file_path"]?.string, category: .read)
        case "fetch": return PermissionCall(tool: "WebFetch", argument: raw["url"]?.string, category: .web)
        default: return PermissionCall(tool: title, argument: nil, category: .edit)
        }
    }
}

// MARK: - Rules page in the Agent Brain

@MainActor
public extension BrainStore {
    static let permissionsPageTitle = "Permissions"

    /// The "Permissions" page under the Agent Brain (synced like any page), if it exists.
    var permissionsPageID: RecordID? {
        store.contentBlocks(of: rootID).first { $0.type == .page && $0.title == Self.permissionsPageTitle && $0.trashedAt == nil }?.id
    }

    /// Rule text from the Permissions page ("" when there is none).
    func permissionRulesText() -> String { permissionsPageID.map { body(of: $0) } ?? "" }

    /// The global permissions: `mode` plus the rules of the Permissions page.
    func permissions(mode: PermissionMode) -> AgentPermissions {
        AgentPermissions(mode: mode, rulesText: permissionRulesText())
    }

    /// Opens or creates the Permissions page with a short explanation (from "Edit rules…").
    @discardableResult
    func ensurePermissionsPage() -> RecordID {
        if let id = permissionsPageID { return id }
        let id = store.createPage(title: RichText(Self.permissionsPageTitle), in: .block(rootID), icon: .emoji("🛡️"), name: "Create Permissions page")
        let intro = """
        ## How it works

        > One rule per line in the list below: allow, ask or deny, then a tool. Deny wins over ask, ask over allow, allow over the mode chosen in the chat. Examples: allow Bash(git status:*) · deny Write(~/Documents/private/**) · ask based.trash_page · allow Web(*) · allow mcp__github__*. Deleting for good, sending something out and shell commands outside a sandbox always ask unless a rule allows them.

        ## Rules

        Add your rules as list items below this line.
        """
        store.insertImported(MarkdownImporter().parse(intro), in: .block(id))
        return id
    }
}
