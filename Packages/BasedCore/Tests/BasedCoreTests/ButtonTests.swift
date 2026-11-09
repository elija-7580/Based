import Foundation
import Testing
@testable import BasedCore

@MainActor
struct ButtonTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    @Test func legacyAddPageOpensInCenterPeek() {
        var p = BlockProps()
        p.buttonAction = ButtonAction(kind: .addPage, targetID: "db")
        #expect(p.effectiveButtonActions.map(\.kind) == [.addPage, .openAdded])
        p.buttonAction?.openAfter = false
        #expect(p.effectiveButtonActions.map(\.kind) == [.addPage])
        #expect(BlockProps().effectiveButtonActions.map(\.kind) == [.insertBlocks])
    }

    @Test func stepsRunInOrderAndPauseAtConfirm() {
        let s = store()
        let page = s.createPage(title: "Home")
        let c = s.createDatabase(in: .block(page), inline: true, viewType: .table)
        var props = BlockProps()
        props.buttonLabel = "New project"
        props.buttonActions = [
            ButtonAction(kind: .addPage, targetID: c.databaseID, title: "Untitled project"),
            ButtonAction(kind: .confirm, message: "Open it?"),
            ButtonAction(kind: .openAdded, mode: .sidePeek, step: 0),
        ]
        let button = s.insertBlock(.button, props: props, in: .block(page))
        let first = s.runButton(button)
        #expect(first.effects.isEmpty)
        let pause = try! #require(first.pause)
        #expect(pause.message == "Open it?" && pause.next == 2)
        let row = try! #require(pause.added[0])
        #expect(s.title(of: row) == "Untitled project")
        let rest = s.runButton(button, from: pause.next, added: pause.added)
        #expect(rest.effects == [.open(row, .sidePeek)])
        #expect(rest.pause == nil)
    }

    @Test func missingTargetAsksForSetup() {
        let s = store()
        let page = s.createPage(title: "P")
        var props = BlockProps()
        props.buttonActions = [ButtonAction(kind: .openPage)]
        let b = s.insertBlock(.button, props: props, in: .block(page))
        #expect(s.runButton(b).effects == [.needsSetup])
    }
}
