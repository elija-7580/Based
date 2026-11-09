import Foundation

/// Settings → Export all / Library → Export (BSD-67): pages as Markdown or HTML, databases as CSV (Markdown) or
/// HTML tables, sub-pages in a folder named like their parent's file — the structure of Notion's export — plus
/// every image, video and attachment the pages use in a top-level `assets/` folder.
///
/// Two steps so the app can keep the main actor free: `plan(_:format:)` renders all text on the main actor (it
/// reads the store), `ExportPlan.write(to:)` does the file I/O anywhere and returns a report that names every
/// file it couldn't write and every attachment that isn't on this device.
///
/// File names are unique per folder ("Notes.md", "Notes (2).md", case-insensitive like APFS), so no page
/// overwrites another; links between exported pages and to attachments are relative and percent-encoded.
@MainActor
public struct WorkspaceExporter {
    public enum Format: String, Sendable { case markdown, html }

    public let store: WorkspaceStore
    public let assets: AssetStore?

    public init(store: WorkspaceStore, assets: AssetStore?) {
        self.store = store
        self.assets = assets
    }

    /// Renders `pages` and their sub-pages (recursively) into an in-memory plan.
    public func plan(_ pages: [Block], format: Format) -> ExportPlan {
        // Pass 1: a unique path for every page, so links can point at the right file.
        var paths: [RecordID: String] = [:]
        var order: [RecordID] = []
        var used: [String: Set<String>] = ["": [ExportPlan.assetsFolder.lowercased()]]
        var directories: [String] = []
        func assign(_ page: Block, dir: String) {
            guard paths[page.id] == nil else { return }  // cycle / duplicate guard
            let isDB = page.type == .databasePage || page.type == .databaseInline
            let ext = format == .html ? "html" : isDB ? "csv" : "md"
            let base = ExportPlan.uniqueName(MarkdownExporter.fileName(store.title(of: page.id)), in: &used[dir, default: []])
            let path = ExportPlan.join(dir, base + "." + ext)
            paths[page.id] = path
            order.append(page.id)
            let kids = store.subpages(of: page.id)
            guard !kids.isEmpty else { return }
            let sub = ExportPlan.join(dir, base)
            directories.append(sub)
            for k in kids { assign(k, dir: sub) }
        }
        for p in pages { assign(p, dir: "") }

        // Pass 2: render with links relative to each file.
        let registry = AssetRegistry()
        var files: [ExportPlan.TextFile] = []
        for id in order {
            guard let page = store.blocks[id], let path = paths[id] else { continue }
            let dir = ExportPlan.directory(of: path)
            let pageLink: (RecordID) -> (title: String, url: String)? = { target in
                let t = store.title(of: target)
                guard let to = paths[target] else {
                    // Not part of this export: keep the plain Notion-style name.
                    let name = MarkdownExporter.fileName(t) + (format == .html ? ".html" : ".md")
                    return (t, ExportPlan.encode(name))
                }
                return (t, ExportPlan.encode(ExportPlan.relative(from: dir, to: to)))
            }
            let assetLink: (AssetRef) -> String = { ref in
                ExportPlan.encode(ExportPlan.relative(from: dir, to: registry.path(for: ref, page: store.title(of: id))))
            }
            let text: String
            switch format {
            case .html:
                var e = HTMLExporter(store: store, pageLink: pageLink)
                e.assetLink = assetLink
                text = e.export(page: id)
            case .markdown:
                var e = MarkdownExporter(store: store, pageLink: pageLink)
                e.assetLink = assetLink
                if page.type == .databasePage || page.type == .databaseInline {
                    text = store.database(forBlock: id).map { e.csv(database: $0.id) } ?? ""
                } else {
                    text = e.export(page: id)
                }
            }
            files.append(.init(path: path, contents: text))
        }
        let copies = registry.entries.map { entry in
            ExportPlan.AssetCopy(path: entry.path, source: assets?.url(for: entry.ref), name: entry.ref.name, page: entry.page)
        }
        if !copies.isEmpty { directories.append(ExportPlan.assetsFolder) }
        return ExportPlan(directories: directories, files: files, assets: copies)
    }

    /// Convenience for tests and small exports: plan and write in one go (on the calling actor).
    public func export(_ pages: [Block], format: Format, to directory: URL) -> ExportReport {
        plan(pages, format: format).write(to: directory)
    }

    /// Hands out one unique `assets/<name>` path per asset (same asset on several pages → one copy).
    final class AssetRegistry {
        struct Entry { var ref: AssetRef; var path: String; var page: String }
        private(set) var entries: [Entry] = []
        private var byID: [String: Int] = [:]
        private var used: Set<String> = []

        func path(for ref: AssetRef, page: String) -> String {
            if let i = byID[ref.id] { return entries[i].path }
            let name = MarkdownExporter.fileName(ref.name)
            let ext = (name as NSString).pathExtension
            let stem = ext.isEmpty ? name : String(name.dropLast(ext.count + 1))
            let unique = ExportPlan.uniqueName(stem.isEmpty ? "file" : stem, ext: ext, in: &used)
            let path = ExportPlan.join(ExportPlan.assetsFolder, unique)
            byID[ref.id] = entries.count
            entries.append(Entry(ref: ref, path: path, page: page))
            return path
        }
    }
}

/// Everything an export writes, rendered; `write(to:)` is plain file I/O and runs off the main actor.
public struct ExportPlan: Sendable {
    public static let assetsFolder = "assets"

    public struct TextFile: Sendable, Equatable {
        public var path: String
        public var contents: String
    }

    public struct AssetCopy: Sendable, Equatable {
        /// Path inside the export ("assets/photo.png").
        public var path: String
        /// The file in the asset store; nil when it isn't on this device (not downloaded yet).
        public var source: URL?
        public var name: String
        /// Title of the first page that uses it (for the report).
        public var page: String
    }

    public var directories: [String]
    public var files: [TextFile]
    public var assets: [AssetCopy]

    /// Writes the plan below `root` (created if needed). Never stops at the first problem: every file that
    /// couldn't be written and every missing attachment ends up in the report.
    public func write(to root: URL) -> ExportReport {
        let fm = FileManager.default
        var report = ExportReport(directory: root.path)
        do { try fm.createDirectory(at: root, withIntermediateDirectories: true) } catch {
            report.failures.append(.init(path: root.lastPathComponent, message: Self.describe(error)))
            return report
        }
        for d in directories {
            do { try fm.createDirectory(at: Self.url(root, d), withIntermediateDirectories: true) } catch {
                report.failures.append(.init(path: d, message: Self.describe(error)))
            }
        }
        for f in files {
            do {
                try f.contents.write(to: Self.url(root, f.path), atomically: true, encoding: .utf8)
                report.pages += 1
            } catch {
                report.failures.append(.init(path: f.path, message: Self.describe(error)))
            }
        }
        for a in assets {
            guard let src = a.source, fm.fileExists(atPath: src.path) else {
                report.failures.append(.init(path: a.path, message: "“\(a.name)” (on “\(a.page.isEmpty ? "Untitled" : a.page)”) isn't on this device yet — open the page once so it downloads, then export again."))
                continue
            }
            let dst = Self.url(root, a.path)
            do {
                if fm.fileExists(atPath: dst.path) { try fm.removeItem(at: dst) }
                try fm.copyItem(at: src, to: dst)
                report.assets += 1
            } catch {
                report.failures.append(.init(path: a.path, message: Self.describe(error)))
            }
        }
        return report
    }

    // MARK: Paths

    static func url(_ root: URL, _ path: String) -> URL {
        path.split(separator: "/").reduce(root) { $0.appendingPathComponent(String($1)) }
    }

    static func join(_ dir: String, _ name: String) -> String { dir.isEmpty ? name : dir + "/" + name }

    static func directory(of path: String) -> String {
        guard let i = path.lastIndex(of: "/") else { return "" }
        return String(path[..<i])
    }

    /// `to` relative to the folder `from` ("A/B" → "A/C/x.md" = "../C/x.md").
    static func relative(from dir: String, to path: String) -> String {
        let a = dir.split(separator: "/").map(String.init)
        let b = path.split(separator: "/").map(String.init)
        var common = 0
        while common < a.count, common < b.count - 1, a[common] == b[common] { common += 1 }
        return (Array(repeating: "..", count: a.count - common) + b[common...]).joined(separator: "/")
    }

    /// Percent-encodes each path component; parentheses too, so "Notes (2).md" survives in a Markdown link.
    static func encode(_ path: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "()/")
        return path.split(separator: "/", omittingEmptySubsequences: false)
            .map { String($0).addingPercentEncoding(withAllowedCharacters: allowed) ?? String($0) }
            .joined(separator: "/")
    }

    /// "Name", then "Name (2)", "Name (3)" … — unique case-insensitively within `used` (which it extends).
    static func uniqueName(_ stem: String, ext: String = "", in used: inout Set<String>) -> String {
        func make(_ n: Int) -> String {
            let s = n == 1 ? stem : "\(stem) (\(n))"
            return ext.isEmpty ? s : s + "." + ext
        }
        var n = 1
        while used.contains(make(n).lowercased()) { n += 1 }
        let name = make(n)
        used.insert(name.lowercased())
        return name
    }

    static func describe(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? (error as NSError).localizedDescription
    }
}

/// What an export did; `summary` is the line the app shows.
public struct ExportReport: Sendable, Equatable {
    public struct Failure: Sendable, Equatable {
        public var path: String
        public var message: String
    }

    public var directory: String
    /// Page / database files written.
    public var pages = 0
    /// Attachments copied into `assets/`.
    public var assets = 0
    public var failures: [Failure] = []

    public init(directory: String) { self.directory = directory }

    public var summary: String {
        var s = "Exported \(pages) page\(pages == 1 ? "" : "s")"
        if assets > 0 { s += " and \(assets) file\(assets == 1 ? "" : "s")" }
        s += " to \(directory)."
        if !failures.isEmpty {
            s += " \(failures.count) problem\(failures.count == 1 ? "" : "s"): "
            s += failures.prefix(3).map { "\($0.path) — \($0.message)" }.joined(separator: "; ")
            if failures.count > 3 { s += "; …" }
        }
        return s
    }
}
