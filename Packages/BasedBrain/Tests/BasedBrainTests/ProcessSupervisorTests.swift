import Foundation
import Testing
@testable import BasedBrain
@testable import BasedCore

/// BSD-36: writing to a dead agent never crashes Based, and stopping ends the whole process tree.
@Suite struct ProcessSupervisorTests {
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

    @Test func terminateTreeStopsChildAndGrandchildren() async throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Grandchildren that ignore nothing special; `wait` keeps the parent alive.
        p.arguments = ["-c", "sleep 60 & sleep 60 & wait"]
        try p.run()
        var kids: [Int32] = []
        for _ in 0..<50 {
            kids = ProcessSupervisor.descendants(of: [p.processIdentifier])
            if kids.count >= 2 { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        #expect(kids.count >= 2)
        let signalled = ProcessSupervisor.terminateTree(of: [p.processIdentifier], timeout: 1)
        #expect(Set(kids).isSubset(of: Set(signalled)))
        for _ in 0..<40 where p.isRunning { try await Task.sleep(nanoseconds: 50_000_000) }
        #expect(!p.isRunning)
        for k in kids { #expect(!ProcessSupervisor.isAlive(k), "grandchild \(k) still alive") }
    }

    @Test func terminateTreeKillsProcessesThatIgnoreSIGTERM() async throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "trap '' TERM; sleep 60 & wait; sleep 60"]
        try p.run()
        try await Task.sleep(nanoseconds: 200_000_000)
        let started = Date()
        ProcessSupervisor.terminateTree(of: [p.processIdentifier], timeout: 0.5)
        for _ in 0..<40 where p.isRunning { try await Task.sleep(nanoseconds: 50_000_000) }
        #expect(!p.isRunning)
        #expect(Date().timeIntervalSince(started) < 5)
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
