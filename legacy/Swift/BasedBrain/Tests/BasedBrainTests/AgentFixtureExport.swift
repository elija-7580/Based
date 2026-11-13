import Foundation
import Testing
@testable import BasedBrain
@testable import BasedCore

/// BSD-393: Golden Fixtures für Agent-Berechtigungen, Budget und Lease (ADR 0011). Eingabe = Modus, Regeltext und
/// Werkzeugaufruf bzw. Agent + Läufe + Zeitpunkt; Ausgabe = was `AgentPermissions` bzw. `AgentBudget` sagt.
/// Der TS-Port spielt sie ab (packages/brain/test/fixtures-agents.test.ts); bewusste Abweichungen stehen dort.
/// Schreiben: `BASED_WRITE_FIXTURES=1 swift test --filter AgentFixtureExport`; sonst Vergleich mit den Dateien.
@MainActor
@Suite struct AgentFixtureExport {
    static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        .appendingPathComponent("../../../../../fixtures/agents").standardized
    /// Fester, nicht existierender Home-Ordner (PathScope löst nur existierende Teile auf).
    let home = "/fixture-home/e"

    // MARK: Berechtigungen

    func callJSON(_ c: PermissionCall) -> JSONValue {
        var o: [String: JSONValue] = ["tool": .string(c.tool), "category": .string(c.category.rawValue)]
        if let a = c.argument { o["argument"] = .string(a) }
        if c.sandboxed { o["sandboxed"] = true }
        return .object(o)
    }

    func permissions() -> JSONValue {
        var cases: [JSONValue] = []
        // Regeltext lesen (AgentPermissionsTests.parsesLinesJSONAndReportsBadLines + Sonderfälle)
        let texts: [(String, String)] = [
            ("Zeilen, Aufzählungen, Kommentare, Fehler", """
            ## Rules
            - allow Bash(git status:*)
            - `deny Write(~/secret/**)`
            ask based.trash_page
            # a comment
            allow: Web(*)
            nonsense here
            allow Bash(unclosed
            """),
            ("Markdown-Escapes", #"- deny based.trash\_page"#),
            ("Claude-Code-JSON", #"{"permissions": {"allow": ["Bash(npm run test:*)"], "deny": ["Read(./.env)"], "ask": ["mcp__gmail__*"]}}"#),
            ("Leeres Muster und Stern", "allow based.read_page()\nallow based.search(*)\ndeny based.*(Secret*)"),
            ("Checkliste und Großschreibung", "- [ ] Allow based.create_page\n- [x] DENY based.trash_page\n* ask based.update_row(Inbox)"),
        ]
        for (name, text) in texts {
            let (rules, errors) = AgentPermissions.parseRules(text)
            cases.append(CoreFixtures.testCase("parse: " + name, ["kind": "parse", "text": .string(text)],
                ["rules": .array(rules.map { r in
                    var o: [String: JSONValue] = ["effect": .string(r.effect.rawValue), "tool": .string(r.tool)]
                    if let p = r.pattern { o["pattern"] = .string(p) }
                    return .object(o)
                 }), "errors": .array(errors.map(JSONValue.string))]))
        }

        // Entscheiden: Modi × Werkzeugklassen × Regeln
        let calls: [(String, PermissionCall)] = [
            ("lesen", .based("read_page", ["page_id": "p1"])),
            ("suchen", .based("search", ["query": "Budget"])),
            ("bearbeiten", .based("append_markdown", ["page_id": "p1", "markdown": "x"])),
            ("Seite anlegen", .based("create_page", ["title": "Neu"])),
            ("Zeile ändern", .based("update_row", ["id": "r1"])),
            ("zerstörend (Inhalt ersetzen)", .based("replace_page_content", ["page_id": "p1"])),
            ("zerstörend (Spalte löschen)", .based("update_database", ["database_id": "d1", "remove": ["Status"]])),
            ("in den Papierkorb", .based("trash_page", ["page_id": "p1"])),
            ("endgültig löschen", .based("delete_forever", ["page_id": "p1"])),
            ("Inbox beantworten", .based("resolve_inbox", ["id": "i1"])),
            ("Web", .claude("WebFetch", ["url": "https://example.org/a"])),
            ("MCP senden", PermissionCall(tool: "mcp__gmail__send_email", category: .external)),
            ("MCP lesen (extern)", PermissionCall(tool: "mcp__github__list_issues", category: .external)),
            ("Shell in Sandbox", .claude("Bash", ["command": "git status"], sandboxed: true)),
            ("Shell ohne Sandbox", .claude("Bash", ["command": "rm -rf build"])),
        ]
        let modes: [PermissionMode] = [.ask, .acceptEdits, .plan, .bypass]
        for m in modes {
            let p = AgentPermissions(mode: m, rules: [], home: home)
            for (label, c) in calls {
                let v = p.decide(c)
                cases.append(CoreFixtures.testCase("Modus \(m.rawValue): \(label)",
                    ["kind": "decide", "mode": .string(m.rawValue), "rules": "", "call": callJSON(c)],
                    ["effect": .string(v.effect.rawValue), "reason": .string(v.reason)]))
            }
        }
        let ruleSets: [(String, String, PermissionMode)] = [
            ("deny vor ask vor allow", "allow based.*\nask based.update_row\ndeny based.trash_page", .bypass),
            ("Muster auf das Hauptargument", "allow based.append_markdown(p1)\ndeny based.read_page(secret*)", .ask),
            ("Plan bleibt nur lesen trotz allow", "allow based.*", .plan),
            ("allow erlaubt, was sonst immer fragt", "allow based.delete_forever\nallow mcp__gmail__*", .bypass),
            ("Groß/klein im Werkzeug", "deny BASED.CREATE_PAGE", .bypass),
            ("Bash-Präfix mit Wortgrenze", "allow Bash(git status:*)", .ask),
            ("Web-Alias", "deny Web", .bypass),
        ]
        let ruleCalls: [(String, PermissionCall)] = calls + [
            ("geheim lesen", .based("read_page", ["page_id": "secret-plan"])),
            ("andere Seite bearbeiten", .based("append_markdown", ["page_id": "p2"])),
            ("Bash Wortgrenze", .claude("Bash", ["command": "git statusx; rm -rf /"])),
            ("Bash Präfix", .claude("Bash", ["command": "git status --short"])),
        ]
        for (name, text, m) in ruleSets {
            let p = AgentPermissions(mode: m, rulesText: text, home: home)
            for (label, c) in ruleCalls {
                let v = p.decide(c)
                cases.append(CoreFixtures.testCase("Regeln \(name) (\(m.rawValue)): \(label)",
                    ["kind": "decide", "mode": .string(m.rawValue), "rules": .string(text), "call": callJSON(c)],
                    ["effect": .string(v.effect.rawValue), "reason": .string(v.reason)]))
            }
        }
        // Schichten: Projekt/Agent ergänzt Regeln, sein Modus gewinnt
        do {
            let base = AgentPermissions(mode: .ask, rulesText: "allow based.append_markdown", home: home)
            let layer = AgentPermissions.parseRules("deny based.append_markdown(p2)")
            let layered = base.layered(mode: .bypass, rules: layer.rules)
            for (label, c) in calls.prefix(6) + [("andere Seite bearbeiten", .based("append_markdown", ["page_id": "p2"]))] {
                let v = layered.decide(c)
                cases.append(CoreFixtures.testCase("Schichten: \(label)",
                    ["kind": "layered", "mode": "ask", "rules": "allow based.append_markdown", "layerMode": "bypass",
                     "layerRules": "deny based.append_markdown(p2)", "call": callJSON(c)],
                    ["effect": .string(v.effect.rawValue), "reason": .string(v.reason)]))
            }
        }
        return CoreFixtures.file("agents-permissions", cases, meta: [
            "note": "Swift AgentPermissions (BSD-50/98). Erzeugt von legacy/Swift/BasedBrain/Tests/BasedBrainTests/AgentFixtureExport.swift; bewusste Abweichungen des TS-Ports in packages/brain/test/fixtures-agents.test.ts.",
        ])
    }

    // MARK: Budget und Lease

    var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "UTC")!; return c }
    func date(_ y: Int, _ mo: Int, _ d: Int, _ h: Int, _ mi: Int = 0) -> Date {
        cal.date(from: DateComponents(year: y, month: mo, day: d, hour: h, minute: mi))!
    }

    func run(_ id: String, agent: String = "a", start: Date, minutes: Double? = nil, tokens: Int = 0, cost: Double = 0,
             status: AgentRun.Status = .done, model: String = "anthropic/claude-sonnet-4-5") -> AgentRun {
        AgentRun(id: id, title: id, status: status, kind: .schedule, agentID: agent, parentID: nil, sessionID: nil, engine: "based", model: model,
                 compute: nil, startedAt: start, endedAt: minutes.map { start.addingTimeInterval($0 * 60) }, tokens: tokens, cost: cost,
                 result: "", resultPageID: nil)
    }

    func runJSON(_ r: AgentRun) -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(r.id), "agentID": .string(r.agentID ?? ""), "status": .string(r.status.rawValue),
                                      "startedAt": .number(r.startedAt.timeIntervalSinceReferenceDate), "tokens": .number(Double(r.tokens)),
                                      "cost": .number(r.cost), "model": .string(r.model)]
        if let e = r.endedAt { o["endedAt"] = .number(e.timeIntervalSinceReferenceDate) }
        return .object(o)
    }

    func agentJSON(_ a: Agent) -> JSONValue {
        var o: [String: JSONValue] = ["id": .string(a.id), "schedule": a.schedule.map(JSONValue.string) ?? .null]
        if let d = a.dailyTokenBudget { o["dailyTokenBudget"] = .number(Double(d)) }
        if let m = a.monthlyBudget { o["monthlyBudget"] = .number(m) }
        if let s = a.runningSince { o["runningSince"] = .number(s.timeIntervalSinceReferenceDate) }
        if let n = a.runningNode { o["runningNode"] = .string(n) }
        return .object(o)
    }

    func decisionJSON(_ d: AgentBudget.Decision) -> JSONValue {
        switch d {
        case .run(let w): return ["decision": "run", "warning": .bool(w)]
        case .skipLeased(let node, let since): return ["decision": "skipLeased", "node": .string(node), "since": .number(since.timeIntervalSinceReferenceDate)]
        case .skipBudget(let why): return ["decision": "skipBudget", "reason": .string(why)]
        case .skipNotDue: return ["decision": "skipNotDue"]
        }
    }

    func budget() -> JSONValue {
        var cases: [JSONValue] = []
        let now = date(2026, 11, 13, 15)
        let runs: [AgentRun] = [
            run("r1", start: date(2026, 11, 2, 9), minutes: 4, tokens: 1200, cost: 1.5),
            run("r2", start: date(2026, 11, 13, 1), minutes: 8, tokens: 3000, cost: 2.5),
            run("r3", start: date(2026, 10, 31, 23, 59), minutes: 2, tokens: 9000, cost: 9),
            run("r4", agent: "b", start: date(2026, 11, 13, 10), minutes: 1, tokens: 500, cost: 4),
            run("r5", start: date(2026, 11, 13, 14), tokens: 800, cost: 0, status: .running),
            run("r6", start: date(2026, 11, 12, 23, 59), minutes: 30, tokens: 100_000, cost: 0.4),
        ]
        let runsJSON: JSONValue = .array(runs.map(runJSON))
        let nowJSON: JSONValue = .number(now.timeIntervalSinceReferenceDate)
        cases.append(CoreFixtures.testCase("Monat: nur dieser Agent und dieser Monat",
            ["kind": "spentThisMonth", "agentID": "a", "now": nowJSON, "runs": runsJSON],
            ["value": .number((AgentBudget.spentThisMonth(runs, agentID: "a", now: now, calendar: cal) * 10_000).rounded() / 10_000)]))
        cases.append(CoreFixtures.testCase("Monat: Lauf ohne Kosten wird aus Tokens geschätzt",
            ["kind": "spentThisMonth", "agentID": "c", "now": nowJSON,
             "runs": [runJSON(run("e1", agent: "c", start: date(2026, 11, 5, 9), minutes: 1, tokens: 1_000_000, cost: 0, model: "anthropic/claude-sonnet-4-5"))]],
            ["value": .number((AgentBudget.spentThisMonth([run("e1", agent: "c", start: date(2026, 11, 5, 9), minutes: 1, tokens: 1_000_000, cost: 0, model: "anthropic/claude-sonnet-4-5")],
                                                          agentID: "c", now: now, calendar: cal) * 10_000).rounded() / 10_000)]))
        cases.append(CoreFixtures.testCase("Tages-Tokens: nur heute",
            ["kind": "tokensToday", "agentID": "a", "now": nowJSON, "runs": runsJSON],
            ["value": .number(Double(AgentBudget.tokensToday(runs, agentID: "a", now: now, calendar: cal)))]))
        for (spent, budget) in [(4.0, nil), (3.9, 5.0), (4.0, 5.0), (4.99, 5.0), (5.0, 5.0), (6.0, 5.0), (0.0, 0.0), (1.0, -1.0)] as [(Double, Double?)] {
            let l = AgentBudget.level(spent: spent, budget: budget)
            cases.append(CoreFixtures.testCase("Stufe \(spent) von \(budget.map { String($0) } ?? "unbegrenzt")",
                ["kind": "level", "spent": .number(spent), "budget": budget.map(JSONValue.number) ?? .null],
                ["level": .string(l == .ok ? "ok" : l == .warning ? "warning" : "exhausted")]))
        }
        // Lease: 2 × Median der fertigen Läufe, 10 min ohne Daten, 2 min … 1 h
        let leaseSets: [(String, [AgentRun])] = [
            ("ohne Läufe", []),
            ("Median aus fertigen Läufen", runs),
            ("kurz → mindestens 2 min", [run("s1", start: date(2026, 11, 1, 9), minutes: 0.5)]),
            ("lang → höchstens 1 h", [run("l1", start: date(2026, 11, 1, 9), minutes: 50), run("l2", start: date(2026, 11, 1, 11), minutes: 70)]),
            ("laufende zählen nicht", [run("x1", start: date(2026, 11, 1, 9), status: .running), run("x2", start: date(2026, 11, 1, 9), minutes: 3, status: .failed)]),
        ]
        for (name, rs) in leaseSets {
            cases.append(CoreFixtures.testCase("Lease-Dauer: \(name)",
                ["kind": "leaseTTL", "agentID": "a", "runs": .array(rs.map(runJSON))],
                ["seconds": .number(AgentBudget.leaseTTL(rs, agentID: "a"))]))
        }
        // Low ab 80 % (Monat oder Tages-Tokens)
        func agent(daily: Int? = nil, monthly: Double? = nil, schedule: String? = "every 1h", since: Date? = nil, node: String? = nil) -> Agent {
            Agent(id: "a", name: "A", instructions: "", schedule: schedule, model: nil, enabled: true, lastRun: nil, dailyTokenBudget: daily,
                  monthlyBudget: monthly, runningSince: since, runningNode: node, createdAt: date(2026, 11, 1, 0))
        }
        let lowAgents: [(String, Agent)] = [
            ("ohne Budget", agent()),
            ("Monat unter 80 %", agent(monthly: 10)),
            ("Monat 80 %", agent(monthly: 5)),
            ("Monat erschöpft", agent(monthly: 3)),
            ("Tages-Tokens 80 %", agent(daily: 4750)),
            ("Tages-Tokens unter 80 %", agent(daily: 5000)),
            ("Tages-Tokens 0 = aus", agent(daily: 0)),
        ]
        for (name, a) in lowAgents {
            cases.append(CoreFixtures.testCase("Low: \(name)",
                ["kind": "forceLow", "agent": agentJSON(a), "now": nowJSON, "runs": runsJSON],
                ["forceLow": .bool(AgentBudget.forceLow(a, runs: runs, now: now, calendar: cal))]))
        }
        // Darf ein geplanter Lauf starten?
        let decideAgents: [(String, Agent)] = lowAgents + [
            ("Tages-Tokens erreicht", agent(daily: 3800)),
            ("Lease frisch (anderer Knoten)", agent(since: now.addingTimeInterval(-60), node: "mac")),
            ("Lease abgelaufen", agent(since: now.addingTimeInterval(-7200), node: "mac")),
            ("kein Zeitplan", agent(schedule: nil)),
        ]
        for (name, a) in decideAgents {
            cases.append(CoreFixtures.testCase("Zeitplan: \(name)",
                ["kind": "decide", "agent": agentJSON(a), "now": nowJSON, "runs": runsJSON],
                decisionJSON(AgentBudget.decide(a, runs: runs, now: now, calendar: cal))))
        }
        return CoreFixtures.file("agents-budget", cases, meta: [
            "note": "Swift AgentBudget (BSD-51/126), Kalender UTC. Erzeugt von legacy/Swift/BasedBrain/Tests/BasedBrainTests/AgentFixtureExport.swift; bewusste Abweichungen des TS-Ports in packages/brain/test/fixtures-agents.test.ts.",
        ])
    }

    func check(_ value: JSONValue, _ name: String) throws {
        let text = try ImportFixtures.prettyForExport(value)
        let file = Self.dir.appendingPathComponent(name)
        if ProcessInfo.processInfo.environment["BASED_WRITE_FIXTURES"] != nil {
            try FileManager.default.createDirectory(at: Self.dir, withIntermediateDirectories: true)
            try text.write(to: file, atomically: true, encoding: .utf8)
            return
        }
        guard let committed = try? String(contentsOf: file, encoding: .utf8) else { return }
        #expect(committed == text, "fixtures/agents/\(name) is stale – regenerate with BASED_WRITE_FIXTURES=1")
    }

    @Test func agentFixturesAreCurrent() throws {
        try check(permissions(), "permissions.json")
        try check(budget(), "budget.utc.json")
    }
}
