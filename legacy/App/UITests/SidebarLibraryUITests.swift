import XCTest

/// Sidebar / Trash / Library flows plus the screenshots requested for the sidebar redesign.
/// Screenshots are attached to the test result (Xcode → Report navigator) and, on macOS, also written to
/// `$BASED_SCREENSHOT_DIR` (default `/tmp/based-screenshots`).  Run: `make uitest`.
final class SidebarLibraryUITests: XCTestCase {
    var app: XCUIApplication!

    override func setUpWithError() throws {
        #if !os(macOS)
        throw XCTSkip("Hover, right-click and ⌘-shortcuts are macOS-only")
        #else
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments += ["-ui-testing", "-AppleLanguages", "(en)"]
        app.launch()
        #endif
    }

    #if os(macOS)
    private func el(_ id: String) -> XCUIElement { app.descendants(matching: .any)[id].firstMatch }

    private func sidebarRow(_ title: String) -> XCUIElement {
        app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier == 'sidebar.page' AND label CONTAINS %@", title)).firstMatch
    }

    private func wait(_ e: XCUIElement, _ timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(e.waitForExistence(timeout: timeout), "Missing element \(e)", file: file, line: line)
    }

    private func shot(_ name: String) {
        let s = app.windows.firstMatch.screenshot()
        let a = XCTAttachment(screenshot: s)
        a.name = name
        a.lifetime = .keepAlways
        add(a)
        let dir = ProcessInfo.processInfo.environment["BASED_SCREENSHOT_DIR"] ?? "/tmp/based-screenshots"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? s.pngRepresentation.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }

    private func newPage(_ title: String) {
        el("sidebar.addPage").click()
        let t = el("page.title")
        wait(t)
        t.click()
        t.typeText(title)
        wait(sidebarRow(title))
    }

    private func deleteFromSidebar(_ title: String) {
        let row = sidebarRow(title)
        wait(row)
        row.rightClick()
        app.menuItems["Delete"].firstMatch.click()
    }

    func testScreenshotsOfSidebarLibraryAndTrash() {
        newPage("Screenshot parent")
        wait(el("sidebar"))
        shot("01-sidebar-expanded")

        let row = sidebarRow("Getting Started")
        wait(row)
        row.hover()
        wait(el("sidebar.page.more"), 2)
        shot("02-sidebar-row-hover")

        row.rightClick()
        wait(app.menuItems["Move to…"].firstMatch, 2)
        shot("03-sidebar-context-menu")
        app.typeKey(.escape, modifierFlags: [])

        app.typeKey("\\", modifierFlags: .command)
        XCTAssertFalse(el("sidebar.footer").waitForExistence(timeout: 1.5))
        shot("04-sidebar-collapsed")
        app.typeKey("\\", modifierFlags: .command)
        wait(el("sidebar.footer"))

        el("sidebar.library").click()
        wait(el("library"))
        wait(el("library.row"))
        el("library.row").click()
        app.typeKey("a", modifierFlags: .command)
        wait(el("library.actionBar"), 2)
        wait(el("library.selectionCount"), 2)
        shot("05-library-multi-selection")
        app.typeKey(.escape, modifierFlags: [])

        deleteFromSidebar("Screenshot parent")
        el("sidebar.trash").click()
        wait(el("trash"))
        wait(el("trash.row"))
        shot("06-trash")
    }

    /// Delete → Undo → Delete → Restore from Trash → Delete → Delete permanently (with confirmation).
    func testDeleteUndoRestoreDeletePermanently() {
        let title = "Trash flow page"
        newPage(title)

        deleteFromSidebar(title)
        wait(el("toast.action"))
        XCTAssertFalse(sidebarRow(title).waitForExistence(timeout: 1))
        el("toast.action").click()
        wait(sidebarRow(title))

        deleteFromSidebar(title)
        el("sidebar.trash").click()
        wait(el("trash.row"))
        el("trash.restore").click()
        wait(sidebarRow(title))

        deleteFromSidebar(title)
        el("sidebar.trash").click()
        wait(el("trash.row"))
        el("trash.deleteForever").click()
        let confirm = app.buttons["Delete permanently"].firstMatch
        wait(confirm, 2)
        confirm.click()
        XCTAssertFalse(el("trash.row").waitForExistence(timeout: 1.5))
        XCTAssertFalse(sidebarRow(title).exists)
    }

    /// Move one page and then two pages via "Move to…", and nest one by dragging it onto another.
    func testMoveAndNestPages() {
        newPage("Move target")
        newPage("Move A")
        newPage("Move B")

        // One page.
        sidebarRow("Move A").rightClick()
        app.menuItems["Move to…"].firstMatch.click()
        wait(el("move.picker"))
        el("move.search").typeText("Move target")
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'move.target' AND label CONTAINS 'Move target'")).firstMatch.click()
        wait(el("toast"))

        // Several pages (⌘-click to multi-select).
        newPage("Move C")
        sidebarRow("Move B").click()
        XCUIElement.perform(withKeyModifiers: .command) { sidebarRow("Move C").click() }
        sidebarRow("Move C").rightClick()
        wait(app.staticTexts["2 pages selected"].firstMatch, 2)
        app.menuItems["Move to…"].firstMatch.click()
        wait(el("move.picker"))
        el("move.search").typeText("Move target")
        app.descendants(matching: .any).matching(NSPredicate(format: "identifier == 'move.target' AND label CONTAINS 'Move target'")).firstMatch.click()
        wait(el("toast"))

        // Drag & drop: nest "Move target" inside "Getting Started".
        let target = sidebarRow("Getting Started")
        sidebarRow("Move target").press(forDuration: 0.4, thenDragTo: target)
        target.hover()
        wait(el("sidebar.toggle"), 2)
    }
    #endif
}
