import Foundation

/// Binary attachments (images, files) live outside the record store and sync as CKAssets.
public protocol AssetStore: AnyObject {
    func importFile(at url: URL) throws -> AssetRef
    func importData(_ data: Data, name: String, mime: String?) throws -> AssetRef
    func url(for asset: AssetRef) -> URL?
    func contains(_ asset: AssetRef) -> Bool
}

public final class FileAssetStore: AssetStore {
    public let root: URL

    public init(root: URL) {
        self.root = root
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    public func importFile(at url: URL) throws -> AssetRef {
        let data = try Data(contentsOf: url)
        return try importData(data, name: url.lastPathComponent, mime: Self.mime(for: url.pathExtension))
    }

    public func importData(_ data: Data, name: String, mime: String?) throws -> AssetRef {
        let ref = AssetRef(id: RecordIDs.make(), name: name.isEmpty ? "file" : name, size: data.count,
                           mime: mime ?? Self.mime(for: (name as NSString).pathExtension))
        let dir = root.appendingPathComponent(ref.id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: dir.appendingPathComponent(ref.name), options: .atomic)
        return ref
    }

    /// Store downloaded bytes for an existing reference (sync).
    public func store(_ data: Data, for ref: AssetRef) throws {
        let dir = root.appendingPathComponent(ref.id, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try data.write(to: dir.appendingPathComponent(ref.name), options: .atomic)
    }

    public func url(for asset: AssetRef) -> URL? {
        let u = root.appendingPathComponent(asset.id, isDirectory: true).appendingPathComponent(asset.name)
        return FileManager.default.fileExists(atPath: u.path) ? u : nil
    }

    public func contains(_ asset: AssetRef) -> Bool { url(for: asset) != nil }

    public func delete(_ asset: AssetRef) {
        try? FileManager.default.removeItem(at: root.appendingPathComponent(asset.id, isDirectory: true))
    }

    public static func mime(for ext: String) -> String? {
        switch ext.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "svg": return "image/svg+xml"
        case "pdf": return "application/pdf"
        case "mp4", "m4v": return "video/mp4"
        case "mov": return "video/quicktime"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "wav": return "audio/wav"
        case "txt", "md": return "text/plain"
        case "csv": return "text/csv"
        case "zip": return "application/zip"
        default: return nil
        }
    }
}