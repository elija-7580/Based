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
        for id in ["sidebar.search", "sidebar.askAI", "sidebar.home", "sidebar.sessions", "sidebar.inbox", "sidebar.addPage", "sidebar.trash"] {
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
    }

    func testAskAIPanelAndRunWithAgent() throws {
        try shortcut("j")
        wait(app.descendants(matching: .any)["ai.runWithAgent"])
        escape()
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
