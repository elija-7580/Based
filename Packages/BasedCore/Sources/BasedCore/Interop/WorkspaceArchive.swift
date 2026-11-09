import Foundation

/// Lossless, portable workspace archive: JSON Lines, one record per line in the same shape the sync protocol
/// uses (`{"kind": "block", "data": {…}}`, see docs/sync-protocol.md), plus a header line.
///
/// Everything survives the round trip — page tree and order, databases with properties, views, filters,
/// formulas, relations, page formatting, timestamps and stamps — so it serves as a backup, a move between
/// machines, and the import format for other clients (web, Windows, Linux).
public enum WorkspaceArchive {
    public static let format = "based-archive"
    public static let version = 1

    public struct Header: Codable, Sendable, Equatable {
        public var format: String
        public var version: Int
        public var exportedAt: Date
        public var records: Int
        public var workspaceName: String?
    }

    /// Writes the archive (header line + one line per record, workspace first, then by kind and id).
    @MainActor
    public static func write(_ store: WorkspaceStore) throws -> Data {
        let records = store.allRecords().sorted { a, b in
            func rank(_ k: RecordKind) -> Int { k == .workspace ? 0 : k == .database ? 1 : k == .view ? 2 : 3 }
            return (rank(a.key.kind), a.key.id) < (rank(b.key.kind), b.key.id)
        }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        enc.dateEncodingStrategy = .iso8601
        var out = Data()
        let header = Header(format: format, version: version, exportedAt: Date(), records: records.count,
                            workspaceName: store.workspace.name.isEmpty ? nil : store.workspace.name)
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
        let r = try read(data)
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
