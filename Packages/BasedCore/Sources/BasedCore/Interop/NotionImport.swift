import Foundation

public struct ImportReport: Sendable {
    public var pages = 0
    public var databases = 0
    public var rows = 0
    public var assets = 0
    public var warnings: [String] = []
    public var rootIDs: [RecordID] = []
}

/// Imports a Notion "Markdown & CSV" export (unzipped folder), single .md files or .csv files.
@MainActor
public final class NotionImporter {
    public let store: WorkspaceStore
    public let assets: AssetStore?
    private var ids: [String: RecordID] = [:]   // standardized file path → record id
    private var consumed: Set<String> = []
    private var report = ImportReport()

    public init(store: WorkspaceStore, assets: AssetStore?) {
        self.store = store
        self.assets = assets
    }

    static let hexSuffix = try! NSRegularExpression(pattern: "\\s+([0-9a-f]{32})$", options: [.caseInsensitive])

    /// "Project Plan 1a2b…(32 hex)" → "Project Plan"
    public static func cleanTitle(_ name: String) -> String {
        var base = name
        for ext in [".md", ".csv"] where base.lowercased().hasSuffix(ext) { base = String(base.dropLast(ext.count)) }
        if base.hasSuffix("_all") { base = String(base.dropLast(4)) }
        let r = NSRange(base.startIndex..., in: base)
        return hexSuffix.stringByReplacingMatches(in: base, range: r, withTemplate: "").trimmingCharacters(in: .whitespaces)
    }

    static func key(_ url: URL) -> String { url.standardizedFileURL.path }

    public func importItems(_ urls: [URL], into parent: ParentRef = .workspace) throws -> ImportReport {
        report = ImportReport()
        ids = [:]; consumed = []
        for u in urls { assignIDs(u) }
        store.transact("Import") { tx in
            var key: String? = store.children(of: parent).last.flatMap { store.blocks[$0]?.sortKey }
            for u in urls {
                let k = FractionalIndex.between(key, nil)
                key = k
                if let id = importItem(u, parent: parent, sortKey: k, tx: tx) { report.rootIDs.append(id) }
            }
        }
        return report
    }

    // MARK: Pass 1 — ids for link resolution

    private func assignIDs(_ url: URL) {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return }
        if isDir.boolValue {
            for c in (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? [] { assignIDs(c) }
        } else if ["md", "csv"].contains(url.pathExtension.lowercased()) {
            ids[Self.key(url)] = RecordIDs.make()
        }
    }

    private func resolver(relativeTo dir: URL) -> (String) -> RecordID? {
        { [ids] target in
            guard !target.contains("://"), let decoded = target.removingPercentEncoding else { return nil }
            let u = dir.appendingPathComponent(decoded)
            if let id = ids[Self.key(u)] { return id }
            // CSV links in newer exports point to "X.csv" while rows live in "X_all.csv"
            if u.pathExtension == "csv" {
                let all = u.deletingPathExtension().appendingPathExtension("csv")
                return ids[Self.key(all.deletingLastPathComponent().appendingPathComponent(all.deletingPathExtension().lastPathComponent + "_all.csv"))]
            }
            return nil
        }
    }

    // MARK: Pass 2 — content

    private func importItem(_ url: URL, parent: ParentRef, sortKey: String, tx: Tx) -> RecordID? {
        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) else { return nil }
        if isDir.boolValue {
            // A bare export folder: import its top-level items under `parent`.
            let items = topLevelItems(in: url)
            var key: String? = sortKey
            var first: RecordID?
            for item in items {
                let k = first == nil ? sortKey : FractionalIndex.between(key, nil)
                key = k
                if let id = importItem(item, parent: parent, sortKey: k, tx: tx), first == nil { first = id }
            }
            return first
        }
        switch url.pathExtension.lowercased() {
        case "md", "markdown", "txt": return importPage(url, parent: parent, sortKey: sortKey, tx: tx)
        case "csv": return importDatabase(url, parent: parent, sortKey: sortKey, inline: false, tx: tx)
        default:
            report.warnings.append("Skipped \(url.lastPathComponent)")
            return nil
        }
    }

    /// .md and .csv files of a folder (preferring "X_all.csv" over "X.csv").
    private func topLevelItems(in dir: URL) -> [URL] {
        let all = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
        var out: [URL] = []
        let names = Set(all.map(\.lastPathComponent))
        for u in all {
            let ext = u.pathExtension.lowercased()
            if ext == "md" { out.append(u) }
            if ext == "csv" {
                let base = u.deletingPathExtension().lastPathComponent
                if !base.hasSuffix("_all") && names.contains(base + "_all.csv") { continue }
                out.append(u)
            }
        }
        // Folders without a matching page file (e.g. the export root folder)
        for u in all where (try? u.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            let n = u.lastPathComponent
            if !names.contains(n + ".md") && !names.contains(n + ".csv") && !names.contains(n + "_all.csv") && !Self.isAssetFolder(u) {
                out.append(u)
            }
        }
        return out
    }

    static func isAssetFolder(_ u: URL) -> Bool {
        let files = (try? FileManager.default.contentsOfDirectory(at: u, includingPropertiesForKeys: nil)) ?? []
        return !files.isEmpty && files.allSatisfy { !["md", "csv"].contains($0.pathExtension.lowercased()) && !$0.hasDirectoryPath }
    }

    private func childFolder(for file: URL) -> URL? {
        var base = file.deletingPathExtension().lastPathComponent
        if base.hasSuffix("_all") { base = String(base.dropLast(4)) }
        let dir = file.deletingLastPathComponent().appendingPathComponent(base, isDirectory: true)
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir) && isDir.boolValue ? dir : nil
    }

    @discardableResult
    private func importPage(_ url: URL, parent: ParentRef, sortKey: String, tx: Tx,
                            values: [String: PropertyValue] = [:], db: Database? = nil) -> RecordID? {
        let key = Self.key(url)
        guard !consumed.contains(key), let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        consumed.insert(key)
        let id = ids[key] ?? RecordIDs.make()
        let dir = url.deletingLastPathComponent()
        var (title, body) = MarkdownImporter.splitTitle(raw)
        if db != nil { body = stripPropertyLines(body, db: db!) }
        let importer = MarkdownImporter(resolveLink: resolver(relativeTo: dir), resolveAsset: { [weak self] src in
            self?.asset(src, relativeTo: dir) ?? (src, nil)
        })
        var page = Block(id: id, type: .page, parent: parent, sortKey: sortKey,
                         text: RichText(title ?? Self.cleanTitle(url.lastPathComponent)), values: values, createdBy: store.userID)
        if let (emoji, rest) = Self.leadingEmoji(page.text.plainText), db == nil, !rest.isEmpty {
            page.props.icon = .emoji(emoji); page.text = RichText(rest)
        }
        tx.put(page)
        report.pages += 1
        if db != nil { report.rows += 1 }

        var blocks = importer.parse(body)
        let folder = childFolder(for: url)
        // Lone links to files in the child folder become the subpages themselves, in place.
        let keys = FractionalIndex.keys(count: blocks.count, between: nil, nil)
        var lastKey: String?
        for (b, k) in zip(blocks, keys) {
            lastKey = k
            if let target = b.linkTarget, let decoded = target.removingPercentEncoding, !target.contains("://") {
                let u = dir.appendingPathComponent(decoded)
                let ext = u.pathExtension.lowercased()
                if ext == "md", FileManager.default.fileExists(atPath: u.path), !consumed.contains(Self.key(u)) {
                    importPage(u, parent: .block(id), sortKey: k, tx: tx); continue
                }
                if ext == "csv" {
                    let allURL = u.deletingLastPathComponent().appendingPathComponent(u.deletingPathExtension().lastPathComponent + "_all.csv")
                    let pick = FileManager.default.fileExists(atPath: allURL.path) ? allURL : u
                    if FileManager.default.fileExists(atPath: pick.path), !consumed.contains(Self.key(pick)) {
                        importDatabase(pick, parent: .block(id), sortKey: k, inline: true, tx: tx); continue
                    }
                }
            }
            store.putImported(b, parent: .block(id), sortKey: k, tx: tx)
        }
        blocks.removeAll()
        // Remaining children in the folder (not linked from the content).
        if let folder {
            for item in topLevelItems(in: folder) where !consumed.contains(Self.key(item)) {
                let k = FractionalIndex.between(lastKey, nil)
                lastKey = k
                var isDir: ObjCBool = false
                FileManager.default.fileExists(atPath: item.path, isDirectory: &isDir)
                if isDir.boolValue { continue }
                if item.pathExtension.lowercased() == "csv" {
                    importDatabase(item, parent: .block(id), sortKey: k, inline: false, tx: tx)
                } else {
                    importPage(item, parent: .block(id), sortKey: k, tx: tx)
                }
            }
        }
        return id
    }

    static func leadingEmoji(_ s: String) -> (String, String)? {
        guard let c = s.first, c.unicodeScalars.first.map({ $0.properties.isEmojiPresentation }) == true else { return nil }
        return (String(c), String(s.dropFirst()).trimmingCharacters(in: .whitespaces))
    }

    /// Row pages repeat their properties as "Name: value" lines below the title.
    private func stripPropertyLines(_ body: String, db: Database) -> String {
        var lines = body.components(separatedBy: "\n")
        while let f = lines.first, f.trimmingCharacters(in: .whitespaces).isEmpty { lines.removeFirst() }
        var n = 0
        for l in lines {
            guard let colon = l.range(of: ": ") else { break }
            let name = String(l[..<colon.lowerBound])
            guard db.property(named: name) != nil else { break }
            n += 1
        }
        return lines.dropFirst(n).joined(separator: "\n")
    }

    private func asset(_ src: String, relativeTo dir: URL) -> (url: String?, asset: AssetRef?) {
        if src.contains("://") { return (src, nil) }
        let u = dir.appendingPathComponent(src)
        guard let assets, FileManager.default.fileExists(atPath: u.path), let ref = try? assets.importFile(at: u) else { return (src, nil) }
        report.assets += 1
        return (nil, ref)
    }

    // MARK: Databases

    @discardableResult
    private func importDatabase(_ url: URL, parent: ParentRef, sortKey: String, inline: Bool, tx: Tx) -> RecordID? {
        let key = Self.key(url)
        guard !consumed.contains(key), let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
        consumed.insert(key)
        // the sibling "X.csv" of "X_all.csv" is the same database
        if url.deletingPathExtension().lastPathComponent.hasSuffix("_all") {
            let plain = url.deletingLastPathComponent().appendingPathComponent(String(url.deletingPathExtension().lastPathComponent.dropLast(4)) + ".csv")
            consumed.insert(Self.key(plain))
        }
        let table = CSV.decode(raw)
        guard let header = table.first, !header.isEmpty else { return nil }
        let rows = Array(table.dropFirst())
        let blockID = ids[key] ?? RecordIDs.make()

        var props: [PropertySchema] = [PropertySchema(id: Database.titlePropertyID, name: header[0].isEmpty ? "Name" : header[0], type: .title)]
        for (ci, name) in header.enumerated().dropFirst() {
            let column = rows.map { ci < $0.count ? $0[ci] : "" }
            var p = PropertySchema(name: name.isEmpty ? "Column \(ci)" : name, type: Self.inferType(name: name, column))
            if p.type == .select || p.type == .multiSelect || p.type == .status {
                var options: [SelectOption] = []
                let palette = TColor.textColors.filter { $0 != .default }
                for v in column {
                    for token in (p.type == .multiSelect ? v.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } : [v.trimmingCharacters(in: .whitespaces)])
                    where !token.isEmpty && !options.contains(where: { $0.name == token }) {
                        options.append(SelectOption(name: token, color: palette[options.count % palette.count]))
                    }
                }
                p.options = options
                if p.type == .status { p.statusGroups = [StatusGroup(name: "To-do", color: .gray, optionIDs: options.map(\.id))] }
            }
            props.append(p)
        }
        let title = Self.cleanTitle(url.lastPathComponent)
        let db = Database(blockID: blockID, title: RichText(title), properties: props)
        tx.put(db)
        let view = DatabaseView(databaseID: db.id, blockID: blockID, name: "Table", type: .table, sortKey: FractionalIndex.between(nil, nil))
        tx.put(view)
        var bp = BlockProps(); bp.databaseID = db.id; bp.viewIDs = [view.id]
        tx.put(Block(id: blockID, type: inline ? .databaseInline : .databasePage, parent: parent, sortKey: sortKey, props: bp, createdBy: store.userID))
        report.databases += 1

        // Row pages with content live in the folder next to the CSV.
        var rowFiles: [String: [URL]] = [:]
        if let folder = childFolder(for: url) {
            for f in (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
            where f.pathExtension.lowercased() == "md" {
                rowFiles[Self.cleanTitle(f.lastPathComponent), default: []].append(f)
            }
        }
        let keys = FractionalIndex.keys(count: rows.count, between: nil, nil)
        for (r, k) in zip(rows, keys) {
            var values: [String: PropertyValue] = [:]
            for (ci, p) in props.enumerated().dropFirst() where ci < r.count {
                if let v = Self.parseValue(r[ci], p) { values[p.id] = v }
            }
            let rowTitle = r.first ?? ""
            if var files = rowFiles[MarkdownExporter.fileName(rowTitle)] ?? rowFiles[rowTitle], !files.isEmpty {
                let f = files.removeFirst()
                rowFiles[MarkdownExporter.fileName(rowTitle)] = files
                if importPage(f, parent: .database(db.id), sortKey: k, tx: tx, values: values, db: db) != nil { continue }
            }
            tx.put(Block(type: .page, parent: .database(db.id), sortKey: k, text: RichText(rowTitle), values: values, createdBy: store.userID))
            report.rows += 1
        }
        return blockID
    }

    /// Guess a property type from a CSV column.
    public static func inferType(name: String, _ column: [String]) -> PropertyType {
        let values = column.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let lname = name.lowercased()
        if lname == "status" { return .status }
        guard !values.isEmpty else { return .text }
        if values.allSatisfy({ $0 == "Yes" || $0 == "No" }) { return .checkbox }
        if values.allSatisfy({ Double($0.replacingOccurrences(of: ",", with: "")) != nil }) { return .number }
        if values.allSatisfy({ DateParsing.parse($0) != nil }) { return .date }
        if values.allSatisfy({ $0.hasPrefix("http://") || $0.hasPrefix("https://") }) { return .url }
        if values.allSatisfy({ $0.contains("@") && $0.contains(".") && !$0.contains(" ") }) { return .email }
        if values.contains(where: { $0.contains(".md)") }) { return .text }
        let tokens = values.flatMap { $0.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) } }
        let unique = Set(tokens)
        let short = tokens.allSatisfy { $0.count <= 40 }
        if short, values.contains(where: { $0.contains(", ") }), unique.count < tokens.count || lname.contains("tag") { return .multiSelect }
        if short, unique.count <= max(1, values.count / 2), values.count >= 2 { return .select }
        if lname.contains("tag") && short { return .multiSelect }
        return .text
    }

    static func parseValue(_ raw: String, _ p: PropertySchema) -> PropertyValue? {
        let s = raw.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty else { return p.type == .checkbox ? .checkbox(false) : nil }
        switch p.type {
        case .number: return Double(s.replacingOccurrences(of: ",", with: "")).map(PropertyValue.number)
        case .checkbox: return .checkbox(s == "Yes")
        case .date: return DateParsing.parse(s).map(PropertyValue.date)
        case .url: return .url(s)
        case .email: return .email(s)
        case .select: return p.option(named: s).map { .select($0.id) }
        case .status: return p.option(named: s).map { .status($0.id) }
        case .multiSelect:
            let ids = s.split(separator: ",").compactMap { p.option(named: $0.trimmingCharacters(in: .whitespaces))?.id }
            return ids.isEmpty ? nil : .multiSelect(ids)
        default: return .text(RichText(s))
        }
    }
}