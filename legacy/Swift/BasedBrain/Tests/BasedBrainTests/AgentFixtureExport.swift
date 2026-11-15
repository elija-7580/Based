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

    // MARK: BSD-410 Teil 1: LineDiff und Zitate

    func opJSON(_ op: LineDiff.Op) -> JSONValue {
        switch op {
        case .same(let s): return .array(["same", .string(s)])
        case .removed(let s): return .array(["removed", .string(s)])
        case .added(let s): return .array(["added", .string(s)])
        }
    }

    func lineDiff() -> JSONValue {
        var cases: [JSONValue] = []
        let pairs: [(String, String, String, Int, Int)] = [
            ("gleich", "a\nb\nc", "a\nb\nc", 3, 1),
            ("leer → Text", "", "eins\nzwei", 3, 1),
            ("Text → leer", "eins\nzwei", "", 3, 1),
            ("eine Zeile geändert", "a\nb\nc\nd\ne", "a\nb\nX\nd\ne", 3, 1),
            ("Kontext 1, zwei Hunks", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", "1\nzwei\n3\n4\n5\n6\n7\n8\nneun\n10", 1, 1),
            ("Kontext 3 verbindet Hunks", "1\n2\n3\n4\n5\n6\n7\n8", "1\nB\n3\n4\n5\n6\nG\n8", 3, 1),
            ("Zeilen eingefügt und entfernt", "func a() {\n  x\n}\n", "func a() {\n  y\n  z\n}\n", 2, 40),
            ("firstLine 0 → 1", "a", "b", 3, 0),
            ("Wiederholungen (LCS)", "a\nb\na\nb\na", "b\na\nb\na\nb", 3, 1),
            ("Leerzeilen am Ende", "a\n\n", "a\n\n\n", 3, 1),
            ("Unicode", "Grüße\n👋🏽 hallo\nEnde", "Grüße\n👋 hallo\nEnde", 3, 1),
            ("CRLF bleibt in der Zeile", "a\r\nb", "a\r\nc", 3, 1),
        ]
        for (name, old, new, ctx, first) in pairs {
            let ops = LineDiff.ops(old: old, new: new)
            let c = LineDiff.counts(ops)
            let unified = LineDiff.unified(old: old, new: new, context: ctx, firstLine: first)
            let parsed = LineDiff.parse(unified).map { l -> JSONValue in
                var o: [String: JSONValue] = ["kind": .string("\(l.kind)"), "text": .string(l.text)]
                if let n = l.oldNumber { o["old"] = .number(Double(n)) }
                if let n = l.newNumber { o["new"] = .number(Double(n)) }
                return .object(o)
            }
            cases.append(CoreFixtures.testCase("LineDiff: \(name)",
                ["old": .string(old), "new": .string(new), "context": .number(Double(ctx)), "firstLine": .number(Double(first))],
                ["ops": .array(ops.map(opJSON)), "added": .number(Double(c.added)), "removed": .number(Double(c.removed)),
                 "unified": .string(unified), "parsed": .array(parsed)]))
        }
        // Große Eingaben: alles entfernt, alles hinzugefügt (über 2 Mio. Zellen)
        let big = (0..<1500).map { "a\($0)" }.joined(separator: "\n"), big2 = (0..<1500).map { "b\($0)" }.joined(separator: "\n")
        let bigOps = LineDiff.ops(old: big, new: big2)
        cases.append(CoreFixtures.testCase("LineDiff: große Eingabe ohne LCS",
            ["oldGen": .array(["a", .number(1500)]), "newGen": .array(["b", .number(1500)])],
            ["firstOps": .array(bigOps.prefix(3).map(opJSON)), "count": .number(Double(bigOps.count)),
             "added": .number(Double(LineDiff.counts(bigOps).added)), "removed": .number(Double(LineDiff.counts(bigOps).removed))]))
        return CoreFixtures.file("agents-linediff", cases, meta: [
            "note": "Swift LineDiff (ops, counts, unified, parse). Erzeugt von AgentFixtureExport.swift (BSD-410); TS: packages/brain/src/linediff.ts, Runner packages/brain/test/fixtures-agents-2.test.ts.",
        ])
    }

    func citationJSON(_ c: Citation) -> JSONValue {
        var o: [String: JSONValue] = ["number": .number(Double(c.number)), "pageID": .string(c.pageID), "title": .string(c.title), "snippet": .string(c.snippet)]
        if let b = c.blockID { o["blockID"] = .string(b) }
        return .object(o)
    }

    func citations() -> JSONValue {
        var cases: [JSONValue] = []
        // Bekannte Quellen: (kind:id) → Zitat
        let known: [String: Citation] = [
            "block:b1": Citation(number: 0, pageID: "p1", blockID: "b1", title: "Budget 2027", snippet: "Marketing gets 40 %"),
            "block:b2": Citation(number: 0, pageID: "p1", blockID: "b2", title: "Budget 2027", snippet: ""),
            "page:p2": Citation(number: 0, pageID: "p2", blockID: nil, title: "", snippet: ""),
            "block:b3": Citation(number: 0, pageID: "p3", blockID: "b3", title: "Notes [draft]", snippet: "Ship it"),
            "page:p1": Citation(number: 0, pageID: "p1", blockID: nil, title: "Budget 2027", snippet: ""),
        ]
        let resolve: (String, String) -> Citation? = { kind, id in known["\(kind):\(id)"] }
        let knownJSON: JSONValue = .object(known.mapValues(citationJSON))
        let texts: [(String, String, Bool)] = [
            ("ohne Marker", "Just text.", false),
            ("ein Block", "Marketing gets 40 % [[block:b1]].", false),
            ("gleiche Quelle zweimal", "A [[block:b1]] and again [[block:b1]].", false),
            ("Seite und Blöcke", "See [[page:p2]], [[block:b2]] and [[block:b3]].", false),
            ("unbekannte ID fällt weg", "Gone [[block:zz]] here.", false),
            ("Leerraum im Marker", "Spaced [[ block: b1 ]] and [[page:  p1]].", false),
            ("ohne Leerzeichen davor", "Tight[[block:b1]]", false),
            ("Streaming: abgeschnittener Marker", "Answer so far [[blo", true),
            ("Streaming: angefangene ID", "Answer [[block:b1]] and [[block:12ab", true),
            ("Streaming: einzelne Klammer", "Answer [", true),
            ("Streaming: fertiger Marker", "Answer [[block:b1]]", true),
            ("Streaming: andere Klammern bleiben", "Array [[1, 2]", true),
            ("Titel mit ]", "From notes [[block:b3]].", false),
            ("ID zu lang", "Long [[block:\(String(repeating: "x", count: 65))]]", false),
        ]
        for (name, text, streaming) in texts {
            let r = Citations.render(text, streaming: streaming, resolve: resolve)
            cases.append(CoreFixtures.testCase("render: \(name)",
                ["kind": "render", "text": .string(text), "streaming": .bool(streaming), "known": knownJSON],
                ["markdown": .string(r.markdown), "citations": .array(r.citations.map(citationJSON))]))
            cases.append(CoreFixtures.testCase("markers: \(name)", ["kind": "markers", "text": .string(text)],
                ["markers": .array(Citations.markers(in: text).map { .array([.string($0.kind), .string($0.id)]) })]))
        }
        for t in ["", "plain", "end [", "x [[", "x [[b", "x [[block", "x [[block:", "x [[page:ab", "x [[pa", "x [[other", "x  [[block:1", "[[block:a]] y [[pag"] {
            cases.append(CoreFixtures.testCase("streamingSafe: \(t.isEmpty ? "(leer)" : t)", ["kind": "streamingSafe", "text": .string(t)],
                ["text": .string(Citations.streamingSafe(t))]))
        }
        return CoreFixtures.file("agents-citations", cases, meta: [
            "note": .string("Swift Citations (render mit festem resolve, markers, streamingSafe); Links im Swift-Format \(PageLink.url("ID"))?block=… – der TS-Runner übergibt dieselbe Link-Funktion. Erzeugt von AgentFixtureExport.swift (BSD-410)."),
        ])
    }

    // MARK: BSD-410 Teil 2: Kontextbudget

    func messageJSON(_ m: ChatMessage) -> JSONValue {
        .object(["role": .string(m.role.rawValue), "content": .string(m.content)])
    }

    func contextBudget() async -> JSONValue {
        var cases: [JSONValue] = []
        for model in ["claude-sonnet-4-5", "anthropic/claude-opus", "gpt-4.1-mini", "gpt-5", "o3-mini", "o4", "gpt-4o", "gpt-4-turbo",
                      "gemini-2.5-pro", "openrouter/google/gemini-flash", "apple/on-device", "On-Device", "llama3", "", "GPT-5-CODEX"] {
            cases.append(CoreFixtures.testCase("window: \(model.isEmpty ? "(leer)" : model)", ["kind": "window", "model": .string(model)],
                ["window": .number(Double(ContextBudget.window(for: model)))]))
        }
        for (name, text) in [("leer", ""), ("ASCII", "hello world"), ("sieben", "1234567"), ("Umlaute", "Grüße aus Wien"),
                             ("Emoji mit Hautfarbe", "👋🏽👋🏽👋🏽"), ("Zeilen", "a\nb\r\nc")] {
            cases.append(CoreFixtures.testCase("tokens: \(name)", ["kind": "tokens", "text": .string(text)],
                ["tokens": .number(Double(ContextBudget.tokens(text)))]))
        }
        // fit: kleines Fenster, damit kurze Texte reichen
        let long = { (c: Character, n: Int) in String(repeating: c, count: n) }
        let convos: [(String, Int, [ChatMessage], Bool, Bool)] = [
            ("passt", 1_000, [.system("sys"), .user("hi"), .assistant("hello")], false, false),
            ("Tool-Ergebnisse kürzen", 2_000, [.system("sys"), .user("u1"), .init(role: .tool, content: long("a", 3_000)),
                .assistant("a1"), .user("u2"), .init(role: .tool, content: long("b", 1_500)), .init(role: .tool, content: long("c", 1_500)),
                .init(role: .tool, content: long("d", 1_500)), .init(role: .tool, content: long("e", 1_500)), .init(role: .tool, content: long("f", 1_500))], false, false),
            ("alte Turns weglassen", 1_000, [.system("sys")] + (1...9).flatMap { i -> [ChatMessage] in [.user("frage \(i) " + long("q", 300)), .assistant("antwort \(i) " + long("x", 300))] }, false, false),
            ("alte Turns zusammenfassen", 1_000, [.system("sys")] + (1...9).flatMap { i -> [ChatMessage] in [.user("frage \(i) " + long("q", 300)), .assistant("antwort \(i) " + long("x", 300))] }, true, false),
            ("ohne System-Nachricht", 1_000, (1...8).flatMap { i -> [ChatMessage] in [.user("u\(i) " + long("q", 350)), .assistant("a\(i) " + long("x", 350))] }, false, false),
            ("lange Nachricht in der Mitte kürzen", 2_000, [.system("sys"), .user("hier ist ein Text " + long("t", 9_000)), .assistant("ok"), .user("und jetzt?")], false, false),
            ("force unter der Schwelle", 4_000, [.system("sys"), .user("u1"), .init(role: .tool, content: long("r", 2_500)), .assistant("a"), .user("u2")], false, true),
        ]
        for (name, window, msgs, summarize, force) in convos {
            let budget = ContextBudget(window: window)
            let summarizer: ContextBudget.Summarizer? = summarize ? { text in "SUMMARY of \(text.count) chars" } : nil
            let (out, r) = await budget.fit(msgs, summarizer: summarizer, force: force)
            var report: [String: JSONValue] = ["before": .number(Double(r.before)), "after": .number(Double(r.after)),
                "shortenedToolResults": .number(Double(r.shortenedToolResults)), "summarizedMessages": .number(Double(r.summarizedMessages)),
                "droppedMessages": .number(Double(r.droppedMessages)), "shortenedMessages": .number(Double(r.shortenedMessages))]
            if let s = r.summary { report["summary"] = .string(s) }
            if let n = r.userNotice { report["notice"] = .string(n) }
            cases.append(CoreFixtures.testCase("fit: \(name)",
                ["kind": "fit", "window": .number(Double(window)), "messages": .array(msgs.map(messageJSON)), "summarize": .bool(summarize), "force": .bool(force)],
                ["messages": .array(out.map(messageJSON)), "report": .object(report)]))
        }
        return CoreFixtures.file("agents-context", cases, meta: [
            "note": .string("Swift ContextBudget (window(for:), tokens, fit mit festem Zusammenfasser „SUMMARY of <n> chars“). Erzeugt von AgentFixtureExport.swift (BSD-410 Teil 2)."),
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

    @Test func contextFixturesAreCurrent() async throws {
        try check(await contextBudget(), "context.json")
    }

    @Test func agentFixturesAreCurrent() throws {
        try check(permissions(), "permissions.json")
        try check(budget(), "budget.utc.json")
        try check(lineDiff(), "linediff.json")
        try check(citations(), "citations.json")
    }
}
