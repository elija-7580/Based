import Foundation

/// BSD-96 (ADR 0005): a saved coding-session transcript in the chat's shape, so the session console renders it
/// with the same views as the chat — user prompts, assistant replies made of `ChatPart`s, and console lines
/// (notices, system messages) that are not part of a reply.
public enum SessionTranscript {
    public enum Segment: Sendable, Equatable, Identifiable {
        case user(TranscriptItem)
        case reply(id: Int, parts: [ChatPart])
        case line(TranscriptItem)

        public var id: Int {
            switch self {
            case .user(let i), .line(let i): return i.id
            case .reply(let id, _): return id
            }
        }
    }

    /// Groups the items in order. Consecutive assistant items (text, thinking, tools, plans, diffs, errors) form one
    /// reply; a diff right after its edit tool call is folded into that tool card.
    public static func segments(_ items: [TranscriptItem]) -> [Segment] {
        var out: [Segment] = []
        var run: [TranscriptItem] = []
        func flush() {
            guard let first = run.first else { return }
            out.append(.reply(id: first.id, parts: parts(run)))
            run = []
        }
        for item in items {
            switch item.kind {
            case .user: flush(); out.append(.user(item))
            case .notice, .system: flush(); out.append(.line(item))
            default: run.append(item)
            }
        }
        flush()
        return out
    }

    /// Assistant items → parts, with each diff attached to the edit tool call before it (when that has none yet).
    public static func parts(_ items: [TranscriptItem]) -> [ChatPart] {
        var out: [ChatPart] = []
        for (item, part) in zip(items, aligned(items)) {
            guard let part else { continue }
            if item.kind == .diff, let i = out.indices.last, out[i].kind == .tool, out[i].diff == nil,
               ["Edit", "Write", "MultiEdit"].contains(out[i].toolName) {
                out[i].diff = part.diff; out[i].added = part.added; out[i].removed = part.removed
                if out[i].detail.isEmpty { out[i].detail = part.detail }
                continue
            }
            out.append(part)
        }
        return out
    }

    /// One part (or nil) per item, keeping the item ↔ part pairing that `ChatTurnBuilder.parts(from:)` drops.
    private static func aligned(_ items: [TranscriptItem]) -> [ChatPart?] {
        items.map { item in
            var p = ChatTurnBuilder.parts(from: [item]).first
            p?.id = "s\(item.id)"
            return p
        }
    }
}
