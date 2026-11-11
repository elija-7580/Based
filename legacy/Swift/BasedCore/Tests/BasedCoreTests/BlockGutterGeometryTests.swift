import Foundation
import Testing
@testable import BasedCore

@Suite struct BlockGutterGeometryTests {
    // A page: "a" (text), "b" (bulleted, with child "b1"), "c" (text). Text column starts at x = 100.
    let a = CGRect(x: 100, y: 0, width: 600, height: 24)
    let b = CGRect(x: 100, y: 26, width: 600, height: 24)
    let b1 = CGRect(x: 126, y: 52, width: 574, height: 24)
    let c = CGRect(x: 100, y: 78, width: 600, height: 24)

    var rows: [BlockLayoutRow] {
        [.init(id: "a", frame: a), .init(id: "b", frame: b, childrenBelow: true),
         .init(id: "b1", frame: b1, parent: "b", isLastChild: true), .init(id: "c", frame: c, isLastChild: true)]
    }

    @Test func hoverInGutterKeepsTheBlock() {
        let frames = rows.map { (id: $0.id, frame: $0.frame) }
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 300, y: 10), frames: frames) == "a")
        // On the way to the ⋮⋮ (left of the text) the handle must stay with the same block.
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 60, y: 10), frames: frames) == "a")
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 90, y: 60), frames: frames) == "b1")
        // Far out in the margin: nothing.
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 20, y: 10), frames: frames) == nil)
    }

    @Test func hoverPrefersNestedChildGutterAndNeighbourColumn() {
        // A callout whose frame contains its child: the child's gutter (inside the callout) wins.
        let callout = CGRect(x: 100, y: 0, width: 600, height: 80)
        let child = CGRect(x: 140, y: 30, width: 540, height: 24)
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 120, y: 40), frames: [("callout", callout), ("child", child)]) == "child")
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 300, y: 10), frames: [("callout", callout), ("child", child)]) == "callout")
        // Two columns: the right column's gutter overlaps the left column's text — the left block keeps it.
        let left = CGRect(x: 100, y: 0, width: 280, height: 24)
        let right = CGRect(x: 420, y: 0, width: 280, height: 24)
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 370, y: 10), frames: [("l", left), ("r", right)]) == "l")
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 385, y: 10), frames: [("l", left), ("r", right)]) == "r", "the right block's ⋮⋮ sits in the gap — hovering it must keep that handle")
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 360, y: 10), frames: [("l", left), ("r", right)]) == "l")
        #expect(BlockGutterGeometry.hoverTarget(at: CGPoint(x: 430, y: 10), frames: [("l", left), ("r", right)]) == "r")
    }

    @Test func dropBeforeAfterAndFirstChild() {
        // Dragging from the gutter: pointer at x = 80, block's left edge follows at x = 100 (same level).
        let top = BlockGutterGeometry.dropTarget(at: CGPoint(x: 80, y: 4), blockLeft: 100, rows: rows)
        #expect(top?.placement == .before("a"))
        #expect(top.map { $0.indicator.minX } == 100)
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 80, y: 20), blockLeft: 100, rows: rows)?.placement == .after("a"))
        // Lower half of a block whose children show below it → becomes its first child.
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 80, y: 46), blockLeft: 100, rows: rows)?.placement == .firstChild("b"))
        // Moved right of "a"'s text by more than ¾ indent → nests under "a".
        let nest = BlockGutterGeometry.dropTarget(at: CGPoint(x: 110, y: 20), blockLeft: 130, rows: rows)
        #expect(nest?.placement == .firstChild("a"))
        #expect(nest.map { $0.indicator.minX } == 126)
        // Below everything → after the last block.
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 80, y: 300), blockLeft: 100, rows: rows)?.placement == .after("c"))
    }

    @Test func dropOutdentsBelowLastChild() {
        // Below "b1" at b1's level → stays a sibling of b1.
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 106, y: 70), blockLeft: 126, rows: rows)?.placement == .after("b1"))
        // Same spot, block moved back to the page level → after "b".
        let out = BlockGutterGeometry.dropTarget(at: CGPoint(x: 80, y: 70), blockLeft: 100, rows: rows)
        #expect(out?.placement == .after("b"))
        #expect(out.map { $0.indicator.minX } == 100)
    }

    @Test func dropOnSidesMakesColumns() {
        let right = BlockGutterGeometry.dropTarget(at: CGPoint(x: 690, y: 12), blockLeft: 710, rows: rows)
        #expect(right?.placement == .column("a", leading: false))
        #expect(right?.isVertical == true)
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 104, y: 12), blockLeft: 124, rows: rows)?.placement == .column("a", leading: true))
        var noColumns = rows; noColumns[0].allowsColumns = false
        #expect(BlockGutterGeometry.dropTarget(at: CGPoint(x: 690, y: 12), blockLeft: 710, rows: noColumns)?.placement == .firstChild("a"))
        #expect(BlockGutterGeometry.dropTarget(at: .zero, blockLeft: 0, rows: []) == nil)
    }
}
