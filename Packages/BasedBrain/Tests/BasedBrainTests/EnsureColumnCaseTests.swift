import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-135: a Brain column renamed only in case ("Goal" → "goal") must not make `ensureColumn` add "Goal 2",
/// "Goal 3" … on every refresh (that fed back through the HappierModel store observer without end).
@MainActor
struct EnsureColumnCaseTests {
    @Test func caseOnlyRenameDoesNotAddColumnsAgain() throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let db = brain.ensureProjects()
        let goal = try #require(brain.propID(db, BrainStore.ProjectCol.goal))
        store.renameProperty(db, goal, to: "goal")
        let before = store.databases[db]?.properties.count ?? 0
        var commits = 0
        let token = store.observe { _ in commits += 1 }
        for _ in 0..<5 { _ = brain.ensureProjects() }
        _ = token
        #expect(store.databases[db]?.properties.count == before)
        #expect(store.databases[db]?.properties.contains { $0.name.hasPrefix("Goal ") } == false)
        #expect(commits == 0, "ensureProjects on an up-to-date database writes nothing")
        #expect(brain.propID(db, BrainStore.ProjectCol.goal) == goal, "found ignoring case")
    }
}
