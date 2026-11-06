import Foundation

/// Stable record ids for imported content, so importing the same Notion page twice updates it in place.
public enum ImportIDs {
    static let hex = Set("0123456789abcdef")

    /// Notion ids (32 hex digits, with or without dashes) → canonical lowercase dashed UUID.
    public static func notion(_ raw: String) -> RecordID? {
        let h = raw.lowercased().filter { $0 != "-" }
        guard h.count == 32, h.allSatisfy({ hex.contains($0) }) else { return nil }
        let c = Array(h)
        return String(c[0..<8]) + "-" + String(c[8..<12]) + "-" + String(c[12..<16]) + "-" + String(c[16..<20]) + "-" + String(c[20..<32])
    }

    /// The last Notion id inside a file name, URL or path ("Project Plan 1a2b….html", "…/Title-1a2b…?v=…").
    public static func notionID(inName name: String) -> RecordID? {
        var s = name
        if let q = s.firstIndex(where: { $0 == "?" || $0 == "#" }) { s = String(s[..<q]) }
        s = s.removingPercentEncoding ?? s
        // dashed UUID anywhere
        if let r = s.range(of: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}", options: [.regularExpression, .backwards]) {
            return notion(String(s[r]))
        }
        let chars = Array(s.lowercased())
        var best: RecordID?
        var i = 0
        while i < chars.count {
            if hex.contains(chars[i]) {
                var j = i
                while j < chars.count, hex.contains(chars[j]) { j += 1 }
                if j - i == 32 { best = notion(String(chars[i..<j])) }
                i = j
            } else { i += 1 }
        }
        return best
    }

    /// Deterministic UUID derived from strings (FNV-1a, 128 bit), for records that have no id in the source.
    public static func derived(_ parts: String...) -> RecordID { derived(parts) }

    public static func derived(_ parts: [String]) -> RecordID {
        var a: UInt64 = 0xcbf29ce484222325, b: UInt64 = 0x84222325cbf29ce4
        for (n, p) in parts.enumerated() {
            for byte in (p + (n < parts.count - 1 ? "\u{1F}" : "")).utf8 {
                a = (a ^ UInt64(byte)) &* 0x100000001b3
                b = (b ^ UInt64(byte)) &* 0x100000001b3 &+ 0x9e3779b97f4a7c15
            }
        }
        var bytes = [UInt8](repeating: 0, count: 16)
        for k in 0..<8 { bytes[k] = UInt8((a >> (UInt64(k) * 8)) & 0xff); bytes[8 + k] = UInt8((b >> (UInt64(k) * 8)) & 0xff) }
        bytes[6] = (bytes[6] & 0x0f) | 0x50   // version 5 style
        bytes[8] = (bytes[8] & 0x3f) | 0x80   // RFC 4122 variant
        let h = bytes.map { String(format: "%02x", $0) }.joined()
        return notion(h)!
    }
}

/// Collects an imported subtree (blocks, databases, views, assets) off the main thread; `WorkspaceStore.commitImport`
/// writes it in one transaction. Records keep their source ids, so a re-import updates existing records in place.
public final class ImportBuilder: @unchecked Sendable {
    public private(set) var blocks: [Block] = []
    private var index: [RecordID: Int] = [:]
    public private(set) var databases: [Database] = []
    private var dbIndex: [RecordID: Int] = [:]
    public private(set) var views: [DatabaseView] = []
    private var viewIndex: [RecordID: Int] = [:]
    /// Top-level records, in order. Their parent is decided when committing.
    public private(set) var roots: [RecordID] = []
    public var warnings: [String] = []
    public var notes: [String] = []
    /// Containers whose complete content is part of this import (stale children are removed on re-import).
    public private(set) var complete: Set<String> = []
    private var lastKey: [String: String] = [:]
    /// Placeholder asset id → local file to copy into the asset store.
    public private(set) var pendingAssets: [String: (url: URL, name: String, mime: String?)] = [:]
    private var assetByPath: [String: AssetRef] = [:]
    /// Files copied into the asset store by `resolveAssets`.
    public private(set) var storedAssets = 0
    public var createdBy: String?

    public init(createdBy: String? = "me") { self.createdBy = createdBy }

    public var isEmpty: Bool { blocks.isEmpty && databases.isEmpty }

    // MARK: Blocks

    public func contains(_ id: RecordID) -> Bool { index[id] != nil }
    public func block(_ id: RecordID) -> Block? { index[id].map { blocks[$0] } }

    public func update(_ id: RecordID, _ f: (inout Block) -> Void) {
        guard let i = index[id] else { return }
        f(&blocks[i])
    }

    /// Adds a block after its previous siblings. `root` blocks are placed by `commitImport`.
    /// A block added twice (same id) replaces the earlier copy but keeps its position.
    @discardableResult
    public func add(_ block: Block, root: Bool = false) -> RecordID {
        var b = block
        if b.createdBy == nil { b.createdBy = createdBy; b.updatedBy = b.updatedBy ?? createdBy }
        if let i = index[b.id] {
            if b.parent == blocks[i].parent || root { b.sortKey = blocks[i].sortKey }
            else if b.sortKey.isEmpty {
                let k = FractionalIndex.between(lastKey[b.parent.key], nil)
                lastKey[b.parent.key] = k
                b.sortKey = k
            }
            blocks[i] = b
            return b.id
        }
        if root {
            if !roots.contains(b.id) { roots.append(b.id) }
            if b.sortKey.isEmpty { b.sortKey = FractionalIndex.first }
        } else if b.sortKey.isEmpty {
            let k = FractionalIndex.between(lastKey[b.parent.key], nil)
            lastKey[b.parent.key] = k
            b.sortKey = k
        }
        index[b.id] = blocks.count
        blocks.append(b)
        return b.id
    }

    /// Convenience: append a new block of `type` under `parent`.
    @discardableResult
    public func append(_ type: BlockType, in parent: ParentRef, id: RecordID? = nil, text: RichText = RichText(),
                       props: BlockProps = BlockProps(), values: [String: PropertyValue] = [:], createdAt: Date? = nil) -> RecordID {
        var b = Block(id: id ?? RecordIDs.make(), type: type, parent: parent, sortKey: "", text: text, props: props, values: values,
                      createdAt: createdAt ?? Date(), createdBy: createdBy)
        if let createdAt { b.updatedAt = createdAt }
        return add(b)
    }

    /// Imported block trees (e.g. from the Markdown parser).
    public func add(_ items: [ImportedBlock], in parent: ParentRef) {
        for item in items {
            var p = item.props
            if item.type == .table, p.tableColumns == nil { p.tableColumns = 2 }
            let id = append(item.type, in: parent, id: item.id, text: item.text, props: p)
            add(item.children, in: .block(id))
        }
    }

    /// Mark a container (page, block or database) as fully imported.
    public func markComplete(_ parent: ParentRef) { complete.insert(parent.key) }

    /// Moves a block to the end of another parent (used when a child page is discovered after its link).
    public func reparent(_ id: RecordID, to parent: ParentRef) {
        guard let i = index[id] else { return }
        let k = FractionalIndex.between(lastKey[parent.key], nil)
        lastKey[parent.key] = k
        blocks[i].parent = parent
        blocks[i].sortKey = k
        roots.removeAll { $0 == id }
    }

    // MARK: Databases & views

    public func database(_ id: RecordID) -> Database? { dbIndex[id].map { databases[$0] } }

    public func addDatabase(_ d: Database) {
        if let i = dbIndex[d.id] { databases[i] = d; return }
        dbIndex[d.id] = databases.count
        databases.append(d)
    }

    public func updateDatabase(_ id: RecordID, _ f: (inout Database) -> Void) {
        guard let i = dbIndex[id] else { return }
        f(&databases[i])
    }

    public func view(_ id: RecordID) -> DatabaseView? { viewIndex[id].map { views[$0] } }

    public func addView(_ v: DatabaseView) {
        if let i = viewIndex[v.id] { views[i] = v; return }
        viewIndex[v.id] = views.count
        views.append(v)
    }

    public func views(forBlock id: RecordID) -> [DatabaseView] { views.filter { $0.blockID == id && $0.widgetOf == nil } }

    // MARK: Assets

    /// A placeholder reference for a local file; `resolveAssets` copies it into the asset store.
    public func asset(file url: URL, name: String? = nil, mime: String? = nil) -> AssetRef {
        let key = url.standardizedFileURL.path
        if let a = assetByPath[key] { return a }
        let n = name ?? url.lastPathComponent
        let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? nil
        let ref = AssetRef(id: "pending-" + RecordIDs.make(), name: n, size: size, mime: mime ?? FileAssetStore.mime(for: url.pathExtension))
        pendingAssets[ref.id] = (url, n, ref.mime)
        assetByPath[key] = ref
        return ref
    }

    /// Copies pending files into the asset store and rewrites every reference. Returns the number of stored files.
    @discardableResult
    public func resolveAssets(_ store: AssetStore?) -> Int {
        guard !pendingAssets.isEmpty else { return 0 }
        var map: [String: AssetRef] = [:]
        if let store {
            for (id, f) in pendingAssets {
                if let data = try? Data(contentsOf: f.url), let ref = try? store.importData(data, name: f.name, mime: f.mime) { map[id] = ref }
                else { warnings.append("Couldn't copy file \(f.name)") }
            }
        }
        func fix(_ a: AssetRef?) -> AssetRef? {
            guard let a, a.id.hasPrefix("pending-") else { return a }
            return map[a.id]
        }
        for i in blocks.indices {
            var p = blocks[i].props
            if let a = p.asset, a.id.hasPrefix("pending-") {
                p.asset = fix(a)
                if p.asset == nil, p.url == nil, let f = pendingAssets[a.id] { p.url = f.url.absoluteString }
            }
            if case .asset(let a)? = p.icon { p.icon = fix(a).map(PageIcon.asset) }
            if case .asset(let a)? = p.cover { p.cover = fix(a).map(PageCover.asset) }
            blocks[i].props = p
            for (k, v) in blocks[i].values {
                if case .files(let files) = v, files.contains(where: { $0.asset?.id.hasPrefix("pending-") == true }) {
                    blocks[i].values[k] = .files(files.map { f in
                        var f = f
                        if let a = f.asset, a.id.hasPrefix("pending-") { f.asset = map[a.id] }
                        return f
                    })
                }
            }
        }
        pendingAssets = [:]
        assetByPath = [:]
        storedAssets += map.count
        return map.count
    }

    // MARK: Report

    public func report() -> ImportReport {
        var r = ImportReport()
        let dbIDs = Set(databases.map(\.id))
        for b in blocks where b.type == .page {
            if case .database(let d) = b.parent, dbIDs.contains(d) { r.rows += 1 } else { r.pages += 1 }
        }
        r.databases = databases.count
        r.warnings = notes + warnings
        r.rootIDs = roots
        return r
    }
}

@MainActor
public extension WorkspaceStore {
    /// Writes an `ImportBuilder` in one undoable transaction. Records that already exist (same id, e.g. a second
    /// import of the same Notion page) are updated in place; their stale content is removed, stale pages and rows
    /// move to the trash. New top-level records are appended to `parent`.
    @discardableResult
    func commitImport(_ builder: ImportBuilder, into parent: ParentRef = .workspace, name: String = "Import") -> ImportReport {
        var report = builder.report()
        let roots = Set(builder.roots)
        let importedIDs = Set(builder.blocks.map(\.id))
        var reimported = 0
        transact(name) { tx in
            tx.preserveTimestamps = true
            let now = Date()
            var rootKey: String? = children(of: parent).last.flatMap { blocks[$0]?.sortKey }
            var newRoots: [RecordID] = []
            // Databases first so blocks can point at them.
            for d in builder.databases {
                var d = d
                if let old = databases[d.id] {
                    d.templateIDs = old.templateIDs ?? d.templateIDs
                    d.defaultTemplateID = old.defaultTemplateID ?? d.defaultTemplateID
                    d.createdAt = old.createdAt
                }
                tx.put(d)
            }
            for var b in builder.blocks {
                let existing = blocks[b.id]
                if existing != nil { reimported += 1 }
                if roots.contains(b.id) {
                    if let e = existing, e.trashedAt == nil, parentExists(e.parent) {
                        b.parent = e.parent; b.sortKey = e.sortKey
                    } else {
                        b.parent = parent
                        let k = FractionalIndex.between(rootKey, nil)
                        rootKey = k
                        b.sortKey = k
                        newRoots.append(b.id)
                    }
                }
                if b.createdBy == nil { b.createdBy = userID }
                if b.updatedBy == nil { b.updatedBy = b.createdBy }
                b.trashedAt = nil
                tx.put(b)
            }
            // Re-import: drop content that disappeared from the source.
            if reimported > 0 {
                for key in builder.complete {
                    guard let p = ParentRef(key: key) else { continue }
                    for cid in children(of: p) where !importedIDs.contains(cid) {
                        guard let c = blocks[cid], c.trashedAt == nil else { continue }
                        if c.type.isPageLike || p.isDatabase { tx.update(cid) { $0.trashedAt = now } }
                        else { removeSubtree(cid, tx: tx) }
                    }
                }
                // Views of re-imported database blocks that no longer exist in the source.
                let builderViews = Set(builder.views.map(\.id))
                for b in builder.blocks where b.type == .databaseInline || b.type == .databasePage {
                    for v in viewIDs(forBlock: b.id) where !builderViews.contains(v) { tx.remove(RecordKey(.view, v)) }
                }
            }
            for v in builder.views { tx.put(v) }
            // Databases whose container now points at another database record (e.g. HTML → API re-import).
            for b in builder.blocks {
                guard let old = tx.before[RecordKey(.block, b.id)]?.value, case .block(let ob) = old,
                      let oldDB = ob.props.databaseID, oldDB != b.props.databaseID,
                      let d = databases[oldDB], d.blockID == b.id else { continue }
                for r in children(of: .database(oldDB)) where !importedIDs.contains(r) { removeSubtree(r, tx: tx) }
                for v in views.values where v.databaseID == oldDB && v.blockID == b.id { tx.remove(RecordKey(.view, v.id)) }
                tx.remove(RecordKey(.database, oldDB))
            }
            report.rootIDs = builder.roots
            _ = newRoots
        }
        if reimported > 0 { report.warnings.insert("Updated \(reimported) existing blocks from an earlier import.", at: 0) }
        return report
    }
}

extension WorkspaceStore {
    func parentExists(_ p: ParentRef) -> Bool {
        switch p {
        case .workspace: return true
        case .block(let id): return blocks[id].map { $0.trashedAt == nil } ?? false
        case .database(let id): return databases[id] != nil
        }
    }
}

extension ParentRef {
    var isDatabase: Bool { if case .database = self { return true } else { return false } }
}
