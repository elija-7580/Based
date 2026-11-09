// BSD-29 Spike – Wegwerf-Code. Ein Replicated Growable Array (RGA) für einen Absatz,
// plus Formatierung als „Mark-Ops“ (vereinfachte Peritext-Idee: ein Mark zeigt auf
// Zeichen-IDs statt auf Positionen; pro Zeichen und Mark-Name gewinnt die neueste Op).
//
// Nicht optimiert (lineare Suche, ein Array), genügt für Absätze bis ein paar tausend Zeichen.

/// Eindeutige, total geordnete ID einer Op: Lamport-Zähler, bei Gleichstand die Replikat-ID.
public struct OpID: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public var counter: Int
    public var replica: UInt32
    public init(_ counter: Int, _ replica: UInt32) { self.counter = counter; self.replica = replica }
    public static func < (a: OpID, b: OpID) -> Bool {
        a.counter != b.counter ? a.counter < b.counter : a.replica < b.replica
    }
    public var description: String { "\(counter)@\(replica)" }
}

public enum TextOp: Hashable, Sendable, Codable {
    /// Zeichen `char` mit ID `id` direkt rechts von `after` (nil = Absatzanfang) einfügen.
    case insert(id: OpID, after: OpID?, char: Character)
    /// Zeichen mit ID `target` löschen (Tombstone bleibt).
    case delete(id: OpID, target: OpID)
    /// Formatierung `name` = `value` (nil = entfernen) von Zeichen `start` bis einschließlich `end`.
    case mark(id: OpID, start: OpID, end: OpID, name: String, value: String?)

    public var id: OpID {
        switch self {
        case .insert(let id, _, _), .delete(let id, _), .mark(let id, _, _, _, _): return id
        }
    }

    // Codable für Character über String.
    enum K: String, CodingKey { case t, id, after, c, target, s, e, n, v }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: K.self)
        switch self {
        case .insert(let id, let after, let ch):
            try c.encode("i", forKey: .t); try c.encode(id, forKey: .id)
            try c.encodeIfPresent(after, forKey: .after); try c.encode(String(ch), forKey: .c)
        case .delete(let id, let target):
            try c.encode("d", forKey: .t); try c.encode(id, forKey: .id); try c.encode(target, forKey: .target)
        case .mark(let id, let s, let e, let n, let v):
            try c.encode("m", forKey: .t); try c.encode(id, forKey: .id); try c.encode(s, forKey: .s)
            try c.encode(e, forKey: .e); try c.encode(n, forKey: .n); try c.encodeIfPresent(v, forKey: .v)
        }
    }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: K.self)
        let id = try c.decode(OpID.self, forKey: .id)
        switch try c.decode(String.self, forKey: .t) {
        case "i": self = .insert(id: id, after: try c.decodeIfPresent(OpID.self, forKey: .after),
                                 char: Character(try c.decode(String.self, forKey: .c)))
        case "d": self = .delete(id: id, target: try c.decode(OpID.self, forKey: .target))
        default: self = .mark(id: id, start: try c.decode(OpID.self, forKey: .s), end: try c.decode(OpID.self, forKey: .e),
                              name: try c.decode(String.self, forKey: .n), value: try c.decodeIfPresent(String.self, forKey: .v))
        }
    }
}

/// Ein formatierter Abschnitt – entspricht `TextRun` in BasedCore (ohne Mentions/Gleichungen).
public struct Span: Equatable, Sendable {
    public var text: String
    public var marks: [String: String]
}

public struct RGAText: Sendable {
    struct Element: Sendable { var id: OpID; var after: OpID?; var char: Character; var deleted: Bool }

    public let replica: UInt32
    private(set) var elements: [Element] = []
    private var index: [OpID: Int] = [:]          // id → Position in `elements` (nach Einfügen neu aufgebaut)
    private var marks: [TextOp] = []
    private var seen: Set<OpID> = []
    private var pending: [TextOp] = []            // Ops, deren Vorgänger noch fehlt (kausale Pufferung)
    public private(set) var log: [TextOp] = []
    private var clock = 0

    public init(replica: UInt32) { self.replica = replica }

    // MARK: Lokale Bearbeitung (Positionen sind sichtbare Zeichen-Offsets)

    public var string: String { String(elements.lazy.filter { !$0.deleted }.map(\.char)) }

    private func visibleIDs() -> [OpID] { elements.filter { !$0.deleted }.map(\.id) }

    private mutating func nextID() -> OpID { clock += 1; return OpID(clock, replica) }

    public mutating func insert(_ text: String, at offset: Int) {
        let vis = visibleIDs()
        var after: OpID? = offset == 0 ? nil : vis[offset - 1]
        for ch in text {
            let id = nextID()
            apply(.insert(id: id, after: after, char: ch))
            after = id
        }
    }

    public mutating func delete(at offset: Int, count: Int) {
        let vis = visibleIDs()
        for target in vis[offset ..< offset + count] { apply(.delete(id: nextID(), target: target)) }
    }

    public mutating func mark(_ name: String, _ value: String?, from: Int, to: Int) {
        let vis = visibleIDs()
        guard from < to else { return }
        apply(.mark(id: nextID(), start: vis[from], end: vis[to - 1], name: name, value: value))
    }

    // MARK: Merge

    /// Übernimmt alle Ops des anderen Replikats (idempotent, kommutativ, Reihenfolge egal).
    public mutating func merge(_ other: RGAText) { for op in other.log { apply(op) } }

    public mutating func apply(_ ops: [TextOp]) { for op in ops { apply(op) } }

    public mutating func apply(_ op: TextOp) {
        guard !seen.contains(op.id) else { return }
        guard isReady(op) else { pending.append(op); return }
        integrate(op)
        // Gepufferte Ops nachziehen, die jetzt bereit sind.
        var progressed = true
        while progressed {
            progressed = false
            for (i, p) in pending.enumerated().reversed() where isReady(p) {
                pending.remove(at: i); if !seen.contains(p.id) { integrate(p) }; progressed = true
            }
        }
    }

    private func isReady(_ op: TextOp) -> Bool {
        switch op {
        case .insert(_, let after, _): return after.map { index[$0] != nil } ?? true
        case .delete(_, let target): return index[target] != nil
        case .mark(_, let s, let e, _, _): return index[s] != nil && index[e] != nil
        }
    }

    private mutating func integrate(_ op: TextOp) {
        seen.insert(op.id); log.append(op)
        clock = max(clock, op.id.counter)
        switch op {
        case .insert(let id, let after, let ch):
            // RGA: rechts vom Vorgänger einfügen, dabei alle Nachfolger-Teilbäume mit größerer ID überspringen.
            var pos = after.map { index[$0]! + 1 } ?? 0
            while pos < elements.count {
                let e = elements[pos]
                if e.after == after && e.id > id { pos = skipSubtree(from: pos); continue }
                if e.after != after && isDescendant(e, of: after) { pos += 1; continue }
                break
            }
            elements.insert(Element(id: id, after: after, char: ch, deleted: false), at: pos)
            for i in pos ..< elements.count { index[elements[i].id] = i }
        case .delete(_, let target):
            elements[index[target]!].deleted = true
        case .mark:
            marks.append(op)
        }
    }

    /// Position hinter dem Teilbaum, der bei `pos` beginnt.
    private func skipSubtree(from pos: Int) -> Int {
        var inTree: Set<OpID> = [elements[pos].id]
        var p = pos + 1
        while p < elements.count, let a = elements[p].after, inTree.contains(a) { inTree.insert(elements[p].id); p += 1 }
        return p
    }

    private func isDescendant(_ e: Element, of root: OpID?) -> Bool {
        var cur = e.after
        while let c = cur {
            if c == root { return true }
            guard let i = index[c] else { return false }
            if elements[i].id == root { return true }
            cur = elements[i].after
            if let r = root, c < r { return false } // Vorgänger sind älter als ihre Nachfolger
        }
        return root == nil
    }

    // MARK: Formatierung auflösen

    /// Sichtbarer Text als formatierte Abschnitte. Pro Zeichen und Mark-Name gewinnt die Op mit der größten ID,
    /// deren Bereich (in aktueller Reihenfolge, Grenzen inklusive) das Zeichen enthält.
    public var spans: [Span] {
        var winners = [[String: (OpID, String?)]](repeating: [:], count: elements.count)
        for case .mark(let id, let s, let e, let name, let value) in marks {
            guard let a = index[s], let b = index[e], a <= b else { continue }
            for i in a ... b where (winners[i][name]?.0 ?? OpID(0, 0)) < id { winners[i][name] = (id, value) }
        }
        var out: [Span] = []
        for (i, el) in elements.enumerated() where !el.deleted {
            var m: [String: String] = [:]
            for (k, v) in winners[i] { if let s = v.1 { m[k] = s } }
            if var last = out.last, last.marks == m { last.text.append(el.char); out[out.count - 1] = last }
            else { out.append(Span(text: String(el.char), marks: m)) }
        }
        return out
    }

    /// Anzahl gespeicherter Elemente inkl. Tombstones (für die Speicherabschätzung).
    public var storedElements: Int { elements.count }
}
