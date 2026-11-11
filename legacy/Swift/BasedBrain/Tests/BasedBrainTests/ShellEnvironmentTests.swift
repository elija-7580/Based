import Foundation
import Testing
@testable import BasedBrain

/// BSD-37: the login shell is asked once, off the main thread; concurrent callers share that capture, and the main
/// thread never waits for it. The capture is replaced by a slow stand-in that returns the quick environment, so
/// other suites running in parallel still see a usable PATH.
@Suite(.serialized) struct ShellEnvironmentTests {
    final class Counter: @unchecked Sendable {
        private let lock = NSLock(); private var n = 0
        func bump() { lock.lock(); n += 1; lock.unlock() }
        var value: Int { lock.lock(); defer { lock.unlock() }; return n }
    }

    /// Installs a slow capture, runs `body`, then restores the real one (with a fresh cache).
    static func withSlowCapture<T>(delay: TimeInterval, _ body: (Counter) async throws -> T) async rethrows -> T {
        let calls = Counter()
        ShellEnvironment.captureOverride = { calls.bump(); Thread.sleep(forTimeInterval: delay); var e = ShellEnvironment.quickEnvironment(); e["BASED_TEST_CAPTURE"] = "1"; return e }
        ShellEnvironment.invalidate()
        defer { ShellEnvironment.captureOverride = nil; ShellEnvironment.invalidate() }
        return try await body(calls)
    }

    @Test func concurrentCallersShareOneCapture() async {
        await Self.withSlowCapture(delay: 0.3) { calls in
            ShellEnvironment.invalidate()
            #expect(ShellEnvironment.cachedEnvironment == nil, "nothing cached before the warm-up")
            #expect(ShellEnvironment.whichIfReady("sh") == nil, "views see 'resolving…'")
            let before = calls.value
            let results = await withTaskGroup(of: [String: String].self) { g in
                for _ in 0..<10 { g.addTask { await ShellEnvironment.load() } }
                // Blocking callers on background threads join the same capture.
                for _ in 0..<3 { g.addTask { await Task.detached { ShellEnvironment.environment() }.value } }
                return await g.reduce(into: []) { $0.append($1) }
            }
            #expect(calls.value - before == 1, "13 callers, one login-shell capture")
            #expect(results.count == 13 && results.allSatisfy { $0["BASED_TEST_CAPTURE"] == "1" })
            #expect(ShellEnvironment.cachedEnvironment?["BASED_TEST_CAPTURE"] == "1", "cached after the warm-up")
            #expect(ShellEnvironment.whichIfReady("definitely-not-a-command-xyz") == .some(nil))
            #expect(await ShellEnvironment.locate("/bin/sh") == "/bin/sh")
        }
    }

    @Test func mainThreadNeverWaitsForTheShell() async {
        await Self.withSlowCapture(delay: 0.8) { calls in
            ShellEnvironment.invalidate()
            let start = Date()
            // As the main thread sees it (swift-testing's main actor isn't the process main thread on Linux).
            let env = Self.asMainThread { ShellEnvironment.environment() }   // fallback, no wait
            #expect(Date().timeIntervalSince(start) < 0.5)
            #expect(env["BASED_TEST_CAPTURE"] == nil && !(env["PATH"] ?? "").isEmpty)
            let full = await ShellEnvironment.load()          // the warm-up it started delivers the real one
            #expect(full["BASED_TEST_CAPTURE"] == "1")
            #expect(calls.value >= 1)
        }
    }

    static func asMainThread<T>(_ body: () -> T) -> T {
        let saved = ShellEnvironment.isMainThread
        ShellEnvironment.isMainThread = { true }
        defer { ShellEnvironment.isMainThread = saved }
        return body()
    }

    @Test func reloadReplacesTheCache() async {
        await Self.withSlowCapture(delay: 0.05) { calls in
            _ = await ShellEnvironment.load()
            let n = calls.value
            _ = await ShellEnvironment.reload()
            #expect(calls.value == n + 1)
            #expect(ShellEnvironment.isReady)
        }
    }
}
