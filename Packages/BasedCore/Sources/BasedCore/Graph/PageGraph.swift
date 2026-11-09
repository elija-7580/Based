import Foundation

/// Pages and how they are connected — the data behind the graph view (workspace graph, family trees, org charts).
/// Only pages are nodes (pages, database rows, full-page databases). Edges come from the page hierarchy, every
/// relation property (one edge kind per property) and page mentions / links inside a page's content.
public struct PageGraph: Codable, Sendable {
    public struct Node: Codable, Sendable {
        public var id: RecordID
        /// Title.
        public var t: String
        /// Emoji icon ("" if none or not an emoji).
        public var i: String
        /// Database the page is a row of ("" otherwise).
        public var db: String
        /// Property values usable for colour / size / sort: option id, number, date (seconds since 1970), 0/1.
        public var v: [String: GraphValue]
        /// Last edited (seconds since 1970), so the graph can colour by age without a property.
        public var e: Double
    }

    public struct Edge: Codable, Sendable {
        /// Source and target page.
        public var s: RecordID
        public var t: RecordID
        /// Edge kind id: "child" (s is the parent page of t), "mention" (s mentions / links t),
        /// or "rel:<databaseID>:<propertyID>" (row s has t in that relation property).
        public var k: String
    }

    public struct EdgeKind: Codable, Sendable {
        public var id: String
        public var name: String
        /// Relation properties only: the kind of the synced property on the other side (a two-way relation).
        public var inverse: String?
    }

    public struct Option: Codable, Sendable { public var id: String; public var name: String; public var color: String }
    public struct Property: Codable, Sendable {
        public var id: String
        public var name: String
        public var type: String
        public var options: [Option]
    }
    public struct DatabaseInfo: Codable, Sendable {
        public var id: RecordID
        public var name: String
        public var props: [Property]
    }

    public var nodes: [Node]
    public var edges: [Edge]
    public var kinds: [EdgeKind]
    public var databases: [DatabaseInfo]
}

/// A property value reduced to what the graph can colour, size or sort by.
public enum GraphValue: Codable, Sendable, Hashable {
    case number(Double)
    case text(String)

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let d = try? c.decode(Double.self) { self = .number(d) } else { self = .text(try c.decode(String.self)) }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .number(let d): try c.encode(d)
        case .text(let s): try c.encode(s)
        }
    }
}

public extension WorkspaceStore {
    /// Builds the graph of all live pages. Cheap enough to run on every workspace change (one pass over the blocks).
    func pageGraph() -> PageGraph {
        var trashCache: [RecordID: Bool] = [:]
        func trashed(_ id: RecordID) -> Bool {
            if let v = trashCache[id] { return v }
            let v = isTrashed(id); trashCache[id] = v; return v
        }

        // Nodes: pages, database rows and full-page databases.
        var nodes: [PageGraph.Node] = []
        var isNode = Set<RecordID>()
        for b in blocks.values where b.type == .page || b.type == .databasePage {
            if trashed(b.id) { continue }
            isNode.insert(b.id)
        }

        // Nearest page ancestor of any block (memoised), used for hierarchy and for mentions inside content.
        var pageOf: [RecordID: RecordID?] = [:]
        func owningPage(_ id: RecordID) -> RecordID? {
            if let v = pageOf[id] { return v }
            var chain: [RecordID] = []
            var cur: RecordID? = id
            var result: RecordID?
            var n = 0
            while let c = cur, n < 500 {
                n += 1
                // A page owns its content: check that before the memo (which holds the page's *own* owner).
                if c != id, isNode.contains(c) { result = c; break }
                if let v = pageOf[c] { result = v; break }
                chain.append(c)
                guard let b = blocks[c] else { break }
                switch b.parent {
                case .workspace: cur = nil
                case .block(let p): cur = p
                case .database(let d): cur = databases[d]?.blockID
                }
            }
            for c in chain { pageOf[c] = result }
            return result
        }

        var edges: [PageGraph.Edge] = []
        var kinds: [String: PageGraph.EdgeKind] = [
            "child": .init(id: "child", name: "Unterseite", inverse: nil),
            "mention": .init(id: "mention", name: "Erwähnung / Link", inverse: nil),
        ]
        var seenMention = Set<String>()

        for id in isNode {
            guard let b = blocks[id] else { continue }
            var values: [String: GraphValue] = [:]
            var dbID = ""
            if case .database(let did) = b.parent, let db = databases[did] {
                dbID = did
                for p in db.properties {
                    guard let val = b.values[p.id] else { continue }
                    switch val {
                    case .select(let o), .status(let o): values[p.id] = .text(o)
                    case .multiSelect(let os): if let o = os.first { values[p.id] = .text(o) }
                    case .number(let d): values[p.id] = .number(d)
                    case .date(let d): values[p.id] = .number(d.start.timeIntervalSince1970)
                    case .checkbox(let c): values[p.id] = .number(c ? 1 : 0)
                    case .person(let ps): if let u = ps.first { values[p.id] = .text(u) }
                    case .uniqueID(let n): values[p.id] = .number(Double(n))
                    case .relation(let targets):
                        let kind = "rel:\(did):\(p.id)"
                        for t in targets where isNode.contains(t) && t != id { edges.append(.init(s: id, t: t, k: kind)) }
                    default: break
                    }
                }
            }
            if let parent = owningPage(id) { edges.append(.init(s: parent, t: id, k: "child")) }
            let icon: String = { if case .emoji(let e)? = b.props.icon { return e }; return "" }()
            nodes.append(.init(id: id, t: title(of: id), i: icon, db: dbID, v: values, e: b.updatedAt.timeIntervalSince1970))
        }

        // Mentions and page links inside content: from the page that contains the block to the mentioned page.
        for b in blocks.values {
            var targets: [RecordID] = []
            for r in b.text.runs { if case .page(let t)? = r.mention { targets.append(t) } }
            if b.type == .linkToPage, let t = b.props.linkTarget { targets.append(t) }
            guard !targets.isEmpty, let from = owningPage(b.id) ?? (isNode.contains(b.id) ? b.id : nil) else { continue }
            for t in targets where isNode.contains(t) && t != from && seenMention.insert(from + ">" + t).inserted {
                edges.append(.init(s: from, t: t, k: "mention"))
            }
        }

        // Databases and their relation properties (edge kinds, with the synced counterpart for two-way relations).
        var infos: [PageGraph.DatabaseInfo] = []
        for db in databases.values {
            guard !trashed(db.blockID) else { continue }
            let dbName = db.title.plainText.isEmpty ? "Untitled" : db.title.plainText
            var props: [PageGraph.Property] = []
            for p in db.properties {
                if p.type == .relation {
                    let kind = "rel:\(db.id):\(p.id)"
                    var inverse: String?
                    if let r = p.relation, let synced = r.syncedPropertyID { inverse = "rel:\(r.databaseID):\(synced)" }
                    kinds[kind] = .init(id: kind, name: "\(p.name) (\(dbName))", inverse: inverse)
                }
                let usable: [PropertyType] = [.select, .status, .multiSelect, .number, .date, .checkbox, .person, .uniqueID]
                guard usable.contains(p.type) else { continue }
                props.append(.init(id: p.id, name: p.name, type: p.type.rawValue,
                                   options: (p.options ?? []).map { .init(id: $0.id, name: $0.name, color: $0.color.rawValue) }))
            }
            infos.append(.init(id: db.id, name: dbName, props: props))
        }

        return PageGraph(nodes: nodes, edges: edges, kinds: Array(kinds.values).sorted { $0.name < $1.name },
                         databases: infos.sorted { $0.name < $1.name })
    }
}
