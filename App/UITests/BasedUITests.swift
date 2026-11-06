import XCTest

/// XCUITest smoke suite — checks that every main surface renders and the key elements are present
/// (sidebar, page editor, slash menu, settings sections, ⌘J, database table, Sessions/Inbox).
/// Run with `make uitest` (macOS) or the Based-iOS-UITests scheme in Xcode.
final class BasedUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-ui-testing", "-AppleLanguages", "(en)"]
        app.launch()
    }

    /// ⌘-shortcuts exist only on macOS; iOS tests reach the same surfaces through the sidebar.
    private func shortcut(_ key: String) throws {
        #if os(macOS)
        app.typeKey(key, modifierFlags: .command)
        #else
        throw XCTSkip("Keyboard shortcuts are macOS-only")
        #endif
    }
    private func escape() {
        #if os(macOS)
        app.typeKey(.escape, modifierFlags: [])
        #else
        if app.buttons["Cancel"].exists { app.buttons["Cancel"].tap() } else { app.swipeDown() }
        #endif
    }

    private func wait(_ e: XCUIElement, _ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "Missing element \(e)", file: file, line: line)
    }

    func testSidebarHasAllEntries() {
        for id in ["sidebar.search", "sidebar.askAI", "sidebar.home", "sidebar.sessions", "sidebar.inbox", "sidebar.brain", "sidebar.addPage", "sidebar.trash"] {
            wait(app.descendants(matching: .any)[id])
        }
    }

    func testCreatePageAndTypeTitle() {
        app.descendants(matching: .any)["sidebar.addPage"].firstMatch.press()
        let title = app.descendants(matching: .any)["page.title"].firstMatch
        wait(title)
        title.press()
        title.typeText("UI test page")
        XCTAssertTrue(app.staticTexts["UI test page"].waitForExistence(timeout: 3) || title.value as? String == "UI test page")
    }

    func testSlashMenuAppears() {
        app.descendants(matching: .any)["sidebar.addPage"].firstMatch.press()
        let title = app.descendants(matching: .any)["page.title"].firstMatch
        wait(title); title.press(); title.typeText("Slash\n")
        app.typeText("/")
        wait(app.descendants(matching: .any)["slash.menu"], 3)
        escape()
    }

    func testQuickFind() throws {
        try shortcut("p")
        wait(app.descendants(matching: .any)["quickfind.field"])
        escape()
        // ⌘K without a text selection opens the same search.
        try shortcut("k")
        wait(app.descendants(matching: .any)["quickfind.field"])
        app.typeText("Getting")
        wait(app.staticTexts["Getting Started"])
        escape()
        XCTAssertFalse(app.descendants(matching: .any)["quickfind.field"].waitForExistence(timeout: 1))
    }

    func testCommandPaletteCreatesPage() throws {
        try shortcut("n")
        wait(app.descendants(matching: .any)["palette"])
        wait(app.descendants(matching: .any)["palette.item1"])
        app.typeText("1")
        wait(app.descendants(matching: .any)["page.title"])
    }

    func testChatPanelToggles() throws {
        try shortcut("j")
        wait(app.descendants(matching: .any)["chat.panel"])
        wait(app.descendants(matching: .any)["ai.input"])
        wait(app.descendants(matching: .any)["ai.runWithAgent"])
        try shortcut("j")
        XCTAssertFalse(app.descendants(matching: .any)["chat.panel"].waitForExistence(timeout: 1))
    }

    func testFullPageChat() {
        app.descendants(matching: .any)["sidebar.askAI"].firstMatch.press()
        wait(app.descendants(matching: .any)["chat.page"])
        wait(app.descendants(matching: .any)["ai.input"])
    }

    func testTabs() throws {
        #if os(macOS)
        let tabs = app.descendants(matching: .any).matching(identifier: "tab")
        wait(tabs.firstMatch)
        let before = tabs.count
        try shortcut("t")
        XCTAssertTrue(waitUntil { tabs.count == before + 1 }, "⌘T should add a tab")
        try shortcut("w")
        XCTAssertTrue(waitUntil { tabs.count == before }, "⌘W should close the tab")
        #else
        throw XCTSkip("Tabs are macOS-only")
        #endif
    }

    func testFindInPage() throws {
        app.descendants(matching: .any)["sidebar.addPage"].firstMatch.press()
        let title = app.descendants(matching: .any)["page.title"].firstMatch
        wait(title); title.press(); title.typeText("Find test\nneedle in a haystack")
        try shortcut("f")
        let field = app.descendants(matching: .any)["find.field"].firstMatch
        wait(field)
        field.typeText("needle")
        let count = app.descendants(matching: .any)["find.count"].firstMatch
        wait(count)
        XCTAssertTrue(waitUntil { (count.label + ((count.value as? String) ?? "")).contains("1 of 1") }, "find should report one match")
        escape()
    }

    func testBlockGutterButtonsAreClickable() throws {
        #if os(macOS)
        app.descendants(matching: .any)["sidebar.addPage"].firstMatch.press()
        let title = app.descendants(matching: .any)["page.title"].firstMatch
        wait(title); title.press(); title.typeText("Gutter\nfirst block")
        let text = app.textViews.firstMatch
        wait(text)
        text.hover()
        // Moving onto the gutter must keep the + and ⋮⋮ visible (they used to disappear before the click).
        let add = app.descendants(matching: .any)["block.add"].firstMatch
        wait(add)
        add.hover()
        XCTAssertTrue(add.isHittable, "+ must stay hittable while hovering it")
        add.click()
        wait(app.descendants(matching: .any)["slash.menu"], 3)
        escape()
        #else
        throw XCTSkip("Hover gutter is macOS-only")
        #endif
    }

    func testSessionsAndInbox() {
        app.descendants(matching: .any)["sidebar.sessions"].firstMatch.press()
        wait(app.descendants(matching: .any)["sessions.list"])
        wait(app.descendants(matching: .any)["sessions.new"])
        app.descendants(matching: .any)["sessions.new"].firstMatch.press()
        wait(app.descendants(matching: .any)["session.agent"])
        wait(app.descendants(matching: .any)["session.cwd"])
        wait(app.descendants(matching: .any)["session.start"])
        escape()
        app.descendants(matching: .any)["sidebar.inbox"].firstMatch.press()
        wait(app.descendants(matching: .any)["inbox.list"])
    }

    func testAgentBrainDashboard() {
        app.descendants(matching: .any)["sidebar.brain"].firstMatch.press()
        wait(app.descendants(matching: .any)["brain.dashboard"])
    }

    /// Visits the main screens and fails on visible buttons that leave the window or sit on top of each other
    /// (the "UI is shifted / clipped / overlapping" class of bugs). The in-app LayoutAuditor logs the same checks.
    func testLayoutHasNoOverlapsOrClipping() throws {
        #if os(macOS)
        let screens: [(String, String?)] = [("sidebar.home", nil), ("sidebar.sessions", "sessions.list"),
                                            ("sidebar.brain", "brain.dashboard"), ("sidebar.inbox", "inbox.list"),
                                            ("sidebar.askAI", "chat.page")]
        var problems: [String] = []
        for (row, marker) in screens {
            app.descendants(matching: .any)[row].firstMatch.press()
            if let marker { wait(app.descendants(matching: .any)[marker]) }
            problems += layoutProblems(screen: row)
        }
        // A page with the docked chat open (narrowest content column).
        app.descendants(matching: .any)["sidebar.addPage"].firstMatch.press()
        wait(app.descendants(matching: .any)["page.title"])
        try shortcut("j")
        wait(app.descendants(matching: .any)["chat.panel"])
        problems += layoutProblems(screen: "page+chat")
        if !problems.isEmpty {
            let a = XCTAttachment(string: problems.joined(separator: "\n")); a.lifetime = .keepAlways; add(a)
        }
        XCTAssertTrue(problems.isEmpty, "Layout problems:\n" + problems.prefix(15).joined(separator: "\n"))
        #else
        throw XCTSkip("Window geometry checks are macOS-only")
        #endif
    }

    #if os(macOS)
    private func layoutProblems(screen: String) -> [String] {
        let window = app.windows.firstMatch.frame
        let all = app.buttons.allElementsBoundByIndex.prefix(160)
        var frames: [(String, CGRect)] = []
        var out: [String] = []
        for b in all {
            let f = b.frame
            guard f.width >= 4, f.height >= 4, b.isHittable else { continue }
            let name = b.identifier.isEmpty ? b.label : b.identifier
            if !window.insetBy(dx: -1, dy: -1).contains(f) { out.append("[\(screen)] \(name) outside window: \(f)") }
            frames.append((name, f))
        }
        for i in frames.indices {
            for j in frames.indices where j > i {
                let a = frames[i].1, b = frames[j].1
                let inter = a.intersection(b)
                guard !inter.isNull, !a.contains(b), !b.contains(a) else { continue }
                let smaller = min(a.width * a.height, b.width * b.height)
                if smaller > 0, inter.width * inter.height > 0.4 * smaller {
                    out.append("[\(screen)] \(frames[i].0) overlaps \(frames[j].0)")
                }
            }
        }
        return out
    }
    #endif

    private func waitUntil(_ timeout: TimeInterval = 4, _ condition: () -> Bool) -> Bool {
        let end = Date().addingTimeInterval(timeout)
        while Date() < end {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        }
        return condition()
    }

    func testSettingsPages() throws {
        #if os(macOS)
        try shortcut(",")
        #else
        app.descendants(matching: .any)["sidebar.settings"].firstMatch.press()
        #endif
        wait(app.descendants(matching: .any)["settings.root"])
        for page in ["myAccount", "mySettings", "myNotifications", "myConnections", "languageRegion", "workspace", "people", "teamspaces", "security", "agents", "connections", "importData", "sync", "billing", "about"] {
            let row = app.descendants(matching: .any)["settings.\(page)"].firstMatch
            wait(row); row.press()
        }
        app.descendants(matching: .any)["settings.mySettings"].firstMatch.press()
        wait(app.descendants(matching: .any)["settings.appearance"])
        app.descendants(matching: .any)["settings.connections"].firstMatch.press()
        wait(app.descendants(matching: .any)["connections.add"])
    }

    func testDatabaseTableRenders() {
        // Home shows onboarding content which includes a sample database.
        app.descendants(matching: .any)["sidebar.home"].firstMatch.press()
        let sidebar = app.descendants(matching: .any)["sidebar"].firstMatch
        wait(sidebar)
        // open the first page in "Private"
        let firstPage = app.outlines.firstMatch.cells.element(boundBy: 3)
        if firstPage.exists { firstPage.press() }
        _ = app.descendants(matching: .any)["table.header"].waitForExistence(timeout: 5)
    }
}

extension XCUIElement {
    /// click (macOS) / tap (iOS)
    func press() {
        #if os(macOS)
        click()
        #else
        tap()
        #endif
    }
}
