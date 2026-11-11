import Foundation
import Testing
@testable import BasedCore

/// BSD-112: relation cells hide trashed pages, renames reach `current.prop(…)` in related databases, and a
/// duplicated database keeps its self-relations among its own rows.
@MainActor
@Suite struct RelationIntegrityPart2Tests {
    @Test func trashedTargetsAreNotShown() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "r2")
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0).databaseID
        let a = s.addRow(to: tasks, title: "A"), b = s.addRow(to: tasks, title: "B")
        _ = s.trashPages([b])
        #expect(s.liveRelationTargets([a, b, "missing"]) == [a])
        s.restorePages([b])
        #expect(s.liveRelationTargets([a, b]) == [a, b])
    }

    @Test func renameRewritesCurrentPropInRelatedDatabases() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "r2")
        let projects = s.createDatabase(title: "Projects", in: .workspace, inline: false, sampleRows: 0).databaseID
        let tasks = s.createDatabase(title: "Tasks", in: .workspace, inline: false, sampleRows: 0).databaseID
        let est = s.addProperty(to: tasks, name: "Alt", type: .number)!
        let rel = s.addProperty(to: projects, name: "Tasks", type: .relation)!
        s.updateProperty(projects, rel) { $0.relation = RelationConfig(databaseID: tasks) }
        let own = s.addProperty(to: projects, name: "Alt", type: .number)!   // same name, other database
        let f = s.addProperty(to: projects, name: "Sum", type: .formula)!
        let src = #"prop("Tasks").filter(current.prop("Alt") > 1).map(current.prop("Alt")).sum() + prop("Alt")"#
        s.updateProperty(projects, f) { $0.formula = src }

        s.renameProperty(tasks, est, to: "Neu")
        #expect(s.databases[projects]!.property(f)!.formula
                == #"prop("Tasks").filter(current.prop("Neu") > 1).map(current.prop("Neu")).sum() + prop("Alt")"#)
        _ = own

        // Undo restores the old formula in the same step.
        _ = s.undo()
        #expect(s.databases[projects]!.property(f)!.formula == src)
    }

    @Test func renameLeavesOtherReceiversAlone() {
        let rels: Set<String> = ["Tasks"]
        func r(_ s: String) -> String { WorkspaceStore.renamingRelatedReferences(s, relations: rels, from: "Alt", to: "Neu") }
        // Another relation, a nested lambda (current is rebound), a string literal and `.first()` are untouched.
        #expect(r(#"prop("People").map(current.prop("Alt"))"#) == #"prop("People").map(current.prop("Alt"))"#)
        #expect(r(#"prop("Tasks").map(current.prop("Sub").map(current.prop("Alt")))"#)
                == #"prop("Tasks").map(current.prop("Sub").map(current.prop("Alt")))"#)
        #expect(r(#"prop("Tasks").map("current.prop(\"Alt\")")"#) == #"prop("Tasks").map("current.prop(\"Alt\")")"#)
        #expect(r(#"prop("Tasks").first().prop("Alt")"#) == #"prop("Tasks").first().prop("Alt")"#)
        #expect(r(#"prop( "Tasks" ) . some( current . prop( "Alt" ) )"#) == #"prop( "Tasks" ) . some( current.prop("Neu") )"#)
        #expect(r(#"x.prop("Tasks").map(current.prop("Alt"))"#) == #"x.prop("Tasks").map(current.prop("Alt"))"#)
    }

    @Test func duplicatedDatabaseKeepsSelfRelationsAmongItsRows() {
        let s = WorkspaceStore(persistence: MemoryPersistence(), node: "r2")
        let c = s.createDatabase(title: "Tree", in: .workspace, inline: false, sampleRows: 0)
        let db = c.databaseID
        let parent = s.addProperty(to: db, name: "Parent", type: .relation)!
        s.updateProperty(db, parent) { $0.relation = RelationConfig(databaseID: db) }
        s.makeRelationTwoWay(db, parent, name: "Children")
        let children = s.databases[db]!.property(parent)!.relation!.syncedPropertyID!
        let root = s.addRow(to: db, title: "Root"), leaf = s.addRow(to: db, title: "Leaf"), gone = s.addRow(to: db, title: "Gone")
        s.setRelation(leaf, parent, [root, gone])
        _ = s.trashPages([gone])

        let dup = s.duplicatePages([c.blockID]).first!
        let ndbID = s.blocks[dup]!.props.databaseID!
        #expect(ndbID != db)
        let ndb = s.databases[ndbID]!
        #expect(ndb.property(parent)!.relation?.databaseID == ndbID)
        #expect(ndb.property(parent)!.relation?.syncedPropertyID == children)
        let rows = s.rows(of: ndbID)
        let newRoot = rows.first { $0.text.plainText == "Root" }!.id
        let newLeaf = rows.first { $0.text.plainText == "Leaf" }!.id
        #expect(s.blocks[newLeaf]!.values[parent] == .relation([newRoot]))
        #expect(s.blocks[newRoot]!.values[children] == .relation([newLeaf]))
        // The original is untouched.
        #expect(s.blocks[leaf]!.values[parent] == .relation([root, gone]))
        #expect(s.databases[db]!.property(parent)!.relation?.databaseID == db)

        // One undo step removes the whole copy.
        _ = s.undo()
        #expect(s.blocks[dup] == nil && s.databases[ndbID] == nil)
    }
}
