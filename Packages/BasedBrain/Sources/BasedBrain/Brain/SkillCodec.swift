import Foundation
import BasedCore

// BSD-60: Skills in the open Agent Skills format — a folder with `SKILL.md` (YAML frontmatter `name`,
// `description`, optional more fields, then Markdown instructions) plus any further files (scripts, references,
// templates). The same skill works in Claude Code (~/.claude/skills/<name>/), Codex and Based.
//
// Mapping to the Agent Brain: a skill row = name (title), Description, the SKILL.md body as page content, the other
// frontmatter fields verbatim in the "Frontmatter" column, and every further file as a sub-page of the row whose
// content is one code block holding the file's text unchanged (binary files: base64, language "base64").
// Sub-pages the user adds by hand export as `<title>.md`.

/// A skill folder in memory: relative path → bytes (`SKILL.md` included).
public struct SkillFolder: Equatable, Sendable {
    public var name: String
    public var files: [String: Data]
    public init(name: String, files: [String: Data]) { self.name = name; self.files = files }

    public var skillMD: String? { files[SkillCodec.mainFile].flatMap { String(data: $0, encoding: .utf8) } }
}

/// A decoded skill.
public struct SkillDocument: Equatable, Sendable {
    public var name: String
    public var description: String
    /// The Markdown instructions after the frontmatter.
    public var body: String
    /// Frontmatter lines other than name / description, kept verbatim (license, allowed-tools, metadata …).
    public var extraFrontmatter: String
    /// Further files: relative path → bytes.
    public var files: [String: Data]

    public init(name: String, description: String, body: String, extraFrontmatter: String = "", files: [String: Data] = [:]) {
        self.name = name; self.description = description; self.body = body; self.extraFrontmatter = extraFrontmatter; self.files = files
    }
}

public enum SkillCodecError: Error, Equatable, CustomStringConvertible {
    case missingSkillMD
    case missingField(String)
    case unsafePath(String)
    case tooLarge(String)

    public var description: String {
        switch self {
        case .missingSkillMD: return "The folder has no SKILL.md."
        case .missingField(let f): return "SKILL.md has no \(f) in its frontmatter."
        case .unsafePath(let p): return "Unsafe file path in the skill: \(p)"
        case .tooLarge(let p): return "File too large for a skill: \(p)"
        }
    }
}

public enum SkillCodec {
    public static let mainFile = "SKILL.md"
    /// Per-file limit (skills are instructions and small scripts, not data dumps).
    public static let maxFileBytes = 2_000_000
    public static let maxFiles = 200

    // MARK: Frontmatter

    /// Splits `---\n…\n---\n` frontmatter from the body. Returns the top-level `key: value` fields (quotes removed,
    /// `>` / `|` block scalars joined), the frontmatter lines other than name / description verbatim, and the body.
    public static func parseFrontmatter(_ text: String) -> (fields: [String: String], extra: String, body: String) {
        let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
        var lines = normalized.components(separatedBy: "\n")
        guard lines.first?.trimmingCharacters(in: .whitespaces) == "---",
              let end = lines.dropFirst().firstIndex(where: { $0.trimmingCharacters(in: .whitespaces) == "---" }) else {
            return ([:], "", normalized)
        }
        let head = Array(lines[1..<end])
        lines = Array(lines[(end + 1)...])
        if lines.first?.isEmpty == true { lines.removeFirst() }
        var fields: [String: String] = [:], extra: [String] = []
        var i = 0
        while i < head.count {
            let line = head[i]
            let isTop = !line.hasPrefix(" ") && !line.hasPrefix("\t")
            guard isTop, let colon = line.firstIndex(of: ":") else { extra.append(line); i += 1; continue }
            let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
            var block: [String] = []
            var j = i + 1
            while j < head.count, head[j].hasPrefix(" ") || head[j].hasPrefix("\t") || head[j].isEmpty { block.append(head[j]); j += 1 }
            if key == "name" || key == "description" {
                if value == ">" || value == "|" || value == ">-" || value == "|-" {
                    let parts = block.map { $0.trimmingCharacters(in: .whitespaces) }
                    value = value.hasPrefix(">") ? parts.filter { !$0.isEmpty }.joined(separator: " ") : parts.joined(separator: "\n")
                } else if !block.isEmpty {
                    value = ([value] + block.map { $0.trimmingCharacters(in: .whitespaces) }).filter { !$0.isEmpty }.joined(separator: " ")
                }
                fields[key] = unquote(value)
            } else {
                fields[key] = unquote(value)
                extra.append(line); extra.append(contentsOf: block)
            }
            i = j
        }
        while extra.last?.trimmingCharacters(in: .whitespaces).isEmpty == true { extra.removeLast() }
        return (fields, extra.joined(separator: "\n"), lines.joined(separator: "\n"))
    }

    static func unquote(_ s: String) -> String {
        guard s.count >= 2, let f = s.first, let l = s.last, f == l, f == "\"" || f == "'" else { return s }
        let inner = String(s.dropFirst().dropLast())
        return f == "\"" ? inner.replacingOccurrences(of: "\\\"", with: "\"").replacingOccurrences(of: "\\n", with: "\n")
                         : inner.replacingOccurrences(of: "''", with: "'")
    }

    /// A YAML scalar for a one-line value: plain when safe, else double-quoted.
    static func yaml(_ s: String) -> String {
        let flat = s.replacingOccurrences(of: "\n", with: " ")
        let special = CharacterSet(charactersIn: ":#{}[],&*!|>'\"%@`")
        let needsQuotes = flat.isEmpty || flat.rangeOfCharacter(from: special) != nil || flat.hasPrefix("-") || flat.hasPrefix(" ") || flat.hasSuffix(" ")
        guard needsQuotes else { return flat }
        return "\"" + flat.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"") + "\""
    }

    // MARK: Folder ↔ document

    public static func decode(_ folder: SkillFolder) throws -> SkillDocument {
        guard let md = folder.skillMD else { throw SkillCodecError.missingSkillMD }
        let (fields, extra, body) = parseFrontmatter(md)
        let name = (fields["name"]?.nonEmptyTrimmed) ?? folder.name.nonEmptyTrimmed
        guard let name else { throw SkillCodecError.missingField("name") }
        guard let description = fields["description"]?.nonEmptyTrimmed else { throw SkillCodecError.missingField("description") }
        var files = folder.files
        files[mainFile] = nil
        for p in files.keys { try checkPath(p) }
        return SkillDocument(name: name, description: description, body: body.trimmingCharacters(in: .newlines),
                             extraFrontmatter: extra, files: files)
    }

    public static func encode(_ doc: SkillDocument) -> SkillFolder {
        var head = "---\nname: \(yaml(doc.name))\ndescription: \(yaml(doc.description))\n"
        if !doc.extraFrontmatter.isEmpty { head += doc.extraFrontmatter + "\n" }
        head += "---\n\n"
        var files = doc.files
        files[mainFile] = Data((head + doc.body.trimmingCharacters(in: .newlines) + "\n").utf8)
        return SkillFolder(name: folderName(doc.name), files: files)
    }

    /// Agent Skills names: lowercase letters, digits and hyphens, at most 64 characters.
    public static func folderName(_ name: String) -> String {
        let mapped = name.lowercased().map { $0.isLetter && $0.isASCII || $0.isNumber ? $0 : "-" }
        let collapsed = String(mapped).split(separator: "-", omittingEmptySubsequences: true).joined(separator: "-")
        return String(collapsed.prefix(64)).nonEmptyTrimmed ?? "skill"
    }

    /// Relative, inside the folder, no hidden path parts.
    public static func checkPath(_ p: String) throws {
        let parts = p.split(separator: "/", omittingEmptySubsequences: false)
        if p.isEmpty || p.hasPrefix("/") || p.contains("\\") || parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw SkillCodecError.unsafePath(p)
        }
    }

    static func isText(_ d: Data) -> Bool {
        guard let s = String(data: d, encoding: .utf8) else { return false }
        return !s.contains("\u{0}")
    }

    static func language(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "py": return "python"
        case "js", "mjs", "cjs": return "javascript"
        case "ts": return "typescript"
        case "sh", "bash", "zsh": return "bash"
        case "md", "markdown": return "markdown"
        case "json": return "json"
        case "yml", "yaml": return "yaml"
        case "html", "htm": return "html"
        case "swift": return "swift"
        case "rb": return "ruby"
        case "txt", "": return "plain text"
        case let e: return e
        }
    }
}

// MARK: - Agent Brain

/// Result of importing a skill.
public struct SkillImport: Equatable, Sendable {
    public var id: RecordID
    public var name: String
    public var created: Bool
    public var files: Int
}

@MainActor
extension BrainStore {
    static let skillFrontmatterColumn = "Frontmatter"
    static let base64Language = "base64"

    /// Creates or updates (by name) the skill from an Agent Skills folder. Further files replace the row's file
    /// sub-pages of the same path; other sub-pages stay.
    @discardableResult
    public func importSkill(_ folder: SkillFolder) throws -> SkillImport {
        guard folder.files.count <= SkillCodec.maxFiles else { throw SkillCodecError.tooLarge("\(folder.files.count) files") }
        for (p, d) in folder.files where d.count > SkillCodec.maxFileBytes { throw SkillCodecError.tooLarge(p) }
        let doc = try SkillCodec.decode(folder)
        ensureColumn(skillsDB, Self.skillFrontmatterColumn, .text)
        let existing = skills().first { $0.name.caseInsensitiveCompare(doc.name) == .orderedSame }
        let id: RecordID
        if let existing {
            id = existing.id
        } else {
            id = store.addRow(to: skillsDB, title: RichText(doc.name))
            if let p = propID(skillsDB, "Enabled") { store.setValue(id, p, .checkbox(true)) }
        }
        if let p = propID(skillsDB, "Description") { store.setValue(id, p, .text(RichText(doc.description))) }
        if let p = propID(skillsDB, Self.skillFrontmatterColumn) {
            store.setValue(id, p, doc.extraFrontmatter.isEmpty ? nil : .text(RichText(doc.extraFrontmatter)))
        }
        // Body: replace the instruction blocks, keep the file sub-pages.
        let oldBody = store.contentBlocks(of: id).filter { $0.type != .page }.map(\.id)
        if !oldBody.isEmpty { store.deleteBlocks(oldBody) }
        store.insertImported(MarkdownImporter().parse(doc.body), in: .block(id), at: .start, name: "Import skill")
        let pages = skillFilePages(id)
        for path in doc.files.keys.sorted() {
            let data = doc.files[path]!
            let text = SkillCodec.isText(data) ? String(decoding: data, as: UTF8.self) : data.base64EncodedString()
            var props = BlockProps()
            props.language = SkillCodec.isText(data) ? SkillCodec.language(for: path) : Self.base64Language
            let block = ImportedBlock(.code, text: RichText(text), props: props)
            let page = pages[path] ?? store.createPage(title: RichText(path), in: .block(id), name: "Import skill file")
            let old = store.contentBlocks(of: page).map(\.id)
            if !old.isEmpty { store.deleteBlocks(old) }
            store.insertImported([block], in: .block(page), name: "Import skill file")
        }
        return SkillImport(id: id, name: doc.name, created: existing == nil, files: doc.files.count)
    }

    /// The skill row as an Agent Skills folder.
    public func exportSkill(_ id: RecordID) -> SkillFolder? {
        guard let row = store.blocks[id], row.trashedAt == nil else { return nil }
        let exporter = MarkdownExporter(store: store)
        let body = exporter.exportBlocks(store.contentBlocks(of: id).filter { $0.type != .page }, indent: 0)
        var files: [String: Data] = [:]
        for (path, page) in skillFilePages(id) {
            let blocks = store.contentBlocks(of: page)
            if blocks.count == 1, blocks[0].type == .code {
                let text = blocks[0].text.plainText
                if blocks[0].props.language == Self.base64Language, let d = Data(base64Encoded: text) { files[path] = d }
                else { files[path] = Data(text.utf8) }
            } else {
                let p = (try? SkillCodec.checkPath(path)) != nil ? path : SkillCodec.folderName(path)
                let name = (p as NSString).pathExtension.isEmpty ? p + ".md" : p
                files[name] = Data(exporter.exportBlocks(blocks, indent: 0).utf8)
            }
        }
        let extra = text(row, skillsDB, Self.skillFrontmatterColumn)
        let doc = SkillDocument(name: row.title, description: text(row, skillsDB, "Description"),
                                body: body.trimmingCharacters(in: .newlines), extraFrontmatter: extra, files: files)
        return SkillCodec.encode(doc)
    }

    /// BSD-109: one file of a skill, exactly as exported (text unchanged, binary data as bytes).
    public func skillFile(_ id: RecordID, path: String) -> Data? {
        guard skillFilePages(id)[path] != nil else { return nil }
        return exportSkill(id)?.files[path]
    }

    /// Files of a skill with the id of the page that holds each one.
    public func skillFileList(_ id: RecordID) -> [(path: String, pageID: RecordID)] {
        skillFilePages(id).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    /// Paths of the files of a skill (its sub-pages, by title).
    public func skillFiles(_ id: RecordID) -> [String] { skillFilePages(id).keys.sorted() }

    private func skillFilePages(_ id: RecordID) -> [String: RecordID] {
        var out: [String: RecordID] = [:]
        for b in store.contentBlocks(of: id) where b.type == .page {
            let t = b.text.plainText.trimmingCharacters(in: .whitespaces)
            if !t.isEmpty, out[t] == nil { out[t] = b.id }
        }
        return out
    }
}

// MARK: - Disk

/// Reading and writing skill folders (macOS / Linux).
public enum SkillFolderIO {
    /// Reads one skill folder (hidden files and `.git` skipped).
    public static func read(_ dir: URL) throws -> SkillFolder {
        let fm = FileManager.default
        var files: [String: Data] = [:]
        let base = dir.standardizedFileURL.path
        guard let e = fm.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey],
                                    options: [.skipsHiddenFiles]) else { throw SkillCodecError.missingSkillMD }
        for case let url as URL in e {
            let v = try? url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard v?.isRegularFile == true, v?.isSymbolicLink != true else { continue }
            let path = url.standardizedFileURL.path
            guard path.hasPrefix(base + "/") else { continue }
            let rel = String(path.dropFirst(base.count + 1))
            guard files.count < SkillCodec.maxFiles else { throw SkillCodecError.tooLarge("more than \(SkillCodec.maxFiles) files") }
            let d = try Data(contentsOf: url)
            guard d.count <= SkillCodec.maxFileBytes else { throw SkillCodecError.tooLarge(rel) }
            files[rel] = d
        }
        guard files[SkillCodec.mainFile] != nil else { throw SkillCodecError.missingSkillMD }
        return SkillFolder(name: dir.lastPathComponent, files: files)
    }

    /// Skill folders directly under `root` (each with a SKILL.md), sorted by name; `root` itself when it is one.
    public static func discover(_ root: URL) -> [URL] {
        let fm = FileManager.default
        if fm.fileExists(atPath: root.appendingPathComponent(SkillCodec.mainFile).path) { return [root] }
        let kids = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? []
        return kids.filter { fm.fileExists(atPath: $0.appendingPathComponent(SkillCodec.mainFile).path) }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    /// Writes the folder's files under `dir` (creating directories). Only the given files are written.
    public static func write(_ folder: SkillFolder, to dir: URL) throws {
        let fm = FileManager.default
        for (rel, data) in folder.files {
            try SkillCodec.checkPath(rel)
            let url = dir.appendingPathComponent(rel)
            try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        }
    }
}

// MARK: - ZIP (BSD-109)

public extension SkillFolderIO {
    /// Skill folders inside a ZIP: the archive itself, a top-level folder, or several skill folders (also one level
    /// below a single wrapper folder). Unpacked with the system `unzip` into a temporary folder that is removed after.
    static func readZip(_ zip: URL, unzip: String = "/usr/bin/unzip") throws -> [SkillFolder] {
        let fm = FileManager.default
        let tmp = fm.temporaryDirectory.appendingPathComponent("based-skillzip-\(UUID().uuidString)")
        try fm.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: tmp) }
        #if os(macOS) || os(Linux)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: unzip)
        p.arguments = ["-q", "-o", zip.path, "-d", tmp.path, "-x", "__MACOSX/*"]
        p.standardOutput = FileHandle.nullDevice
        let err = Pipe(); p.standardError = err
        try p.run(); p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            throw SkillCodecError.tooLarge("unzip failed (\(p.terminationStatus)): " + String(decoding: err.fileHandleForReading.readDataToEndOfFile().prefix(200), as: UTF8.self))
        }
        #else
        throw SkillCodecError.missingSkillMD
        #endif
        var dirs = discover(tmp)
        if dirs.isEmpty {
            // One wrapper folder ("skills/") holding the skill folders.
            let kids = ((try? fm.contentsOfDirectory(at: tmp, includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? [])
                .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }
            if kids.count == 1 { dirs = discover(kids[0]) }
        }
        guard !dirs.isEmpty else { throw SkillCodecError.missingSkillMD }
        return try dirs.map { d in
            var f = try read(d)
            if d.standardizedFileURL.path == tmp.standardizedFileURL.path { f.name = zip.deletingPathExtension().lastPathComponent }
            return f
        }
    }
}

// MARK: - Mirror (Based → folder)

/// Keeps a folder (default `~/.claude/skills`) in step with the enabled Based skills, one sub-folder per skill.
/// Direction Based → folder only. A file changed in the folder since Based last wrote it is never overwritten: the
/// plan reports a conflict instead. Folders Based did not create (not in the manifest) are never touched, and
/// nothing is ever deleted — a skill removed in Based stays in the folder and is reported as orphaned.
public enum SkillMirror {
    public static let manifestFile = ".based-skills.json"

    /// What Based last wrote: folder → (file → SHA-256 hex).
    public struct Manifest: Codable, Equatable, Sendable {
        public var folders: [String: [String: String]]
        public init(folders: [String: [String: String]] = [:]) { self.folders = folders }
    }

    public enum Action: Equatable, Sendable {
        /// Write these files of the skill folder.
        case write(folder: String, files: [String])
        /// Skip a file: it was changed in the folder after Based wrote it.
        case conflict(folder: String, file: String)
        /// The folder exists but Based didn't create it (a skill of the same name from somewhere else).
        case foreign(folder: String)
        /// Based created this folder, but the skill is gone or disabled; left in place.
        case orphan(folder: String)
    }

    /// `onDisk`: what the target folder holds now (folder → file → hash; nil = folder missing).
    public static func plan(skills: [SkillFolder], onDisk: [String: [String: String]], manifest: Manifest) -> [Action] {
        var out: [Action] = []
        for s in skills.sorted(by: { $0.name < $1.name }) {
            let disk = onDisk[s.name]
            let known = manifest.folders[s.name]
            if disk != nil, known == nil { out.append(.foreign(folder: s.name)); continue }
            var write: [String] = []
            for (file, data) in s.files.sorted(by: { $0.key < $1.key }) {
                let want = hash(data)
                let now = disk?[file]
                if now == want { continue }                                   // already up to date
                if let now, now != known?[file] { out.append(.conflict(folder: s.name, file: file)); continue }  // edited in the folder
                write.append(file)
            }
            if !write.isEmpty { out.append(.write(folder: s.name, files: write)) }
        }
        let live = Set(skills.map(\.name))
        for f in manifest.folders.keys.sorted() where !live.contains(f) && onDisk[f] != nil { out.append(.orphan(folder: f)) }
        return out
    }

    public static func hash(_ d: Data) -> String { Sha256.hash([UInt8](d)).map { String(format: "%02x", $0) }.joined() }

    /// Hashes of the files in each sub-folder of `root` (only the folders named in `names`).
    public static func scan(_ root: URL, names: Set<String>) -> [String: [String: String]] {
        var out: [String: [String: String]] = [:]
        for n in names {
            let dir = root.appendingPathComponent(n)
            guard FileManager.default.fileExists(atPath: dir.path) else { continue }
            var files: [String: String] = [:]
            if let f = try? SkillFolderIO.read(dir) { for (k, v) in f.files { files[k] = hash(v) } }
            out[n] = files
        }
        return out
    }

    public struct Report: Equatable, Sendable {
        public var written: [String] = []
        public var conflicts: [String] = []
        public var foreign: [String] = []
        public var orphans: [String] = []
        public var summary: String {
            var parts = ["\(written.count) skill\(written.count == 1 ? "" : "s") updated"]
            if !conflicts.isEmpty { parts.append("\(conflicts.count) file\(conflicts.count == 1 ? "" : "s") changed in the folder kept (\(conflicts.joined(separator: ", ")))") }
            if !foreign.isEmpty { parts.append("not touched (not from Based): \(foreign.joined(separator: ", "))") }
            if !orphans.isEmpty { parts.append("no longer in Based, left in place: \(orphans.joined(separator: ", "))") }
            return parts.joined(separator: "; ")
        }
    }

    /// Plans and writes. Updates the manifest only for files actually written.
    public static func sync(_ skills: [SkillFolder], to root: URL) throws -> Report {
        let fm = FileManager.default
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        let mURL = root.appendingPathComponent(manifestFile)
        var manifest = (try? JSONDecoder().decode(Manifest.self, from: Data(contentsOf: mURL))) ?? Manifest()
        let names = Set(skills.map(\.name)).union(manifest.folders.keys)
        let actions = plan(skills: skills, onDisk: scan(root, names: names), manifest: manifest)
        var r = Report()
        for a in actions {
            switch a {
            case .write(let folder, let files):
                guard let s = skills.first(where: { $0.name == folder }) else { continue }
                let sub = SkillFolder(name: folder, files: s.files.filter { files.contains($0.key) })
                try SkillFolderIO.write(sub, to: root.appendingPathComponent(folder))
                for (k, v) in sub.files { manifest.folders[folder, default: [:]][k] = hash(v) }
                r.written.append(folder)
            case .conflict(let folder, let file): r.conflicts.append(folder + "/" + file)
            case .foreign(let folder): r.foreign.append(folder)
            case .orphan(let folder): r.orphans.append(folder)
            }
        }
        // Folders that were already up to date still belong to Based.
        for s in skills where manifest.folders[s.name] == nil && !r.foreign.contains(s.name) {
            manifest.folders[s.name] = s.files.mapValues(hash)
        }
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(manifest).write(to: mURL, options: .atomic)
        return r
    }
}

// MARK: - Resolving mirror conflicts (BSD-109)

public extension SkillMirror {
    /// The folder's version of a conflicting file: the skill with that file replaced (to import into Based).
    /// Afterwards `acknowledge` records the file as Based's, so the mirror stops reporting the conflict.
    static func folderVersion(of skill: SkillFolder, file: String, in root: URL) throws -> SkillFolder {
        try SkillCodec.checkPath(file)
        let data = try Data(contentsOf: root.appendingPathComponent(skill.name).appendingPathComponent(file))
        var s = skill
        s.files[file] = data
        return s
    }

    /// Overwrites the folder's file with Based's version.
    static func writeBasedVersion(of skill: SkillFolder, file: String, to root: URL) throws {
        guard let data = skill.files[file] else { throw SkillCodecError.missingSkillMD }
        try SkillFolderIO.write(SkillFolder(name: skill.name, files: [file: data]), to: root.appendingPathComponent(skill.name))
        try acknowledge(folder: skill.name, file: file, data: data, in: root)
    }

    /// Records `data` as what Based wrote for `folder/file` in the root's manifest.
    static func acknowledge(folder: String, file: String, data: Data, in root: URL) throws {
        let mURL = root.appendingPathComponent(manifestFile)
        var manifest = (try? JSONDecoder().decode(Manifest.self, from: Data(contentsOf: mURL))) ?? Manifest()
        manifest.folders[folder, default: [:]][file] = hash(data)
        let enc = JSONEncoder(); enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(manifest).write(to: mURL, options: .atomic)
    }

    /// Mirrors into several folders, each with its own manifest. Returns one report per folder (errors as reports).
    static func sync(_ skills: [SkillFolder], to roots: [URL]) -> [(root: URL, report: Result<Report, Error>)] {
        var seen: Set<String> = []
        return roots.compactMap { r in
            let key = r.standardizedFileURL.path
            guard seen.insert(key).inserted else { return nil }
            return (r, Result { try sync(skills, to: r) })
        }
    }
}

private extension String {
    var nonEmptyTrimmed: String? {
        let t = trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : t
    }
}
