import Foundation

extension BlockProps {
    /// The steps a button runs. Buttons from before steps existed have one `buttonAction`; an "Add page" one
    /// opened the new page in a center peek unless `openAfter` was off — that becomes an explicit second step.
    public var effectiveButtonActions: [ButtonAction] {
        if let list = buttonActions { return list }
        let a = buttonAction ?? ButtonAction(kind: .insertBlocks)
        if a.kind == .addPage, a.openAfter ?? true {
            var add = a
            add.openAfter = nil
            return [add, ButtonAction(kind: .openAdded, mode: .centerPeek, step: 0)]
        }
        return [a]
    }
}

/// What the UI has to do after a button ran its store steps.
public enum ButtonEffect: Equatable, Sendable {
    case open(RecordID, OpenMode?)
    case openURL(String)
    /// Put the caret at the end of this block (the last inserted one).
    case focusEnd(RecordID)
    /// A step couldn't run (missing database / page / blocks): the button's editor should open.
    case needsSetup
}

/// Where a button stopped to ask (`confirm` step): show `message`, then `resume` from `next` on OK.
public struct ButtonPause: Equatable, Sendable {
    public var message: String
    public var next: Int
    /// Pages added so far, by step index (for later `openAdded` steps).
    public var added: [Int: RecordID]
}

extension WorkspaceStore {
    /// Runs a button's steps from `start`: store changes happen here (each step its own undoable action),
    /// UI work comes back as effects. Stops at a `confirm` step and returns where to go on.
    public func runButton(_ id: RecordID, from start: Int = 0, added: [Int: RecordID] = [:]) -> (effects: [ButtonEffect], pause: ButtonPause?) {
        guard let button = blocks[id] else { return ([], nil) }
        let steps = button.props.effectiveButtonActions
        var effects: [ButtonEffect] = []
        var added = added
        var lastAdded: RecordID? = added.keys.max().flatMap { added[$0] }
        var i = start
        while i < steps.count {
            let a = steps[i]
            switch a.kind {
            case .confirm:
                let msg = (a.message ?? "").trimmingCharacters(in: .whitespaces)
                return (effects, ButtonPause(message: msg.isEmpty ? "Are you sure?" : msg, next: i + 1, added: added))
            case .insertBlocks:
                let kids = contentBlocks(of: id)
                guard !kids.isEmpty else { effects.append(.needsSetup); break }
                var last = id
                transact("Insert from button") { tx in
                    let keys = tx.sortKeys(kids.count, in: button.parent, .after(id))
                    for (k, key) in zip(kids, keys) { last = copySubtree(k, parent: button.parent, sortKey: key, tx: tx) }
                }
                effects.append(.focusEnd(last))
            case .addPage:
                guard let db = a.targetID, databases[db] != nil else { effects.append(.needsSetup); break }
                let row = addRow(to: db, title: RichText(a.title ?? ""), values: a.values ?? [:])
                added[i] = row
                lastAdded = row
                if steps.count == 1, a.openAfter ?? false { effects.append(.open(row, .centerPeek)) }
            case .openPage:
                guard let t = a.targetID, blocks[t] != nil else { effects.append(.needsSetup); break }
                effects.append(.open(t, a.mode))
            case .openAdded:
                let target = a.step.flatMap { added[$0] } ?? lastAdded
                if let target { effects.append(.open(target, a.mode)) }
            case .openURL:
                guard let u = a.url, !u.isEmpty else { effects.append(.needsSetup); break }
                effects.append(.openURL(u))
            }
            i += 1
        }
        return (effects, nil)
    }
}
