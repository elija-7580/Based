import Foundation
import BasedCore

// BSD-54: the `based` command line (developer option). It talks to a Based server (or the Mac app's local MCP
// host) through the MCP endpoint `POST /mcp` with the owner token. Everything that decides something lives here
// (argument parsing, configuration, the commands) so it is tested without a network; the executable target
// `based-cli` only adds the HTTP transport, stdin/stdout and the config file.
//
// Secrets never go on the command line (they end up in shell history and `ps`): the token comes from
// BASED_TOKEN, a file named by --token-file / BASED_TOKEN_FILE, or ~/.config/based/config.json (mode 0600,
// written by `based login`, which reads the token from stdin).

public enum CLICommand: Equatable, Sendable {
    case help
    case version
    /// Hands a task to the main agent (MCP `ask_main_agent`).
    case ask(task: String, kind: String?, project: String?)
    /// BSD-118: `based ask --wait` — hands the task over, then follows the run until it ends (nil timeout = 30 min).
    case askWait(task: String, kind: String?, project: String?, timeout: Int?)
    case runs(status: String?, limit: Int?)
    case run(id: String)
    case pageGet(ref: String)
    /// Markdown body from stdin.
    case pageNew(title: String, project: String?, parent: String?)
    case search(query: String, limit: Int?)
    case inbox
    /// Prints how to open a shell in the run's sandbox container.
    case sandboxShell(runID: String)
    /// Stores URL + token (token read from stdin) in the config file.
    case login(url: String)
    case config
}

public struct CLIOptions: Equatable, Sendable {
    public var url: String?
    public var tokenFile: String?
    public var json = false
    public init(url: String? = nil, tokenFile: String? = nil, json: Bool = false) { self.url = url; self.tokenFile = tokenFile; self.json = json }
}

public struct CLIError: Error, Equatable, CustomStringConvertible, Sendable {
    public var message: String
    public init(_ m: String) { message = m }
    public var description: String { message }
}

public enum CLIArguments {
    public static let usage = """
    based — Based from the terminal

    Usage:
      based ask "<task>" [--kind code|research|write|organize] [--project <name|id>] [--wait [--timeout <seconds>]]
      based runs [--running | --status <Status>] [--limit N]
      based run <run-id>
      based page get <page-id | title>
      based page new --title <title> [--project <name|id> | --parent <page-id>]  < body.md
      based search "<text>" [--limit N]
      based inbox
      based sandbox shell <run-id>
      based login --url <https://server>      (reads the token from stdin)
      based config

    Options (any command):
      --url <url>          Server URL (default: BASED_URL, then the config file)
      --token-file <path>  File that contains the token (default: BASED_TOKEN_FILE)
      --json               Print the raw tool result as JSON

    The token is never accepted as an argument. Use BASED_TOKEN, --token-file, or `based login`
    (stored in ~/.config/based/config.json, mode 0600). On a Mac you can keep it in the Keychain:
      security add-generic-password -s based -a "$USER" -w            (asks for the token)
      export BASED_TOKEN="$(security find-generic-password -s based -w)"
    """

    /// Parses `argv` without the program name.
    public static func parse(_ argv: [String]) throws -> (CLICommand, CLIOptions) {
        var opts = CLIOptions()
        var rest: [String] = []
        var flags: [String: String] = [:]
        var bools: Set<String> = []
        let valueFlags: Set<String> = ["--url", "--token-file", "--kind", "--project", "--status", "--limit", "--title", "--parent", "--timeout"]
        let boolFlags: Set<String> = ["--json", "--running", "--help", "-h", "--version", "--wait"]
        var i = 0
        while i < argv.count {
            let a = argv[i]
            if a == "--" { rest += argv[(i + 1)...]; break }
            let name = a.split(separator: "=", maxSplits: 1).first.map(String.init) ?? a
            if ["--token", "-t", "--password", "--secret", "--api-key"].contains(name) {
                throw CLIError("Refusing \(name): secrets on the command line end up in shell history. Use BASED_TOKEN, --token-file <path> or `based login` (reads stdin).")
            }
            if valueFlags.contains(name) {
                let value: String
                if a.contains("=") { value = String(a.split(separator: "=", maxSplits: 1)[1]) }
                else {
                    guard i + 1 < argv.count else { throw CLIError("\(name) needs a value") }
                    value = argv[i + 1]; i += 1
                }
                if flags[name] != nil { throw CLIError("\(name) given twice") }
                flags[name] = value
            } else if boolFlags.contains(a) {
                bools.insert(a)
            } else if a.hasPrefix("-") && a.count > 1 {
                throw CLIError("Unknown option \(a). Run `based --help`.")
            } else {
                rest.append(a)
            }
            i += 1
        }
        opts.url = flags["--url"]; opts.tokenFile = flags["--token-file"]; opts.json = bools.contains("--json")
        if bools.contains("--help") || bools.contains("-h") || rest.first == "help" { return (.help, opts) }
        if bools.contains("--version") || rest.first == "version" { return (.version, opts) }
        guard let cmd = rest.first else { return (.help, opts) }
        let args = Array(rest.dropFirst())

        func limit() throws -> Int? {
            guard let l = flags["--limit"] else { return nil }
            guard let n = Int(l), n > 0 else { throw CLIError("--limit must be a positive number") }
            return n
        }
        func only(_ allowed: Set<String>) throws {
            let extra = Set(flags.keys).subtracting(allowed.union(["--url", "--token-file"]))
            if let e = extra.sorted().first { throw CLIError("\(e) does not apply to `\(cmd)`") }
        }
        func one(_ what: String) throws -> String {
            guard args.count == 1, !args[0].trimmingCharacters(in: .whitespaces).isEmpty else { throw CLIError("`based \(cmd)` needs exactly one \(what)") }
            return args[0]
        }

        switch cmd {
        case "ask":
            try only(["--kind", "--project", "--timeout"])
            let task = args.joined(separator: " ").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !task.isEmpty else { throw CLIError("`based ask` needs a task, e.g. based ask \"Summarise today's runs\"") }
            if let k = flags["--kind"], !["code", "research", "write", "organize"].contains(k) {
                throw CLIError("--kind must be code, research, write or organize")
            }
            if bools.contains("--wait") {
                var timeout: Int?
                if let t = flags["--timeout"] {
                    guard let n = Int(t), n > 0 else { throw CLIError("--timeout must be a positive number of seconds") }
                    timeout = n
                }
                return (.askWait(task: task, kind: flags["--kind"], project: flags["--project"], timeout: timeout), opts)
            }
            if flags["--timeout"] != nil { throw CLIError("--timeout only applies with --wait") }
            return (.ask(task: task, kind: flags["--kind"], project: flags["--project"]), opts)
        case "runs":
            try only(["--status", "--limit"])
            guard args.isEmpty else { throw CLIError("`based runs` takes no arguments") }
            if bools.contains("--running"), flags["--status"] != nil { throw CLIError("use either --running or --status") }
            var status = bools.contains("--running") ? "Running" : flags["--status"]
            if let s = status {
                guard let st = AgentRun.Status.allCases.first(where: { $0.rawValue.lowercased() == s.lowercased() || "\($0)".lowercased() == s.lowercased() }) else {
                    throw CLIError("--status must be one of: " + AgentRun.Status.allCases.map(\.rawValue).joined(separator: ", "))
                }
                status = st.rawValue
            }
            return (.runs(status: status, limit: try limit()), opts)
        case "run":
            try only([])
            return (.run(id: try one("run id")), opts)
        case "page":
            guard let sub = args.first else { throw CLIError("`based page` needs get or new") }
            let pargs = Array(args.dropFirst())
            switch sub {
            case "get":
                try only([])
                guard pargs.count >= 1 else { throw CLIError("`based page get` needs a page id or title") }
                return (.pageGet(ref: pargs.joined(separator: " ")), opts)
            case "new":
                try only(["--title", "--project", "--parent"])
                guard pargs.isEmpty else { throw CLIError("`based page new` reads the body from stdin; pass the title with --title") }
                guard let t = flags["--title"], !t.trimmingCharacters(in: .whitespaces).isEmpty else { throw CLIError("`based page new` needs --title") }
                if flags["--project"] != nil, flags["--parent"] != nil { throw CLIError("use either --project or --parent") }
                return (.pageNew(title: t, project: flags["--project"], parent: flags["--parent"]), opts)
            default: throw CLIError("Unknown page command \(sub) (get, new)")
            }
        case "search":
            try only(["--limit"])
            let q = args.joined(separator: " ").trimmingCharacters(in: .whitespaces)
            guard !q.isEmpty else { throw CLIError("`based search` needs a text") }
            return (.search(query: q, limit: try limit()), opts)
        case "inbox":
            try only([]); guard args.isEmpty else { throw CLIError("`based inbox` takes no arguments") }
            return (.inbox, opts)
        case "sandbox":
            try only([])
            guard args.first == "shell", args.count == 2 else { throw CLIError("usage: based sandbox shell <run-id>") }
            return (.sandboxShell(runID: args[1]), opts)
        case "login":
            try only([])
            guard args.isEmpty else { throw CLIError("`based login` reads the token from stdin; pass only --url") }
            guard let u = opts.url else { throw CLIError("`based login` needs --url <https://your-server>") }
            return (.login(url: u), opts)
        case "config":
            try only([]); return (.config, opts)
        default:
            throw CLIError("Unknown command \(cmd). Run `based --help`.")
        }
    }
}

/// Where the CLI connects and with which token.
public struct CLIConfig: Equatable, Sendable {
    public var url: String
    public var token: String
    /// Where the token came from (for `based config`; never the token itself).
    public var tokenSource: String

    public static func path(home: String) -> String { home + "/.config/based/config.json" }

    /// Order: --url / BASED_URL / config file; token: BASED_TOKEN / --token-file / BASED_TOKEN_FILE / config file.
    /// `fileMode` returns the POSIX permissions of a path (nil = unknown); a token file readable by others is refused.
    public static func resolve(options: CLIOptions, env: [String: String], home: String,
                               readFile: (String) -> String?, fileMode: (String) -> Int? = { _ in nil }) throws -> CLIConfig {
        let cfgPath = path(home: home)
        var fileURL: String?, fileToken: String?
        if let raw = readFile(cfgPath) {
            guard let v = try? JSONValue.parse(Data(raw.utf8)) else { throw CLIError("\(cfgPath) is not valid JSON") }
            fileURL = v["url"]?.string; fileToken = v["token"]?.string
        }
        func nonEmpty(_ s: String?) -> String? { s.flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0.trimmingCharacters(in: .whitespacesAndNewlines) } }
        guard let url = nonEmpty(options.url) ?? nonEmpty(env["BASED_URL"]) ?? nonEmpty(fileURL) else {
            throw CLIError("No server configured. Run `based login --url <https://your-server>` or set BASED_URL.")
        }
        guard url.hasPrefix("https://") || url.hasPrefix("http://127.0.0.1") || url.hasPrefix("http://localhost") || url.hasPrefix("http://[::1]") else {
            throw CLIError("Use https:// (plain http only for localhost) — the token would travel unencrypted.")
        }
        func checkedFile(_ p: String) throws -> String {
            if let m = fileMode(p), m & 0o077 != 0 { throw CLIError("\(p) is readable by others (chmod 600 \(p))") }
            guard let s = nonEmpty(readFile(p)) else { throw CLIError("Token file \(p) is missing or empty") }
            return s
        }
        if let t = nonEmpty(env["BASED_TOKEN"]) { return CLIConfig(url: url, token: t, tokenSource: "BASED_TOKEN") }
        if let p = nonEmpty(options.tokenFile) ?? nonEmpty(env["BASED_TOKEN_FILE"]) {
            return CLIConfig(url: url, token: try checkedFile(p), tokenSource: "file " + p)
        }
        if let t = nonEmpty(fileToken) {
            if let m = fileMode(cfgPath), m & 0o077 != 0 { throw CLIError("\(cfgPath) is readable by others (chmod 600 \(cfgPath))") }
            return CLIConfig(url: url, token: t, tokenSource: cfgPath)
        }
        throw CLIError("No token. Set BASED_TOKEN, use --token-file, or run `based login`.")
    }

    /// The config file `based login` writes (the caller stores it with mode 0600).
    public static func fileContents(url: String, token: String) -> String {
        let v: JSONValue = ["url": .string(url), "token": .string(token)]
        return (try? JSONEncoder().encode(v)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }
}

/// Sends one MCP JSON-RPC message (`POST /mcp`) and returns the HTTP status and body.
public typealias CLITransport = @Sendable (_ body: Data) async throws -> (status: Int, body: Data)

/// Runs a parsed command against a transport. Output goes through `out`; returns the exit code.
public struct BasedCLI: Sendable {
    public var transport: CLITransport
    public var json = false
    /// BSD-118: how `--wait` waits between `get_run` calls (tests pass a no-op).
    public var sleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    public var pollInterval: TimeInterval = 2
    public init(transport: @escaping CLITransport, json: Bool = false) { self.transport = transport; self.json = json }

    /// Calls an MCP tool; returns its text, throws with the tool's error text.
    public func call(_ tool: String, _ args: [String: JSONValue]) async throws -> String {
        let msg: JSONValue = ["jsonrpc": "2.0", "id": 1, "method": "tools/call",
                              "params": ["name": .string(tool), "arguments": .object(args)]]
        let (status, data) = try await transport(try JSONEncoder().encode(msg))
        if status == 401 || status == 403 { throw CLIError("Not authorised (HTTP \(status)) — check the token (`based config`).") }
        guard (200..<300).contains(status) else { throw CLIError("Server answered HTTP \(status): " + String(decoding: data.prefix(300), as: UTF8.self)) }
        guard let v = try? JSONValue.parse(data) else { throw CLIError("Server sent no JSON") }
        if let e = v["error"] { throw CLIError(e["message"]?.string ?? "MCP error") }
        let result = v["result"]
        let text = (result?["content"]?.array ?? []).compactMap { $0["text"]?.string }.joined(separator: "\n")
        if result?["isError"]?.bool == true { throw CLIError(text.isEmpty ? "\(tool) failed" : text) }
        if json { return (try? JSONEncoder().encode(result ?? .null)).map { String(decoding: $0, as: UTF8.self) } ?? text }
        return text
    }

    static let uuid = try! NSRegularExpression(pattern: "[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")
    static func ids(in s: String) -> [String] {
        var seen = Set<String>(), out: [String] = []
        for m in uuid.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
            let id = String(s[Range(m.range, in: s)!])
            if seen.insert(id.lowercased()).inserted { out.append(id) }
        }
        return out
    }
    static func isID(_ s: String) -> Bool { ids(in: s) == [s] }

    /// The command that opens a shell in a sandbox ("docker:<container>" or "local:<path>").
    public static func shellCommand(sandbox ref: String, runID: String) throws -> String {
        let safe: (String) -> Bool = { !$0.isEmpty && $0.allSatisfy { $0.isLetter || $0.isNumber || "-_./".contains($0) } }
        if ref.hasPrefix("docker:") {
            let c = String(ref.dropFirst(7))
            guard safe(c), !c.contains("/") else { throw CLIError("Run \(runID) has no usable container name") }
            return "docker exec -it \(c) /bin/sh"
        }
        if ref.hasPrefix("local:") {
            let p = String(ref.dropFirst(6))
            guard safe(p) else { throw CLIError("Run \(runID) has no usable sandbox path") }
            return "cd \(p) && exec \"${SHELL:-/bin/sh}\""
        }
        throw CLIError("Run \(runID) has no sandbox")
    }

    static func askArguments(_ task: String, _ kind: String?, _ project: String?) -> [String: JSONValue] {
        var a: [String: JSONValue] = ["task": .string(task)]
        if let kind { a["kind"] = .string(kind) }
        if let project { a["project"] = .string(project) }
        return a
    }

    /// BSD-118: what `get_run` says about a run — its status (first line "- [Status] …") and the "Result:" section.
    public struct RunSnapshot: Equatable, Sendable {
        public var status: AgentRun.Status?
        public var result: String
    }

    public static func snapshot(ofGetRun text: String) -> RunSnapshot {
        var status: AgentRun.Status?
        if let first = text.split(whereSeparator: \.isNewline).first, first.hasPrefix("- ["),
           let close = first.firstIndex(of: "]") {
            let raw = first[first.index(first.startIndex, offsetBy: 3)..<close]
            status = AgentRun.Status(rawValue: String(raw))
        }
        var result = ""
        if let r = text.range(of: "\n\nResult:\n") {
            let rest = text[r.upperBound...]
            let end = [rest.range(of: "\n\nProtocol:\n"), rest.range(of: "\n\nSub-runs:\n")].compactMap { $0?.lowerBound }.min() ?? rest.endIndex
            result = String(rest[..<end]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return RunSnapshot(status: status, result: result)
    }

    /// Polls `get_run` until the run is terminal: prints status changes and the latest progress line, then the
    /// result. A failed or cancelled run (or the timeout) throws, so the executable exits non-zero.
    public func follow(runID: String, timeout: TimeInterval, out: (String) -> Void) async throws {
        var waited: TimeInterval = 0
        var lastStatus: AgentRun.Status?
        var lastProgress = ""
        while true {
            let snap = Self.snapshot(ofGetRun: try await call("get_run", ["run_id": .string(runID)]))
            let status = snap.status
            if let status, status.isTerminal {
                if !snap.result.isEmpty { out(snap.result) }
                switch status {
                case .done: return
                case .failed: throw CLIError("Run \(runID) failed" + (snap.result.isEmpty ? "" : " (see above)"))
                default: throw CLIError("Run \(runID) was cancelled")
                }
            }
            if let status, status != lastStatus {
                out("· \(status.rawValue)")
                if status == .needsYou { out("  The run waits for you — answer it in Based (Inbox).") }
                lastStatus = status
            }
            let progress = snap.result.split(whereSeparator: \.isNewline).last.map(String.init) ?? ""
            if !progress.isEmpty, progress != lastProgress { out("  " + progress); lastProgress = progress }
            guard waited < timeout else {
                throw CLIError("Still \(status?.rawValue ?? "running") after \(Int(timeout)) s — follow it with `based run \(runID)`")
            }
            let step = min(pollInterval, max(0.1, timeout - waited))
            try await sleep(step)
            waited += step
        }
    }

    /// Project name or id → id (through get_project, whose first id is the project's).
    func projectID(_ ref: String) async throws -> String {
        if Self.isID(ref) { return ref }
        let t = try await call("get_project", ["project": .string(ref)])
        guard let id = Self.ids(in: t).first else { throw CLIError("No project \(ref)") }
        return id
    }

    /// Runs `command`. `stdin` supplies the page body for `page new`.
    public func execute(_ command: CLICommand, stdin: () -> String = { "" }, out: (String) -> Void) async throws {
        switch command {
        case .help: out(CLIArguments.usage)
        case .version: out("based 0.1.0")
        case .login, .config: throw CLIError("handled by the executable")
        case .ask(let task, let kind, let project):
            out(try await call("ask_main_agent", Self.askArguments(task, kind, project)))
        case .askWait(let task, let kind, let project, let timeout):
            let handed = try await call("ask_main_agent", Self.askArguments(task, kind, project))
            guard let runID = Self.ids(in: handed).first else { out(handed); throw CLIError("The main agent returned no run id to follow") }
            out("Run \(runID) started — waiting for the result (Ctrl-C stops waiting, the run keeps going).")
            try await follow(runID: runID, timeout: TimeInterval(timeout ?? 1800), out: out)
        case .runs(let status, let limit):
            var a: [String: JSONValue] = [:]
            if let status { a["status"] = .string(status) }
            if let limit { a["limit"] = .number(Double(limit)) }
            out(try await call("list_runs", a))
        case .run(let id):
            out(try await call("get_run", ["run_id": .string(id)]))
        case .pageGet(let ref):
            if Self.isID(ref) { out(try await call("read_page", ["page_id": .string(ref)])); return }
            let found = try await call("search", ["query": .string(ref), "limit": 10])
            let ids = Self.ids(in: found)
            guard !ids.isEmpty else { throw CLIError("No page matches \"\(ref)\"") }
            // An exact title match wins; otherwise only an unambiguous hit is opened.
            let exact = found.split(whereSeparator: \.isNewline).first { line in
                line.localizedCaseInsensitiveContains(ref) && !Self.ids(in: String(line)).isEmpty
                    && String(line).replacingOccurrences(of: "*", with: "").lowercased().contains(ref.lowercased())
            }.flatMap { Self.ids(in: String($0)).first }
            if ids.count == 1 || exact != nil {
                out(try await call("read_page", ["page_id": .string(exact ?? ids[0])]))
            } else {
                out(found)
                throw CLIError("\(ids.count) pages match — pass the id")
            }
        case .pageNew(let title, let project, let parent):
            var a: [String: JSONValue] = ["title": .string(title)]
            let body = stdin()
            if !body.isEmpty { a["markdown"] = .string(body) }
            if let project { a["parent_id"] = .string(try await projectID(project)) }
            if let parent { a["parent_id"] = .string(parent) }
            out(try await call("create_page", a))
        case .search(let q, let limit):
            var a: [String: JSONValue] = ["query": .string(q)]
            if let limit { a["limit"] = .number(Double(limit)) }
            out(try await call("search", a))
        case .inbox:
            out(try await call("inbox", [:]))
        case .sandboxShell(let runID):
            let run = try await call("get_run", ["run_id": .string(runID)])
            guard let line = run.split(whereSeparator: \.isNewline).first(where: { $0.lowercased().hasPrefix("sandbox:") }) else {
                throw CLIError("Run \(runID) has no sandbox")
            }
            let ref = line.split(separator: ":", maxSplits: 1)[1].trimmingCharacters(in: .whitespaces)
            out(try Self.shellCommand(sandbox: ref, runID: runID))
        }
    }
}
