import Foundation
import Testing
@testable import BasedBrain
@testable import BasedCore

/// BSD-36: writing to a dead agent never crashes Based, and stopping ends the whole process tree.
/// BSD-114: serialized (Foundation's `Process.run` crashed once when several of these launched at the same time
/// under load), and the tree tests wait for signals – a "ready" line from the script and the termination handler –
/// instead of sleeping.
@Suite(.serialized) struct ProcessSupervisorTests {
    /// A started shell script plus its exit, reported by the termination handler (no polling of `isRunning`).
    final class Script: @unchecked Sendable {
        let process = Process()
        private let lock = NSLock()
        private var exited = false
        private var waiter: CheckedContinuation<Void, Never>?
        private let out = Pipe()

        /// Starts `/bin/sh -c script` and returns once the script printed `ready`.
        init(_ script: String) async throws {
            process.executableURL = URL(fileURLWithPath: "/bin/sh")
            process.arguments = ["-c", script]
            process.standardOutput = out
            process.terminationHandler = { [weak self] _ in self?.markExited() }
            try ProcessSupervisor.launch(process)
            let handle = out.fileHandleForReading
            let ready: Bool = await withCheckedContinuation { cont in
                Thread {
                    var line = Data()
                    while true {
                        let d = handle.readData(ofLength: 1)
                        if d.isEmpty { cont.resume(returning: false); return }
                        if d == Data("\n".utf8) { cont.resume(returning: String(decoding: line, as: UTF8.self) == "ready"); return }
                        line.append(d)
                    }
                }.start()
            }
            #expect(ready, "script did not report ready")
        }

        private func markExited() {
            lock.lock(); exited = true; let w = waiter; waiter = nil; lock.unlock()
            w?.resume()
        }

        /// Waits until the process has exited (signalled by Foundation, not polled).
        func waitForExit() async {
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                lock.lock()
                if exited { lock.unlock(); cont.resume(); return }
                waiter = cont; lock.unlock()
            }
        }
    }

    #if os(macOS) || os(Linux)
    @Test func writingToAnExitedProcessFailsInsteadOfCrashing() async throws {
        let t = try ProcessTransport(command: "/bin/sh", arguments: ["-c", "exit 0"])
        for _ in 0..<100 where t.isRunning { try await Task.sleep(nanoseconds: 20_000_000) }
        await #expect(throws: (any Error).self) { _ = try await t.peer.request("initialize", ["x": 1]) }
        t.peer.notify("still/alive")   // fire-and-forget into a dead pipe: no crash either
    }

    @Test func writingToAProcessThatClosedItsInputFailsTheRequest() async throws {
        // The child keeps running but closes stdin → the write hits EPIPE (SIGPIPE is ignored).
        let t = try ProcessTransport(command: "/bin/sh", arguments: ["-c", "exec 0<&-; sleep 5"])
        defer { t.terminate() }
        try await Task.sleep(nanoseconds: 300_000_000)
        await #expect(throws: (any Error).self) {
            _ = try await t.peer.request("initialize", .string(String(repeating: "x", count: 200_000)))
        }
    }

    @Test func claudeDriverPromptIntoClosedInputThrows() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deadclaude-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let exe = dir.appendingPathComponent("claude")
        try "#!/bin/sh\nexec 0<&-\nsleep 5\n".write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        let d = ClaudeCodeDriver(options: .init(executable: exe.path, cwd: dir.path))
        try d.start()
        defer { d.stop() }
        try await Task.sleep(nanoseconds: 300_000_000)
        #expect(d.processID != nil)
        await #expect(throws: (any Error).self) { _ = try await d.prompt(String(repeating: "x", count: 200_000), resources: []) }
    }

    /// A signalled grandchild is not ours to wait for, so this checks until it is gone; the 30 s bound is only a
    /// guard against a hang, not a timing assumption (normally it is gone on the first check).
    static func gone(_ pid: Int32) async -> Bool {
        let deadline = Date().addingTimeInterval(30)
        while ProcessSupervisor.isAlive(pid) {
            if Date() > deadline { return false }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        return true
    }

    @Test func terminateTreeStopsChildAndGrandchildren() async throws {
        // Two grandchildren; "ready" only after both were started; `wait` keeps the parent alive.
        let script = try await Script("sleep 60 & sleep 60 & echo ready; wait")
        let p = script.process
        let kids = ProcessSupervisor.descendants(of: [p.processIdentifier])
        #expect(kids.count >= 2)
        // SIGTERM alone ends everything (the children don't block it any more), so the long SIGKILL timeout is
        // never reached; terminateTree returns as soon as all are gone.
        let started = Date()
        let signalled = ProcessSupervisor.terminateTree(of: [p.processIdentifier], timeout: 120)
        #expect(Set(kids).isSubset(of: Set(signalled)))
        #expect(Date().timeIntervalSince(started) < 60, "SIGTERM was not delivered; terminateTree waited for SIGKILL")
        await script.waitForExit()
        #expect(p.terminationReason == .uncaughtSignal)
        for k in kids { #expect(await Self.gone(k), "grandchild \(k) still alive") }
    }

    #if os(Linux)
    @Test func launchedProcessesDoNotInheritBlockedSignals() async throws {
        let script = try await Script("echo ready; exec sleep 60")
        defer { script.process.terminate() }
        let status = try String(contentsOfFile: "/proc/\(script.process.processIdentifier)/status", encoding: .utf8)
        let blocked = status.split(separator: "\n").first { $0.hasPrefix("SigBlk:") }
        #expect(blocked.map { $0.hasSuffix("0000000000000000") } == true, "\(blocked ?? "-")")
    }
    #endif

    @Test func terminateTreeKillsProcessesThatIgnoreSIGTERM() async throws {
        // The trap is set and the (TERM-ignoring) child exists before "ready".
        let script = try await Script("trap '' TERM; sleep 60 & echo ready; wait; sleep 60")
        let p = script.process
        let kids = ProcessSupervisor.descendants(of: [p.processIdentifier])
        #expect(!kids.isEmpty)
        // Short grace: everything here ignores SIGTERM, so SIGKILL must end it. terminateTree returns only after
        // the SIGKILLed processes are gone (or its own grace ran out) – no clock in the test.
        let signalled = ProcessSupervisor.terminateTree(of: [p.processIdentifier], timeout: 0.2)
        #expect(Set(kids + [p.processIdentifier]).isSubset(of: Set(signalled)))
        await script.waitForExit()
        #expect(p.terminationReason == .uncaughtSignal)
        for k in kids { #expect(await Self.gone(k), "child \(k) survived SIGKILL") }
    }

    @MainActor
    @Test func stopAllWithoutSessionsIsANoOp() throws {
        let store = WorkspaceStore(persistence: try SQLitePersistence(url: nil), node: "t")
        let runtime = HappierRuntime(brain: BrainStore(store: store), connections: nil, machineName: "test")
        #expect(runtime.stopAll(timeout: 0.1) == 0)
    }
    #endif

    @Test func boundedLogKeepsTheNewestEntries() {
        var list: [Int] = []
        for i in 0..<2500 { BoundedLog.append(i, to: &list) }
        #expect(list.count == BoundedLog.sessionEventLimit)
        #expect(list.first == 500 && list.last == 2499)
        var small: [String] = []
        for s in ["a", "b", "c"] { BoundedLog.append(s, to: &small, limit: 2) }
        #expect(small == ["b", "c"])
    }
}
