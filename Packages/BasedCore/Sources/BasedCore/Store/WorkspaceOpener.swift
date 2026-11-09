import Foundation

/// Opens the workspace database on disk — and says why when it can't. There is no silent fallback to an
/// in-memory workspace: the app shows an error screen instead (a workspace that is never saved loses everything).
public enum WorkspaceOpener {
    public static let fileName = "based.sqlite"

    public enum OpenError: Error, CustomStringConvertible, Equatable, Sendable {
        /// The data folder doesn't exist and can't be created.
        case cannotCreateDirectory(path: String, reason: String)
        /// SQLite couldn't open the file (missing permission, not a database, …).
        case cannotOpen(path: String, reason: String)
        /// The file opened, but can't be written.
        case readOnly(path: String, reason: String)
        /// The file was saved by a newer Based (schema version `found` > `supported`); it isn't touched (BSD-23).
        case newerFormat(path: String, found: Int, supported: Int)

        public var path: String {
            switch self {
            case .cannotCreateDirectory(let p, _), .cannotOpen(let p, _), .readOnly(let p, _), .newerFormat(let p, _, _): return p
            }
        }

        public var description: String {
            switch self {
            case .cannotCreateDirectory(let p, let r): return "The folder \(p) can't be created: \(r)"
            case .cannotOpen(let p, let r): return "The workspace file \(p) can't be opened: \(r)"
            case .readOnly(let p, let r): return "The workspace file \(p) can't be written: \(r)"
            case .newerFormat(let p, let f, let s):
                return "The workspace file \(p) was saved by a newer version of Based (format \(f), this app reads up to \(s)). Update Based to open it; the file was not changed."
            }
        }
    }

    /// Opens (or creates) `directory/fileName` and checks that it can be written. Never deletes or replaces
    /// an existing file.
    public static func open(directory: URL, fileName: String = fileName) -> Result<SQLitePersistence, OpenError> {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        if fm.fileExists(atPath: directory.path, isDirectory: &isDir) {
            guard isDir.boolValue else {
                return .failure(.cannotCreateDirectory(path: directory.path, reason: "a file with that name exists"))
            }
        } else {
            do { try fm.createDirectory(at: directory, withIntermediateDirectories: true) }
            catch { return .failure(.cannotCreateDirectory(path: directory.path, reason: error.localizedDescription)) }
        }
        let url = directory.appendingPathComponent(fileName)
        let p: SQLitePersistence
        do { p = try SQLitePersistence(url: url) }
        catch PersistenceError.newerFormat(let found, let supported) {
            return .failure(.newerFormat(path: url.path, found: found, supported: supported))
        }
        catch { return .failure(.cannotOpen(path: url.path, reason: "\(error)")) }
        do { try p.checkWritable() }
        catch { return .failure(.readOnly(path: url.path, reason: "\(error)")) }
        return .success(p)
    }
}
