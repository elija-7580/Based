import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-48: messages sent during a running answer are queued and answered in order.

/// Answers "re: <prompt>" after a delay, word by word; honours cancellation.
private struct SlowBackend: ChatBackend {
    var delay: UInt64 = 60_000_000
    var resumeKind: String? { nil }
    func run(_ request: ChatRequest, session: RecordID, emit: @escaping @Sendable (ChatEvent) -> Void) async throws -> ChatReply {
        emit(.textDelta("re: "))
        try await Task.sleep(nanoseconds: delay)
        emit(.text("re: " + request.prompt))
        return ChatReply(text: "re: " + request.prompt)
    }
}

private final class MemorySink: ChatTranscriptSink {
    var lines: [(String, String)] = []
    func appendTranscript(_ session: RecordID, role: String, markdown: String) { lines.append((role, markdown)) }
    func chatStatus(_ session: RecordID, status: AgentSession.Status, result: String?) {}
    func resumeKey(_ session: RecordID) -> String? { nil }
    func setResumeKey(_ session: RecordID, _ key: String) {}
}

@MainActor
struct PromptQueueTests {
    private func queue(_ sink: MemorySink, delay: UInt64 = 60_000_000) -> ChatPromptQueue<String> {
        let engine = ChatEngine(sink: sink)
        return ChatPromptQueue<String> { prompt in
            engine.send(ChatRequest(prompt: prompt, displayPrompt: prompt), session: "s", via: SlowBackend(delay: delay))
        }
    }

    private func waitIdle(_ q: ChatPromptQueue<String>) async {
        for _ in 0..<400 where q.isBusy || !q.waiting.isEmpty { try? await Task.sleep(nanoseconds: 10_000_000) }
    }

    @Test func threeQuickMessagesAreAnsweredInOrder() async {
        let sink = MemorySink()
        let q = queue(sink)
        var changes = 0
        q.onChange = { changes += 1 }
        #expect(q.submit("one", "one") == nil, "idle: starts at once")
        #expect(q.submit("two", "two") != nil)
        #expect(q.submit("three", "three") != nil)
        #expect(q.isBusy && q.waiting.map(\.text) == ["two", "three"])
        await waitIdle(q)
        let flow = sink.lines.filter { $0.0 == "You" || $0.0 == "Agent" }.map { "\($0.0): \($0.1)" }
        #expect(flow == ["You: one", "Agent: re: one", "You: two", "Agent: re: two", "You: three", "Agent: re: three"])
        #expect(!q.isBusy && changes >= 4)
    }

    @Test func removeTakesAWaitingMessageBack() async {
        let sink = MemorySink()
        let q = queue(sink)
        q.submit("one", "one")
        let two = q.submit("two", "two")!
        q.submit("three", "three")
        q.remove(two)
        await waitIdle(q)
        #expect(sink.lines.filter { $0.0 == "You" }.map(\.1) == ["one", "three"])
    }

    @Test func sendNowInterruptsAndGoesNext() async {
        let sink = MemorySink()
        let q = queue(sink, delay: 2_000_000_000)
        q.submit("long", "long")
        q.submit("later", "later")
        let urgent = q.submit("urgent", "urgent")!
        try? await Task.sleep(nanoseconds: 20_000_000)
        q.sendNow(urgent)
        #expect(q.waiting.map(\.text) == ["urgent", "later"])
        // The long answer stops; urgent and later then run (they are slow too, so stop them as well).
        for _ in 0..<200 where !sink.lines.contains(where: { $0.0 == "You" && $0.1 == "urgent" }) { try? await Task.sleep(nanoseconds: 10_000_000) }
        let you = sink.lines.filter { $0.0 == "You" }.map(\.1)
        #expect(you == ["long", "urgent"])
        #expect(sink.lines.contains { $0.0 == "Error" && $0.1 == "Stopped." }, "the interrupted answer is saved as stopped")
        q.detach()
        #expect(!q.isBusy && q.waiting.isEmpty)
    }

    @Test func gateIsFIFOAndCancellable() async {
        let gate = AsyncTurnGate()
        #expect(await gate.enter())
        let order = Locked<[Int]>([])
        var tasks: [Task<Bool, Never>] = []
        for i in 1...3 {
            tasks.append(Task.detached { let ok = await gate.enter(); if ok { order.sync { $0.append(i) }; gate.leave() }; return ok })
            for _ in 0..<100 where gate.waitingCount < i { try? await Task.sleep(nanoseconds: 2_000_000) }
        }
        #expect(gate.waitingCount == 3)
        gate.leave()
        for t in tasks { #expect(await t.value) }
        #expect(order.current == [1, 2, 3])
        #expect(!gate.isBusy)
        #expect(await gate.enter())
        let waiting = Task.detached { await gate.enter() }
        for _ in 0..<100 where gate.waitingCount < 1 { try? await Task.sleep(nanoseconds: 2_000_000) }
        gate.cancelWaiting()
        #expect(await waiting.value == false)
    }
}

/// The real driver with a fake `claude` that answers each stdin line after a pause.
@Suite struct ClaudeDriverQueueTests {
    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: "/bin/bash")))
    func followUpWaitsForTheRunningTurn() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fakeclaude-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let exe = dir.appendingPathComponent("claude")
        try """
        #!/bin/bash
        n=0
        while IFS= read -r line; do
          n=$((n+1))
          while [ ! -f "\(dir.path)/go" ]; do sleep 0.02; done
          echo "{\\"type\\":\\"assistant\\",\\"message\\":{\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"answer $n\\"}]}}"
          echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"is_error\\":false,\\"result\\":\\"answer $n\\",\\"session_id\\":\\"s\\"}"
        done
        """.write(to: exe, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: exe.path)
        let driver = ClaudeCodeDriver(options: .init(executable: exe.path, cwd: dir.path))
        let texts = Locked<[String]>([])
        driver.onUpdate = { u in if case .agentText(let t) = u { texts.sync { $0.append(t) } } }
        defer { driver.stop(); try? FileManager.default.removeItem(at: dir) }

        let first = Task { () -> (ACPStopReason, [String]) in
            let r = try await driver.prompt("first")
            return (r, texts.current)
        }
        try await Task.sleep(nanoseconds: 100_000_000)
        let second = Task { () -> (ACPStopReason, [String]) in
            let r = try await driver.prompt("second")
            return (r, texts.current)
        }
        // The fake answers only once the file "go" exists, so the first turn stays in flight however slowly the
        // (2-CPU, parallel) test machine schedules the second task — no timing assumption left.
        for _ in 0..<1000 where driver.queuedPrompts < 1 { try await Task.sleep(nanoseconds: 10_000_000) }
        #expect(driver.queuedPrompts == 1, "the follow-up waits")
        FileManager.default.createFile(atPath: dir.appendingPathComponent("go").path, contents: Data())
        let (r1, seen1) = try await first.value
        let (r2, seen2) = try await second.value
        #expect(r1 == .end_turn, "before BSD-48 the first prompt came back .cancelled")
        #expect(seen1 == ["answer 1"])
        #expect(r2 == .end_turn)
        #expect(seen2 == ["answer 1", "answer 2"])
    }
}
