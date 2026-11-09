import Foundation
import BasedCore

/// The user's login-shell environment. Apps started from Finder/Dock get a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so `npx`, `node`, `claude`, `codex` … are not found and
/// `#!/usr/bin/env node` scripts fail. We ask the login shell once (`$SHELL -l -i -c env`, with a
/// timeout) and use the result as the base environment for every child process.
///
/// BSD-37: asking the login shell can take seconds (slow `.zshrc`, nvm …), so it never happens on the main thread.
/// One capture runs at a time and everyone waiting shares its result (`load()` async, `environment()` blocking for
/// background threads). The UI reads `cachedEnvironment` / `whichIfReady` and shows "resolving…" until it's there;
/// a blocking call that still lands on the main thread gets the quick fallback (process env + common CLI folders)
/// instead of a hang, and starts the capture in the background.
public enum ShellEnvironment {
    private static let cond = NSCondition()   // guards everything below
    nonisolated(unsafe) private static var cached: [String: String]?
    nonisolated(unsafe) private static var capturing = false
    nonisolated(unsafe) private static var generation = 0
    nonisolated(unsafe) private static var waiters: [CheckedContinuation<[String: String], Never>] = []
    nonisolated(unsafe) private static var captureNote = ""
    /// Number of login-shell captures started (tests: concurrent callers share one).
    nonisolated(unsafe) private(set) static var captureCount = 0
    /// Test hook: replaces the login-shell capture.
    nonisolated(unsafe) static var captureOverride: (@Sendable () -> [String: String])?
    /// Test hook: whether the caller counts as the main thread.
    nonisolated(unsafe) static var isMainThread: @Sendable () -> Bool = { Thread.isMainThread }

    /// Directories commonly holding user-installed CLIs, appended to PATH when present.
    public static func extraPaths(home: String = NSHomeDirectory()) -> [String] {
        var dirs = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "\(home)/.local/bin", "\(home)/.claude/local",
                    "\(home)/.volta/bin", "\(home)/.cargo/bin", "\(home)/.bun/bin", "\(home)/.deno/bin",
                    "\(home)/.npm-global/bin", "\(home)/.yarn/bin", "\(home)/Library/pnpm", "\(home)/.local/share/pnpm",
                    "\(home)/.asdf/shims", "\(home)/.local/share/mise/shims", "\(home)/.nodenv/shims", "\(home)/.fnm/aliases/default/bin",
                    "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        if let nvm = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/.nvm/versions/node") {
            dirs += nvm.sorted { $0.compare($1, options: .numeric) == .orderedDescending }.map { "\(home)/.nvm/versions/node/\($0)/bin" }
        }
        return dirs
    }

    /// The captured environment if it's ready, else nil. Never blocks – the one to use from views and the main actor.
    public static var cachedEnvironment: [String: String]? { cond.lock(); defer { cond.unlock() }; return cached }

    /// True once the login-shell environment is known.
    public static var isReady: Bool { cachedEnvironment != nil }

    /// Starts the capture in the background if nothing is cached or running yet. Returns immediately.
    public static func warmUp() {
        cond.lock()
        let start = cached == nil && !capturing
        if start { capturing = true; captureCount += 1 }
        let gen = generation
        cond.unlock()
        if start { Thread.detachNewThread { finish(capture(), generation: gen) } }
    }

    /// The base environment for child processes; waits (without blocking a thread) for the running capture.
    public static func load() async -> [String: String] {
        cond.lock()
        if let c = cached { cond.unlock(); return c }
        cond.unlock()
        return await withCheckedContinuation { (k: CheckedContinuation<[String: String], Never>) in
            cond.lock()
            if let c = cached { cond.unlock(); k.resume(returning: c); return }
            waiters.append(k)
            cond.unlock()
            warmUp()
        }
    }

    /// Base environment for child processes (cached after the first capture). Blocks a background thread while the
    /// login shell answers; on the main thread it never waits (see the type's comment).
    public static func environment() -> [String: String] {
        cond.lock()
        if let c = cached { cond.unlock(); return c }
        if isMainThread() {
            cond.unlock()
            warmUp()
            Log.warning("ShellEnvironment.environment() on the main thread before the login shell answered – using the quick fallback", category: "agents")
            return quickEnvironment()
        }
        if capturing {
            while cached == nil && capturing { cond.wait() }
            if let c = cached { cond.unlock(); return c }
        }
        capturing = true; captureCount += 1
        let gen = generation
        cond.unlock()
        let env = capture()
        finish(env, generation: gen)
        return cachedEnvironment ?? env
    }

    private static func finish(_ env: [String: String], generation gen: Int) {
        cond.lock()
        var ready: [CheckedContinuation<[String: String], Never>] = []
        if gen == generation {
            cached = env; capturing = false
            ready = waiters; waiters = []
        }
        cond.broadcast()
        cond.unlock()
        for k in ready { k.resume(returning: env) }
    }

    /// Forget the cached environment (e.g. after installing a CLI) and capture again. Blocking; background only.
    public static func refresh() {
        invalidate()
        _ = environment()
    }

    /// `refresh()` for async callers (e.g. a "Check again" button): the capture runs off the main thread.
    @discardableResult
    public static func reload() async -> [String: String] {
        invalidate()
        return await load()
    }

    static func invalidate() {
        cond.lock()
        cached = nil
        if capturing {
            // A capture from before the invalidation must not win; waiters move on to the next one.
            generation += 1; capturing = false
        }
        cond.unlock()
    }

    /// Process environment plus the common CLI folders – what children get while the login shell hasn't answered.
    public static func quickEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = env["HOME"] ?? NSHomeDirectory()
        env["PATH"] = mergedPath(env["PATH"] ?? "", home: home)
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        env["HOME"] = home
        return env
    }

    static func mergedPath(_ path: String, home: String) -> String {
        var seen = Set<String>(), out: [String] = []
        for d in path.split(separator: ":").map(String.init) + extraPaths(home: home) where !d.isEmpty && !seen.contains(d) {
            seen.insert(d)
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: d, isDirectory: &isDir), isDir.boolValue { out.append(d) }
        }
        return out.joined(separator: ":")
    }

    public static var note: String { cond.lock(); defer { cond.unlock() }; return captureNote }

    /// Merge order: process env < login-shell env < extra PATH dirs (deduplicated, existing only).
    static func capture() -> [String: String] {
        if let o = captureOverride { return o() }
        var env = ProcessInfo.processInfo.environment
        let home = env["HOME"] ?? NSHomeDirectory()
        var note = "process environment"
        #if os(macOS) || os(Linux)
        if let shellEnv = loginShellEnvironment(timeout: 6) {
            for (k, v) in shellEnv where !["PWD", "OLDPWD", "SHLVL", "_", "TERM_SESSION_ID", "PS1"].contains(k) { env[k] = v }
            note = "login shell (\(env["SHELL"] ?? "sh"))"
        } else {
            note = "process environment (login shell timed out or failed)"
        }
        #endif
        env["PATH"] = mergedPath(env["PATH"] ?? "", home: home)
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        env["HOME"] = home
        cond.lock(); captureNote = note; cond.unlock()
        Log.info("Child-process environment from \(note); PATH has \(env["PATH"]?.split(separator: ":").count ?? 0) entries", category: "agents")
        return env
    }

    #if os(macOS) || os(Linux)
    /// Runs `$SHELL -l -i -c 'env -0'` and parses NUL-separated `KEY=VALUE` pairs after a marker.
    static func loginShellEnvironment(timeout: TimeInterval) -> [String: String]? {
        let shell = ProcessInfo.processInfo.environment["SHELL"].flatMap { FileManager.default.isExecutableFile(atPath: $0) ? $0 : nil }
            ?? (FileManager.default.isExecutableFile(atPath: "/bin/zsh") ? "/bin/zsh" : "/bin/sh")
        let marker = "__BASED_ENV_7f3a__"
        for args in [["-l", "-i", "-c", "printf '\(marker)'; env -0"], ["-l", "-c", "printf '\(marker)'; env -0"]] {
            guard let out = run(shell, args, timeout: timeout), let r = out.range(of: Data(marker.utf8)) else { continue }
            let body = out[r.upperBound...]
            var env: [String: String] = [:]
            for chunk in body.split(separator: 0) {
                guard let s = String(data: Data(chunk), encoding: .utf8), let eq = s.firstIndex(of: "=") else { continue }
                env[String(s[..<eq])] = String(s[s.index(after: eq)...])
            }
            if env["PATH"] != nil { return env }
        }
        return nil
    }

    /// Runs a process with a timeout and returns stdout (nil on failure / timeout).
    public static func run(_ executable: String, _ args: [String], timeout: TimeInterval, environment: [String: String]? = nil,
                           cwd: String? = nil, stderrToStdout: Bool = false) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: executable)
        p.arguments = args
        if let environment { p.environment = environment }
        if let cwd { p.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        let out = Pipe()
        p.standardOutput = out
        p.standardError = stderrToStdout ? out : FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        let done = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in done.signal() }
        let box = DataBox()
        out.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            if d.isEmpty { h.readabilityHandler = nil } else { box.append(d) }
        }
        do { try p.run() } catch { return nil }
        if done.wait(timeout: .now() + timeout) == .timedOut {
            p.terminate()
            out.fileHandleForReading.readabilityHandler = nil
            return nil
        }
        // Drain whatever is left in the pipe.
        out.fileHandleForReading.readabilityHandler = nil
        if let rest = try? out.fileHandleForReading.readToEnd() { box.append(rest) }
        return box.data
    }
    #endif

    /// Absolute path of a command through the shell PATH (nil when not installed). Blocking like `environment()`.
    public static func which(_ command: String) -> String? {
        if let direct = directPath(command) { return direct.isEmpty ? nil : direct }
        return search(command, in: environment()["PATH"] ?? "")
    }

    /// `which` for async callers: waits for the capture without blocking a thread.
    public static func locate(_ command: String) async -> String? {
        if let direct = directPath(command) { return direct.isEmpty ? nil : direct }
        return search(command, in: await load()["PATH"] ?? "")
    }

    /// For views: `.some(path or nil)` once the environment is known, `nil` while it's still being resolved.
    public static func whichIfReady(_ command: String) -> String?? {
        if let direct = directPath(command) { return .some(direct.isEmpty ? nil : direct) }
        guard let env = cachedEnvironment else { return nil }
        return .some(search(command, in: env["PATH"] ?? ""))
    }

    /// Absolute and ~ paths need no PATH: the path itself, "" when not executable, nil for a bare command name.
    private static func directPath(_ command: String) -> String? {
        if command.hasPrefix("/") { return FileManager.default.isExecutableFile(atPath: command) ? command : "" }
        if command.hasPrefix("~") {
            let p = NSHomeDirectory() + command.dropFirst()
            return FileManager.default.isExecutableFile(atPath: p) ? p : ""
        }
        return nil
    }

    private static func search(_ command: String, in path: String) -> String? {
        for d in path.split(separator: ":") {
            let p = "\(d)/\(command)"
            if FileManager.default.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }
}

final class DataBox: @unchecked Sendable {
    private let lock = NSLock()
    private var buf = Data()
    func append(_ d: Data) { lock.lock(); buf.append(d); lock.unlock() }
    var data: Data { lock.lock(); defer { lock.unlock() }; return buf }
}
