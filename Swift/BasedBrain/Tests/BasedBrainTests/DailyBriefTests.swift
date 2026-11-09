import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// Fake engine for the brief: counts calls, answers with a fixed text.
private final class BriefProvider: AIProvider, @unchecked Sendable {
    let id = "fake", displayName = "Fake"
    let models = ["claude-haiku-5-5"]
    private let log = Locked<[String]>([])
    var prompts: [String] { log.current }
    func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        log.sync { $0.append(messages.last?.content ?? "") }
        return AIResponse(message: .assistant("Good morning. Market analysis is done; one approval waits."),
                          usage: Usage(inputTokens: 20, outputTokens: 10))
    }
}

/// BSD-57: the daily brief agent — pure input, quiet day without a model call, page per day, start page.
@MainActor
struct DailyBriefTests {
    private var cal: Calendar { var c = Calendar(identifier: .gregorian); c.timeZone = TimeZone(identifier: "Europe/Vienna")!; return c }
    private func at(_ day: Int, _ h: Int, _ m: Int = 0) -> Date {
        cal.date(from: DateComponents(year: 2026, month: 11, day: day, hour: h, minute: m))!
    }
    private func run(_ id: String, _ kind: AgentRun.Kind, _ status: AgentRun.Status, ended: Date?, agent: RecordID? = nil,
                     session: RecordID? = nil, result: String = "") -> AgentRun {
        AgentRun(id: id, title: "Run " + id, status: status, kind: kind, agentID: agent, parentID: nil, sessionID: session,
                 engine: "based", model: "", compute: nil, startedAt: (ended ?? at(9, 6)).addingTimeInterval(-60),
                 endedAt: ended, tokens: 0, cost: 0, result: result, resultPageID: nil)
    }

    @Test func inputCollectsTheWindowAndLeavesOutChatsAndItself() {
        let now = at(9, 6, 30)
        let brief = Agent(id: "brief", name: SetupPlan.dailyBriefName, instructions: "", schedule: "daily 06:30", model: nil,
                          enabled: true, lastRun: at(8, 6, 30), dailyTokenBudget: nil)
        let later = Agent(id: "sorter", name: "Sort captures", instructions: "", schedule: "daily 18:00", model: nil,
                          enabled: true, lastRun: nil, dailyTokenBudget: nil)
        let tomorrow = Agent(id: "weekly", name: "Weekly review", instructions: "", schedule: "weekly tue 09:00", model: nil,
                             enabled: true, lastRun: nil, dailyTokenBudget: nil)
        var main = Agent(id: "main", name: "Main agent", instructions: "", schedule: "every 2h", model: nil,
                         enabled: true, lastRun: now, dailyTokenBudget: nil)
        main.isMain = true
        let runs = [
            run("a", .subagent, .done, ended: at(8, 22), result: "Market analysis ready\nsecond line"),
            run("b", .schedule, .failed, ended: at(9, 2), result: "Error: timeout"),
            run("c", .chat, .done, ended: at(8, 23)),                       // conversation, not work
            run("d", .schedule, .done, ended: at(8, 6, 31), agent: "brief"), // the brief itself
            run("e", .session, .done, ended: at(8, 5)),                      // before the last brief
            run("f", .session, .needsYou, ended: nil, session: "s1"),
            run("g", .session, .running, ended: nil, session: "s2"),
        ]
        let inbox = [InboxItem(id: "i1", title: "Allow git push?", kind: .permission, status: .pending, sessionID: "s2",
                               detail: "", options: [], decision: nil, createdAt: at(9, 1))]
        let overview = RunOverview(runs: runs, inbox: inbox, agents: [brief, later, tomorrow, main])
        let input = BriefInput.make(overview: overview, now: now, since: brief.lastRun, briefAgentID: "brief",
                                    projectUpdates: ["Based: CLI started"], calendar: cal)
        #expect(input.finished.map(\.runID) == ["a"])
        #expect(input.finished[0].detail == "Market analysis ready")
        #expect(input.failed.map(\.runID) == ["b"])
        #expect(input.needsYou.map(\.title) == ["Allow git push?", "Run f"])
        #expect(input.plannedToday.map(\.title) == ["Sort captures"])
        #expect(input.plannedToday[0].detail == "18:00")
        #expect(input.headline == "1 finished, 1 failed, 2 need you, 1 planned today.")
        let md = input.markdown
        #expect(md.range(of: "## Needs you")!.lowerBound < md.range(of: "## Finished")!.lowerBound)
        #expect(md.contains("Based: CLI started"))

        // Without a previous brief the window starts at midnight yesterday.
        let first = BriefInput.make(overview: overview, now: now, calendar: cal)
        #expect(first.since == at(8, 0))
        #expect(first.finished.map(\.runID).contains("e"))
        #expect(BriefInput.make(overview: RunOverview(runs: []), now: now, calendar: cal).isEmpty)
    }

    private func make() -> (BrainStore, BriefProvider, AgentRuntime) {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let reg = ModelRegistry(); let p = BriefProvider(); reg.register(p)
        return (brain, p, AgentRuntime(registry: reg, tools: AgentTools(store: store, brain: brain)))
    }

    private func briefAgent(_ brain: BrainStore) -> Agent {
        let state = SetupState(node: true, anthropicKey: true)
        let applied = SetupPlan.apply(SetupPlan.defaults(for: .apiKey, state: state), brain: brain)
        return brain.agents().first { $0.id == applied.dailyBrief }!
    }

    @Test func quietDayWritesTheTemplateWithoutAModelCall() async {
        let (brain, provider, rt) = make()
        let agent = briefAgent(brain)
        #expect(BrainStore.isDailyBrief(agent))
        let o = await rt.run(agent: agent, trigger: "manual")
        #expect(o?.text == BriefInput.quietDay)
        #expect(provider.prompts.isEmpty, "nothing happened → no model call")
        let today = brain.todaysBrief()
        #expect(today?.summary == BriefInput.quietDay)
        let run = brain.runs(RunFilter(agentID: agent.id)).first
        #expect(run?.status == .done && run?.resultPageID == today?.page)
        let thread = brain.mainThread()
        #expect(thread != nil)
        #expect(brain.homeSnapshot(range: .today).brief == BriefInput.quietDay)
    }

    @Test func onlyTheShippedRowIsTheBrief() {
        let (brain, _, _) = make()
        // A user's own agent called "Daily brief" with its own instructions stays a normal agent.
        let own = brain.saveAgent(name: SetupPlan.dailyBriefName, instructions: "Summarise my mail.", schedule: "daily 07:00", model: nil)
        #expect(!BrainStore.isDailyBrief(brain.agents().first { $0.id == own }!))
        let applied = SetupPlan.apply(SetupPlan.defaults(for: .apiKey, state: SetupState(node: true, anthropicKey: true)), brain: brain)
        #expect(applied.dailyBrief == own && !applied.dailyBriefCreated)
        #expect(!BrainStore.isDailyBrief(brain.agents().first { $0.id == own }!), "edited instructions → not adopted")

        // A row from BSD-56 with the untouched old text is adopted as the shipped brief.
        let (b2, _, _) = make()
        let legacy = b2.saveAgent(name: SetupPlan.dailyBriefName, instructions: SetupPlan.legacyDailyBriefInstructions, schedule: "daily 06:30", model: nil)
        _ = SetupPlan.apply(SetupPlan.defaults(for: .apiKey, state: SetupState(node: true, anthropicKey: true)), brain: b2)
        #expect(BrainStore.isDailyBrief(b2.agents().first { $0.id == legacy }!))
    }

    @Test func busyDayAsksTheModelOnceAndAppendsOnASecondRun() async {
        let (brain, provider, rt) = make()
        let agent = briefAgent(brain)
        let r = brain.startRun(title: "Market analysis", kind: .subagent)
        brain.finish(run: r, status: .done, result: "Report written")
        _ = brain.addInbox(title: "Allow git push?", kind: .permission, sessionID: nil, detail: "")
        let o = await rt.run(agent: agent, trigger: "schedule daily 06:30")
        #expect(provider.prompts.count == 1)
        #expect(provider.prompts[0].contains("Market analysis") && provider.prompts[0].contains("Allow git push?"))
        #expect(o?.text.contains("Market analysis is done") == true)
        guard let page = brain.todaysBrief()?.page else { Issue.record("no brief page"); return }
        #expect(brain.todaysBrief()?.summary == "1 finished, 1 needs you.")
        let snap = brain.homeSnapshot(range: .today)
        #expect(snap.briefPageID == page && snap.brief == "1 finished, 1 needs you.")

        // Same day again: one row, an "Update" section appended, nothing replaced.
        let before = brain.store.contentBlocks(of: page).count
        let again = brain.agents().first { $0.id == agent.id }!
        _ = await rt.run(agent: again, trigger: "manual")
        #expect(brain.briefPage(on: Date()) == page)
        #expect(brain.store.rows(of: brain.ensureBriefs()).count == 1)
        let blocks = brain.store.contentBlocks(of: page)
        #expect(blocks.count > before)
        #expect(blocks.contains { $0.text.plainText.hasPrefix("Update ") })
    }
    /// BSD-119: a page with a date mention / reminder of today shows up in the brief's "Today" section.
    @Test func remindersAndDateMentionsOfTodayAreInTheBrief() async {
        let (brain, provider, rt) = make()
        let agent = briefAgent(brain)
        let now = Date()
        let page = brain.store.createPage(title: "Errands")
        _ = brain.store.insertBlock(.todo, text: RichText(runs: [TextRun("Call the bank "),
                                                               TextRun("@Today", mention: .date(DateValue(start: Calendar.current.startOfDay(for: now), remind: true)))]),
                                    in: .block(page))
        let input = brain.briefInput(for: agent, now: now)
        #expect(input.dueToday.count == 1)
        #expect(input.dueToday.first?.title == "Errands")
        #expect(input.dueToday.first?.detail == "reminder · Call the bank @Today")
        #expect(input.headline == "1 due today.")
        #expect(input.markdown.hasPrefix("## Today\n\n- Errands — reminder · Call the bank @Today"))
        _ = await rt.run(agent: agent, trigger: "manual")
        #expect(provider.prompts.count == 1 && provider.prompts[0].contains("Call the bank"))
        #expect(brain.todaysBrief()?.summary == "1 due today.")

        // Timed lines carry the time; without anything due the input is unchanged (quiet day).
        let cal = Calendar.current
        let timed = DueItem(pageID: "p", blockID: "b", pageTitle: "Team", text: "Standup", date: DateValue(start: cal.date(bySettingHour: 9, minute: 30, second: 0, of: now)!, includeTime: true), isReminder: false)
        let overview = RunOverview(runs: [], inbox: [], agents: [])
        #expect(BriefInput.make(overview: overview, now: now, due: [timed], calendar: cal).dueToday.first?.detail == "09:30 · Standup")
        #expect(BriefInput.make(overview: overview, now: now, calendar: cal).isEmpty)
    }
}
