import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// BSD-36: agent processes can't crash Based and don't outlive it.
///
/// - `ignoreSIGPIPE()`: writing to a pipe or socket whose reader is gone returns EPIPE instead of killing the
///   process (called before the first agent process or HTTP server starts, in the app and in based-server).
/// - `terminateTree(of:)`: SIGTERM to a process and all its descendants (`npx` → node adapter → `claude` …),
///   SIGKILL to whatever is still alive after the timeout. Foundation's `Process` can't start children in their
///   own process group, so the tree is read from the process table before the first signal (afterwards orphans
///   are re-parented and can't be found any more).
public enum ProcessSupervisor {
    private static let once: Void = {
        #if os(macOS) || os(Linux)
        signal(SIGPIPE, SIG_IGN)
        #endif
    }()

    /// Idempotent; safe to call from anywhere.
    public static func ignoreSIGPIPE() { _ = once }

    /// BSD-114: starts `process` with no blocked signals. On Linux a child inherits the signal mask of the thread
    /// that spawns it, and Swift-concurrency/Dispatch worker threads block almost every signal – so agents started
    /// from async code silently ignored SIGTERM (`terminateTree` always had to wait for SIGKILL). The calling
    /// thread's mask is cleared only for the spawn and restored right after.
    public static func launch(_ process: Process) throws {
        #if os(Linux)
        var empty = sigset_t(), saved = sigset_t()
        sigemptyset(&empty)
        pthread_sigmask(SIG_SETMASK, &empty, &saved)
        defer { pthread_sigmask(SIG_SETMASK, &saved, nil) }
        #endif
        try process.run()
    }

    /// `pid` → parent pid of every process (from `/proc` on Linux, `ps` elsewhere).
    public static func processTable() -> [Int32: Int32] {
        #if os(Linux)
        var table: [Int32: Int32] = [:]
        if let names = try? FileManager.default.contentsOfDirectory(atPath: "/proc") {
            for n in names {
                guard let pid = Int32(n), let stat = try? String(contentsOfFile: "/proc/\(n)/stat", encoding: .utf8),
                      let close = stat.lastIndex(of: ")") else { continue }
                // "<pid> (<comm>) <state> <ppid> …" – comm may contain spaces, so parse after the last ')'.
                let rest = stat[stat.index(after: close)...].split(separator: " ")
                if rest.count >= 2, let ppid = Int32(rest[1]) { table[pid] = ppid }
            }
        }
        return table
        #elseif os(macOS)
        guard let out = ShellEnvironment.run("/bin/ps", ["-A", "-o", "pid=", "-o", "ppid="], timeout: 5,
                                             environment: ["PATH": "/usr/bin:/bin"]) else { return [:] }
        var table: [Int32: Int32] = [:]
        for line in String(decoding: out, as: UTF8.self).split(separator: "\n") {
            let f = line.split(separator: " ", omittingEmptySubsequences: true)
            if f.count >= 2, let pid = Int32(f[0]), let ppid = Int32(f[1]) { table[pid] = ppid }
        }
        return table
        #else
        return [:]
        #endif
    }

    /// All descendants of `roots` (children, grandchildren …), not including the roots.
    public static func descendants(of roots: [Int32], table: [Int32: Int32]? = nil) -> [Int32] {
        let t = table ?? processTable()
        var children: [Int32: [Int32]] = [:]
        for (pid, ppid) in t { children[ppid, default: []].append(pid) }
        var out: [Int32] = [], queue = roots, seen = Set(roots)
        while let p = queue.popLast() {
            for c in children[p] ?? [] where !seen.contains(c) { seen.insert(c); out.append(c); queue.append(c) }
        }
        return out
    }

    public static func isAlive(_ pid: Int32) -> Bool {
        #if os(macOS) || os(Linux)
        guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else { return false }
        #if os(Linux)
        // A zombie (exited, not yet reaped by its parent) counts as gone.
        if let stat = try? String(contentsOfFile: "/proc/\(pid)/stat", encoding: .utf8), let close = stat.lastIndex(of: ")") {
            let state = stat[stat.index(after: close)...].split(separator: " ").first
            if state == "Z" || state == "X" { return false }
        }
        #endif
        return true
        #else
        return false
        #endif
    }

    /// SIGTERM to `pids` and all their descendants; SIGKILL to survivors after `timeout`. Returns the pids that
    /// were signalled. Blocks for at most `timeout` (+ a short grace for SIGKILL).
    @discardableResult
    public static func terminateTree(of pids: [Int32], timeout: TimeInterval = 3) -> [Int32] {
        #if os(macOS) || os(Linux)
        let me = getpid()
        let roots = pids.filter { $0 > 1 && $0 != me }
        guard !roots.isEmpty else { return [] }
        let all = (roots + descendants(of: roots)).filter { $0 > 1 && $0 != me }
        for p in all { kill(p, SIGTERM) }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline, all.contains(where: isAlive) { usleep(50_000) }
        let left = all.filter(isAlive)
        for p in left { kill(p, SIGKILL) }
        if !left.isEmpty {
            Log.notice("Killed \(left.count) agent process(es) that ignored SIGTERM", category: "agents")
            let grace = Date().addingTimeInterval(1)
            while Date() < grace, left.contains(where: isAlive) { usleep(20_000) }
        }
        return all
        #else
        return []
        #endif
    }

    /// Every process this process started (directly or indirectly) – used when Based quits.
    @discardableResult
    public static func terminateAllChildren(timeout: TimeInterval = 3) -> [Int32] {
        #if os(macOS) || os(Linux)
        let me = getpid()
        let table = processTable()
        let direct = table.filter { $0.value == me }.map(\.key)
        return terminateTree(of: direct, timeout: timeout)
        #else
        return []
        #endif
    }
}

/// BSD-36: per-session event lists in the app keep only the newest entries (a long session no longer grows
/// memory without bound).
public enum BoundedLog {
    public static let sessionEventLimit = 2000

    public static func append<T>(_ element: T, to list: inout [T], limit: Int = sessionEventLimit) {
        list.append(element)
        if list.count > limit { list.removeFirst(list.count - limit) }
    }
}
