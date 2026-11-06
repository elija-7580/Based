import Foundation
import BasedCore

/// The user's login-shell environment. Apps started from Finder/Dock get a minimal PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so `npx`, `node`, `claude`, `codex` … are not found and
/// `#!/usr/bin/env node` scripts fail. We ask the login shell once (`$SHELL -l -i -c env`, with a
/// timeout) and use the result as the base environment for every child process.
public enum ShellEnvironment {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var cached: [String: String]?
    nonisolated(unsafe) private static var captureNote = ""

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

    /// Base environment for child processes (cached after the first call).
    public static func environment() -> [String: String] {
        lock.lock()
        if let c = cached { lock.unlock(); return c }
        lock.unlock()
        let env = capture()
        lock.lock(); cached = env; lock.unlock()
        return env
    }

    /// Forget the cached environment (e.g. after installing a CLI) and capture again.
    public static func refresh() {
        lock.lock(); cached = nil; lock.unlock()
        _ = environment()
    }

    public static var note: String { lock.lock(); defer { lock.unlock() }; return captureNote }

    /// Merge order: process env < login-shell env < extra PATH dirs (deduplicated, existing only).
    static func capture() -> [String: String] {
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
        var seen = Set<String>()
        var path: [String] = []
        for d in (env["PATH"] ?? "").split(separator: ":").map(String.init) + extraPaths(home: home)
        where !d.isEmpty && !seen.contains(d) {
            seen.insert(d)
            if path.contains(d) { continue }
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: d, isDirectory: &isDir), isDir.boolValue { path.append(d) }
        }
        env["PATH"] = path.joined(separator: ":")
        if env["LANG"] == nil { env["LANG"] = "en_US.UTF-8" }
        env["HOME"] = home
        lock.lock(); captureNote = note; lock.unlock()
        Log.info("Child-process environment from \(note); PATH has \(path.count) entries", category: "agents")
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

    /// Absolute path of a command through the shell PATH (nil when not installed).
    public static func which(_ command: String) -> String? {
        if command.hasPrefix("/") { return FileManager.default.isExecutableFile(atPath: command) ? command : nil }
        if command.hasPrefix("~") {
            let p = NSHomeDirectory() + command.dropFirst()
            return FileManager.default.isExecutableFile(atPath: p) ? p : nil
        }
        let path = environment()["PATH"] ?? ""
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
