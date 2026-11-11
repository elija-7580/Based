import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-118: `based ask --wait` follows the run through get_run; Settings → Developer installs the binary as a link.
struct CLIPart2Tests {
    private static let runID = "11111111-2222-3333-4444-555555555555"

    /// A transport that answers ask_main_agent with a run id and get_run with the scripted texts, one per call.
    private func scripted(_ getRun: [String], calls: Locked<[String]> = Locked([])) -> BasedCLI {
        let queue = Locked(getRun)
        var cli = BasedCLI(transport: { body in
            let v = try JSONValue.parse(body)
            let name = v["params"]?["name"]?.string ?? ""
            calls.sync { $0.append(name) }
            let text: String
            switch name {
            case "ask_main_agent": text = "Delegated to a sub-agent (run \(Self.runID))."
            case "get_run": text = queue.sync { q in q.count > 1 ? q.removeFirst() : (q.first ?? "") }
            default: text = "?"
            }
            let reply: JSONValue = ["jsonrpc": "2.0", "id": 1, "result": ["content": [["type": "text", "text": .string(text)]], "isError": false]]
            return (200, try JSONEncoder().encode(reply))
        })
        cli.sleep = { _ in }
        return cli
    }

    private func line(_ status: String) -> String { "- [\(status)] Research · Subagent · 0 tokens · started 2026-11-09T10:00:00Z (id: \(Self.runID))" }

    @Test func parsesWaitAndTimeout() throws {
        #expect(try CLIArguments.parse(["ask", "Do", "it", "--wait"]).0 == .askWait(task: "Do it", kind: nil, project: nil, timeout: nil))
        #expect(try CLIArguments.parse(["ask", "x", "--wait", "--timeout", "60", "--kind", "code"]).0
                == .askWait(task: "x", kind: "code", project: nil, timeout: 60))
        #expect(try CLIArguments.parse(["ask", "x"]).0 == .ask(task: "x", kind: nil, project: nil))
        for argv in [["ask", "x", "--timeout", "5"], ["ask", "x", "--wait", "--timeout", "0"], ["ask", "x", "--wait", "--timeout", "soon"]] {
            #expect(throws: CLIError.self, "\(argv)") { try CLIArguments.parse(argv) }
        }
        #expect(CLIArguments.usage.contains("--wait"))
    }

    @Test func readsStatusAndResultFromGetRun() {
        let text = line("Done") + "\nModel: m\n\nResult:\nThree competitors found.\nPage: Comparison\n\nProtocol:\nstep 1"
        let s = BasedCLI.snapshot(ofGetRun: text)
        #expect(s.status == .done)
        #expect(s.result == "Three competitors found.\nPage: Comparison")
        #expect(BasedCLI.snapshot(ofGetRun: line("Needs you")).status == .needsYou)
        #expect(BasedCLI.snapshot(ofGetRun: "garbage") == BasedCLI.RunSnapshot(status: nil, result: ""))
        #expect(BasedCLI.snapshot(ofGetRun: line("Running") + "\n\nResult:\nhalf way\n\nSub-runs:\n- x").result == "half way")
    }

    @Test func waitPrintsProgressAndEndsWithTheResult() async throws {
        let calls = Locked<[String]>([])
        let cli = scripted([line("Planned"), line("Running") + "\n\nResult:\nreading sources", line("Running") + "\n\nResult:\nreading sources",
                            line("Running") + "\n\nResult:\nwriting page", line("Done") + "\n\nResult:\nComparison written.\n\nProtocol:\n…"], calls: calls)
        var out: [String] = []
        try await cli.execute(.askWait(task: "Research", kind: "research", project: nil, timeout: nil), out: { out.append($0) })
        #expect(out.first?.contains(Self.runID) == true)
        #expect(out.filter { $0 == "  reading sources" }.count == 1) // unchanged progress is not repeated
        #expect(out.contains("· Running") && out.contains("  writing page"))
        #expect(out.last == "Comparison written.")
        #expect(calls.current.first == "ask_main_agent" && calls.current.filter { $0 == "get_run" }.count == 5)
    }

    @Test func failedCancelledAndTimeoutExitNonZero() async throws {
        var out: [String] = []
        do {
            try await scripted([line("Failed") + "\n\nResult:\nAPI key missing"]).execute(.askWait(task: "x", kind: nil, project: nil, timeout: nil), out: { out.append($0) })
            Issue.record("no error")
        } catch let e as CLIError { #expect(e.message.contains("failed")) }
        #expect(out.last == "API key missing")
        await #expect(throws: CLIError.self) {
            try await self.scripted([self.line("Cancelled")]).execute(.askWait(task: "x", kind: nil, project: nil, timeout: nil), out: { _ in })
        }
        var slow = scripted([line("Needs you")])
        slow.pollInterval = 2
        var lines: [String] = []
        do {
            try await slow.execute(.askWait(task: "x", kind: nil, project: nil, timeout: 5), out: { lines.append($0) })
            Issue.record("no timeout")
        } catch let e as CLIError { #expect(e.message.contains("based run \(Self.runID)")) }
        #expect(lines.filter { $0.contains("waits for you") }.count == 1)
    }

    @Test func installPlanStateAndLink() throws {
        let helper = "/Applications/Based.app/Contents/Helpers/based"
        let sys = CLIInstall.plan(helper: helper, home: "/Users/e", isWritable: { $0 == "/usr/local/bin" })
        #expect(sys.linkPath == "/usr/local/bin/based" && !sys.needsPathHint && sys.pathHint == nil)
        let user = CLIInstall.plan(helper: "/Apps/It's Based.app/Contents/Helpers/based", home: "/Users/e", isWritable: { _ in false })
        #expect(user.linkPath == "/Users/e/.local/bin/based" && user.needsPathHint)
        #expect(user.shellCommand == "mkdir -p '/Users/e/.local/bin' && ln -sf '/Apps/It'\\''s Based.app/Contents/Helpers/based' '/Users/e/.local/bin/based'")

        #expect(CLIInstall.state(linkPath: "/b/based", helper: helper, destination: { _ in helper }, exists: { _ in true }) == .installed("/b/based"))
        #expect(CLIInstall.state(linkPath: "/b/based", helper: helper, destination: { _ in "../old/based" }, exists: { _ in true }) == .other("/old/based"))
        #expect(CLIInstall.state(linkPath: "/b/based", helper: helper, destination: { _ in nil }, exists: { _ in true }) == .other("/b/based"))
        #expect(CLIInstall.state(linkPath: "/b/based", helper: helper, destination: { _ in nil }, exists: { _ in false }) == .notInstalled)

        // Real files: link created, replaced, a regular file is never overwritten, a missing helper is refused.
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("cli-install-\(UUID().uuidString)").path
        defer { try? fm.removeItem(atPath: root) }
        try fm.createDirectory(atPath: root, withIntermediateDirectories: true)
        let bin = root + "/based-bin"
        fm.createFile(atPath: bin, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        let plan = CLIInstall.plan(helper: bin, home: root, isWritable: { _ in false })
        try CLIInstall.install(plan, helper: bin)
        try CLIInstall.install(plan, helper: bin) // again: replaces its own link
        #expect(try fm.destinationOfSymbolicLink(atPath: plan.linkPath) == bin)
        #expect(CLIInstall.state(linkPath: plan.linkPath, helper: bin, destination: { try? fm.destinationOfSymbolicLink(atPath: $0) },
                                 exists: { fm.fileExists(atPath: $0) }) == .installed(plan.linkPath))
        try fm.removeItem(atPath: plan.linkPath)
        fm.createFile(atPath: plan.linkPath, contents: Data("mine".utf8))
        #expect(throws: CLIError.self) { try CLIInstall.install(plan, helper: bin) }
        #expect(throws: CLIError.self) { try CLIInstall.install(plan, helper: root + "/missing") }
    }
}
