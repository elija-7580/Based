import Foundation

/// Lossless, portable workspace archive: JSON Lines, one record per line in the same shape the sync protocol
/// uses (`{"kind": "block", "data": {…}}`, see docs/sync-protocol.md), plus a header line.
///
/// Everything survives the round trip — page tree and order, databases with properties, views, filters,
/// formulas, relations, page formatting, timestamps and stamps — so it serves as a backup, a move between
/// machines, and the import format for other clients (web, Windows, Linux).
///
/// Two containers (BSD-67):
/// - v1 `.based.jsonl`: the JSON Lines alone (header `"version": 1`). Still written by `write(_:)` and read.
/// - v2 `.based.zip`: `workspace.jsonl` (header `"version": 2`, `"assets": n`) plus every file the records
///   reference (images, attachments, icons, covers, meeting audio) as `assets/<asset id>/<name>`, so pictures
///   survive a move to another machine. Entries are stored, not compressed (media is compressed already).
public enum WorkspaceArchive {
    public static let format = "based-archive"
    /// Newest version this build reads (and writes into `.based.zip`).
    public static let version = 2
    /// Version of the plain JSON Lines file (`write(_:)`), unchanged so older builds keep reading it.
    public static let plainVersion = 1
    /// Name of the record file inside a `.based.zip`.
    public static let packageRecords = "workspace.jsonl"
    public static let packageExtension = "based.zip"

    public struct Header: Codable, Sendable, Equatable {
        public var format: String
        public var version: Int
        public var exportedAt: Date
        public var records: Int
        public var workspaceName: String?
        /// Asset files in the package (v2; nil in v1).
        public var assets: Int?
    }

    /// Writes the archive (header line + one line per record, workspace first, then by kind and id).
    @MainActor
    public static func write(_ store: WorkspaceStore) throws -> Data {
        try encode(store, version: plainVersion, assets: nil)
    }

    @MainActor
    static func encode(_ store: WorkspaceStore, version: Int, assets: Int?) throws -> Data {
        try encode(store.allRecords(), workspaceName: store.workspace.name, version: version, assets: assets)
    }

    static func encode(_ all: [Record], workspaceName: String, version: Int, assets: Int?) throws -> Data {
        let records = all.sorted { a, b in
            func rank(_ k: RecordKind) -> Int { k == .workspace ? 0 : k == .database ? 1 : k == .view ? 2 : 3 }
            return (rank(a.key.kind), a.key.id) < (rank(b.key.kind), b.key.id)
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        enc.dateEncodingStrategy = .iso8601
        var out = Data()
        let header = Header(format: format, version: version, exportedAt: Date(), records: records.count,
                            workspaceName: workspaceName.isEmpty ? nil : workspaceName, assets: assets)
        out.append(try enc.encode(header)); out.append(0x0A)
        for r in records {
            // Record payload in its own (storage) encoding, wrapped as {"kind": …, "data": …}.
            let payload = try r.encoded()
            out.append(contentsOf: Array(#"{"kind":""#.utf8))
            out.append(contentsOf: Array(r.key.kind.rawValue.utf8))
            out.append(contentsOf: Array(#"","data":"#.utf8))
            out.append(payload)
            out.append(contentsOf: Array("}\n".utf8))
        }
        return out
    }

    // MARK: Package (.based.zip, v2)

    /// A rendered `.based.zip`: the records plus where each referenced file lives on this device.
    public struct Package: Sendable {
        public struct Asset: Sendable, Equatable {
            public var ref: AssetRef
            /// Nil when the file isn't on this device (not downloaded yet) — reported, not fatal.
            public var source: URL?
        }
        public var records: Data
        public var recordCount: Int
        public var assets: [Asset]

        /// Writes the zip (records first, then the files). Throws only when the archive itself can't be written;
        /// missing files are listed in the result.
        public func write(to url: URL) throws -> PackageResult {
            var result = PackageResult(records: recordCount)
            let zip = try ZipWriter(url: url)
            do {
                try zip.add(path: packageRecords, data: records)
                for a in assets {
                    guard let src = a.source, let data = try? Data(contentsOf: src) else { result.missing.append(a.ref); continue }
                    try zip.add(path: WorkspaceArchive.entryPath(for: a.ref), data: data)
                    result.assets += 1
                    result.bytes += data.count
                }
                try zip.finish()
            } catch {
                try? FileManager.default.removeItem(at: url)  // no half-written archive left behind
                throw error
            }
            return result
        }
    }

    public struct PackageResult: Sendable, Equatable {
        public var records: Int
        public var assets = 0
        public var bytes = 0
        /// Referenced files that weren't on this device and are missing from the archive.
        public var missing: [AssetRef] = []
    }

    /// Renders the package on the main actor (reads the store); `Package.write(to:)` does the I/O anywhere.
    @MainActor
    public static func package(_ store: WorkspaceStore, assets: AssetStore?) throws -> Package {
        let records = store.allRecords()
        let refs = assetRefs(in: records)
        let data = try encode(records, workspaceName: store.workspace.name, version: version, assets: refs.count)
        return Package(records: data, recordCount: records.count,
                       assets: refs.map { Package.Asset(ref: $0, source: assets?.url(for: $0)) })
    }

    /// Every file the records point at (block files and images, page icons and covers, file properties, meeting
    /// audio): any `"asset": {"id", "name"}` in the stored JSON, also inside enum payloads (`{"_0": …}`).
    /// Unique by id, in record order.
    public static func assetRefs(in records: [Record]) -> [AssetRef] {
        var seen = Set<String>()
        var out: [AssetRef] = []
        func ref(_ v: Any) -> AssetRef? {
            guard let d = v as? [String: Any] else { return nil }
            if let id = d["id"] as? String, let name = d["name"] as? String, !id.isEmpty, !name.isEmpty {
                return AssetRef(id: id, name: name, size: d["size"] as? Int, mime: d["mime"] as? String)
            }
            if let inner = d["_0"] { return ref(inner) }
            return nil
        }
        func walk(_ v: Any) {
            if let d = v as? [String: Any] {
                for (k, x) in d {
                    if k == "asset", let r = ref(x) {
                        if seen.insert(r.id).inserted { out.append(r) }
                    } else {
                        walk(x)
                    }
                }
            } else if let a = v as? [Any] {
                a.forEach(walk)
            }
        }
        for r in records {
            guard let data = try? r.encoded(), let obj = try? JSONSerialization.jsonObject(with: data) else { continue }
            walk(obj)
        }
        return out
    }

    static func entryPath(for ref: AssetRef) -> String { "assets/\(ref.id)/\(ref.name)" }

    /// The asset an entry path names, or nil for anything else — including names that try to leave the
    /// asset folder ("..", empty or hidden components).
    static func assetRef(forEntry path: String) -> AssetRef? {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0] == "assets" else { return nil }
        let id = parts[1], name = parts[2]
        let idOK = !id.isEmpty && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
        guard idOK, !name.isEmpty, name != ".", name != "..", !name.contains("\\") else { return nil }
        return AssetRef(id: id, name: name)
    }

    /// True for a file `importArchive`/`readPackage` understands: a v1 JSON Lines archive or a `.based.zip`.
    public static func isArchive(_ url: URL) -> Bool {
        if ZipArchive.isZip(url) {
            guard let zip = try? ZipArchive(url: url) else { return false }
            return zip.entries.contains { $0.path == packageRecords }
        }
        guard let h = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? h.close() }
        let head = (try? h.read(upToCount: 400)) ?? Data()
        return String(decoding: head, as: UTF8.self).contains("\"\(format)\"")
    }

    public struct LoadedArchive: Sendable {
        public var read: ReadResult
        /// Files restored into the asset folder (already present ones count as restored).
        public var assetsRestored = 0
        /// Entries that couldn't be restored (path — reason).
        public var assetFailures: [String] = []
    }

    /// Reads a v1 `.jsonl` or v2 `.based.zip` from disk without touching the store — call it off the main actor.
    /// For a package, files are written to `assetsRoot` (FileAssetStore layout) first, so the records that
    /// reference them find them; existing files are kept. Then pass `read` to `importRecords(_:into:)`.
    public static func load(_ url: URL, assetsRoot: URL?) throws -> LoadedArchive {
        guard ZipArchive.isZip(url) else { return LoadedArchive(read: try read(Data(contentsOf: url))) }
        let zip = try ZipArchive(url: url)
        guard let recordsEntry = zip.entries.first(where: { $0.path == packageRecords }) else { throw ArchiveError.notAnArchive }
        var loaded = LoadedArchive(read: try read(zip.data(for: recordsEntry)))
        let fm = FileManager.default
        for e in zip.entries where !e.isDirectory && e.path != packageRecords {
            guard let ref = assetRef(forEntry: e.path) else { loaded.assetFailures.append("\(e.path) — not an asset path"); continue }
            guard let root = assetsRoot else { loaded.assetFailures.append("\(e.path) — no asset folder"); continue }
            let dst = FileAssetStore.location(of: ref, in: root)
            if fm.fileExists(atPath: dst.path) { loaded.assetsRestored += 1; continue }
            do {
                let data = try zip.data(for: e)
                try fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
                try data.write(to: dst, options: .atomic)
                loaded.assetsRestored += 1
            } catch {
                loaded.assetFailures.append("\(e.path) — \(ExportPlan.describe(error))")
            }
        }
        return loaded
    }

    public struct ReadResult: Sendable {
        public var header: Header?
        public var records: [Record]
        public var skipped: Int
    }

    /// Parses an archive; unreadable lines are counted, not fatal.
    public static func read(_ data: Data) throws -> ReadResult {
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        var header: Header?
        var records: [Record] = []
        var skipped = 0
        for line in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
            let d = Data(line)
            if header == nil, let h = try? dec.decode(Header.self, from: d), h.format == format {
                guard h.version <= version else { throw ArchiveError.newerVersion(h.version) }
                header = h; continue
            }
            guard let obj = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                  let k = obj["kind"] as? String, let kind = RecordKind(rawValue: k), let payload = obj["data"],
                  let pd = try? JSONSerialization.data(withJSONObject: payload),
                  let r = try? Record.decode(kind: kind, data: pd) else { skipped += 1; continue }
            records.append(r)
        }
        guard header != nil else { throw ArchiveError.notAnArchive }
        return ReadResult(header: header, records: records, skipped: skipped)
    }

    public enum ArchiveError: Error, CustomStringConvertible {
        case notAnArchive, newerVersion(Int)
        public var description: String {
            switch self {
            case .notAnArchive: return "This file isn't a Based archive."
            case .newerVersion(let v): return "This archive was written by a newer Based (format \(v)). Update the app to import it."
            }
        }
    }

    public struct ImportResult: Sendable, Equatable {
        /// Records written.
        public var imported: Int
        /// Records the workspace already had in a newer version (kept).
        public var keptNewer: Int
        /// Lines that couldn't be read.
        public var skipped: Int
    }

    /// Imports an archive into `store` (last writer wins per record, like sync; nothing is deleted).
    /// Into an empty workspace (restore), the archive's workspace settings — name, teamspaces, favorites,
    /// home — replace the fresh ones. Into a workspace with content, the archive's workspace record is merged
    /// into the existing one (never a second workspace record, BSD-23): name and icon only if empty locally,
    /// home page only if none is set, favorites and teamspaces are added.
    @MainActor @discardableResult
    public static func importArchive(_ data: Data, into store: WorkspaceStore) throws -> ImportResult {
        try importRecords(try read(data), into: store)
    }

    /// The store half of an import: `r` comes from `read(_:)` or `load(_:assetsRoot:)` (parsed off the main actor).
    @MainActor @discardableResult
    public static func importRecords(_ r: ReadResult, into store: WorkspaceStore) throws -> ImportResult {
        var records = r.records
        var restoredWorkspace = 0
        if let i = records.firstIndex(where: { $0.key.kind == .workspace }), case .workspace(var w) = records[i] {
            records.removeAll { $0.key.kind == .workspace }
            if store.blocks.isEmpty {
                w.id = store.workspace.id
                store.transact("Restore workspace", undoable: false) { tx in tx.put(w) }
                restoredWorkspace = 1
            } else {
                let merged = mergeWorkspace(store.workspace, with: w)
                if merged != store.workspace {
                    store.transact("Import workspace settings", undoable: false) { tx in tx.put(merged) }
                    restoredWorkspace = 1
                }
            }
        }
        // Origin `.import`: stamps kept, no undo, but logged as local so sync pushes the restore (BSD-26).
        let stale = try store.applyImported(records)
        return ImportResult(imported: records.count - stale.count + restoredWorkspace, keptNewer: stale.count, skipped: r.skipped)
    }

    /// `local` with the archive's settings added where they don't overwrite anything (ID stays `local.id`).
    static func mergeWorkspace(_ local: Workspace, with incoming: Workspace) -> Workspace {
        var w = local
        if w.name.trimmingCharacters(in: .whitespaces).isEmpty { w.name = incoming.name }
        if w.icon == nil { w.icon = incoming.icon }
        if w.homePageID == nil { w.homePageID = incoming.homePageID }
        for f in incoming.favorites where !w.favorites.contains(f) { w.favorites.append(f) }
        if let extra = incoming.teamspaces, !extra.isEmpty {
            var spaces = w.teamspaces ?? []
            for t in extra where !spaces.contains(where: { $0.id == t.id }) { spaces.append(t) }
            w.teamspaces = spaces
        }
        return w
    }
}
