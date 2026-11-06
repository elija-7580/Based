import Foundation

/// One rendered block for the editor gutter and block drag & drop. All frames share one coordinate space
/// (the page canvas); `frame` covers the block's own line(s) — children rendered below it are separate rows.
public struct BlockLayoutRow: Sendable, Equatable {
    public var id: RecordID
    public var frame: CGRect
    /// Parent block for outdenting (nil when the parent is the page or a column — dropping can't leave those).
    public var parent: RecordID?
    /// Last visible child of its parent (dropping below it may outdent).
    public var isLastChild: Bool
    /// Can take children (text, lists, to-dos, toggles, …): dropping right-shifted below it nests.
    public var canNest: Bool
    /// Children are shown right below it (open toggle, list item with sub-items): "below" means "first child".
    public var childrenBelow: Bool
    /// Side drops create columns.
    public var allowsColumns: Bool

    public init(id: RecordID, frame: CGRect, parent: RecordID? = nil, isLastChild: Bool = false, canNest: Bool = true,
                childrenBelow: Bool = false, allowsColumns: Bool = true) {
        self.id = id; self.frame = frame; self.parent = parent; self.isLastChild = isLastChild
        self.canNest = canNest; self.childrenBelow = childrenBelow; self.allowsColumns = allowsColumns
    }
}

public enum BlockDropPlacement: Sendable, Equatable {
    case before(RecordID)
    case after(RecordID)
    case firstChild(RecordID)
    case column(RecordID, leading: Bool)
}

public struct BlockDropTarget: Sendable, Equatable {
    public var placement: BlockDropPlacement
    /// The blue line to draw (3 pt thick; vertical for column drops).
    public var indicator: CGRect
    public var isVertical: Bool { indicator.height > indicator.width }
}

/// Pure geometry behind the + / ⋮⋮ gutter and Notion-style block dragging (tested in BasedCoreTests).
public enum BlockGutterGeometry {
    /// Room left of a block's text where its + and ⋮⋮ live (and where hovering keeps them visible).
    public static let gutterWidth: CGFloat = 56
    /// Extra room right of a block that still counts as hovering it.
    public static let trailingSlack: CGFloat = 40

    // MARK: Hover

    /// The block whose handle should show for a pointer at `p`: the innermost block under the pointer, or the
    /// block whose gutter the pointer is in. A gutter wins over a block it lies inside (a child of a callout or
    /// column shows its own handle), never over a neighbour (columns side by side).
    public static func hoverTarget(at p: CGPoint, frames: [(id: RecordID, frame: CGRect)], slack: CGFloat = 2) -> RecordID? {
        var direct: (id: RecordID, frame: CGRect)?
        var trailing: (id: RecordID, frame: CGRect)?
        var gutterHits: [(id: RecordID, frame: CGRect)] = []
        for item in frames {
            let f = item.frame
            guard f.width > 0, f.height > 0, p.y >= f.minY - slack, p.y <= f.maxY + slack else { continue }
            if p.x >= f.minX, p.x <= f.maxX {
                if direct == nil || area(f) < area(direct!.frame) { direct = item }
            } else if p.x > f.maxX, p.x <= f.maxX + trailingSlack {
                if trailing == nil || area(f) < area(trailing!.frame) { trailing = item }
            } else if p.x < f.minX, p.x >= f.minX - gutterWidth {
                gutterHits.append(item)
            }
        }
        let nested = gutterHits.filter { g in direct.map { contains($0.frame, g.frame) } ?? true }
        if let g = nested.min(by: { area($0.frame) < area($1.frame) }) { return g.id }
        // Just right of a block's text counts too — but never over a neighbour's gutter (handled above).
        return direct?.id ?? trailing?.id
    }

    // MARK: Drop

    /// Where a drag at pointer `p` lands.
    /// - `blockLeft`: where the dragged block's left edge is now (pointer x minus the grab offset) — moving it a
    ///   bit right of a block nests under it, left of a last child's level outdents.
    /// - `rows` must not contain the dragged blocks or their descendants.
    public static func dropTarget(at p: CGPoint, blockLeft: CGFloat, rows: [BlockLayoutRow],
                                  indent: CGFloat = 26, spacing: CGFloat = 2) -> BlockDropTarget? {
        guard let t = nearest(to: p, rows: rows) else { return nil }
        let f = t.frame
        let threshold = indent * 0.75
        let line: CGFloat = 3

        if t.allowsColumns {
            if f.width > 160, p.x >= f.maxX - 40, p.x <= f.maxX + gutterWidth {
                return .init(placement: .column(t.id, leading: false), indicator: CGRect(x: f.maxX + 2, y: f.minY, width: line, height: f.height))
            }
            if f.width > 160, p.x >= f.minX - 4, p.x <= f.minX + 12, p.y > f.minY + f.height * 0.25, p.y < f.maxY - f.height * 0.25 {
                return .init(placement: .column(t.id, leading: true), indicator: CGRect(x: f.minX - 6, y: f.minY, width: line, height: f.height))
            }
        }

        if p.y < f.midY {
            let y = f.minY - spacing / 2 - line / 2
            return .init(placement: .before(t.id), indicator: CGRect(x: f.minX, y: y, width: f.width, height: line))
        }
        let y = f.maxY + spacing / 2 - line / 2
        if t.childrenBelow || (t.canNest && blockLeft >= f.minX + threshold) {
            let x = f.minX + indent
            return .init(placement: .firstChild(t.id), indicator: CGRect(x: x, y: y, width: max(40, f.maxX - x), height: line))
        }
        // Outdent: below a last child with the block moved left of that child's level.
        let byID = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var anchor = t
        while anchor.isLastChild, let pid = anchor.parent, let parent = byID[pid], blockLeft <= anchor.frame.minX - threshold {
            anchor = parent
        }
        let x = anchor.frame.minX
        return .init(placement: .after(anchor.id), indicator: CGRect(x: x, y: y, width: max(40, max(f.maxX, anchor.frame.maxX) - x), height: line))
    }

    /// The row a drop at `p` refers to: closest vertically; the gutter counts as inside; ties → innermost.
    static func nearest(to p: CGPoint, rows: [BlockLayoutRow]) -> BlockLayoutRow? {
        var best: (row: BlockLayoutRow, score: CGFloat)?
        for r in rows {
            let f = r.frame
            guard f.width > 0, f.height > 0 else { continue }
            let dy = p.y < f.minY ? f.minY - p.y : (p.y > f.maxY ? p.y - f.maxY : 0)
            let left = f.minX - gutterWidth, right = f.maxX + trailingSlack
            let dx = p.x < left ? left - p.x : (p.x > right ? p.x - right : 0)
            let score = dy + dx * 0.5
            if let b = best {
                if score < b.score - 0.01 || (abs(score - b.score) <= 0.01 && area(f) < area(b.row.frame)) { best = (r, score) }
            } else {
                best = (r, score)
            }
        }
        return best?.row
    }

    static func area(_ r: CGRect) -> CGFloat { r.width * r.height }

    static func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
        inner.minX >= outer.minX - 0.5 && inner.maxX <= outer.maxX + 0.5 && inner.minY >= outer.minY - 0.5 && inner.maxY <= outer.maxY + 0.5
            && !(inner == outer)
    }
}
