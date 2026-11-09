import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-60: Agent Skills folders (SKILL.md + files) ↔ Based skills, and the mirror to ~/.claude/skills.
@MainActor
struct SkillCodecTests {
    static let skillMD = """
    ---
    name: pdf-tools
    description: >
      Extract text and tables from PDFs.
      Use when the user mentions a PDF.
    license: MIT
    allowed-tools: Bash(python3:*) Read
    metadata:
      version: "1.2"
    ---

    # PDF tools

    1. Run `scripts/extract.py <file>`.
    2. Summarise the result.

    - See [reference](reference.md) for options.
    """

    static func folder() -> SkillFolder {
        SkillFolder(name: "pdf-tools", files: [
            "SKILL.md": Data(skillMD.utf8),
            "scripts/extract.py": Data("import sys\n\nprint(open(sys.argv[1], 'rb').read()[:10])\n".utf8),
            "reference.md": Data("# Options\n\n* `--pages` 1-3\n\n```\nraw  text\n```\n".utf8),
            "assets/logo.png": Data([0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0x10]),
        ])
    }

    @Test func frontmatterParser() {
        let (f, extra, body) = SkillCodec.parseFrontmatter(Self.skillMD)
        #expect(f["name"] == "pdf-tools")
        #expect(f["description"] == "Extract text and tables from PDFs. Use when the user mentions a PDF.")
        #expect(f["license"] == "MIT")
        #expect(extra == "license: MIT\nallowed-tools: Bash(python3:*) Read\nmetadata:\n  version: \"1.2\"")
        #expect(body.hasPrefix("# PDF tools"))
        // Quoted values, CRLF, no frontmatter at all.
        let q = SkillCodec.parseFrontmatter("---\r\nname: 'it''s'\r\ndescription: \"Say \\\"hi\\\"\"\r\n---\r\nBody")
        #expect(q.fields["name"] == "it's" && q.fields["description"] == "Say \"hi\"" && q.body == "Body")
        let none = SkillCodec.parseFrontmatter("Just text")
        #expect(none.fields.isEmpty && none.body == "Just text")
    }

    @Test func decodeEncodeKeepsFieldsAndFiles() throws {
        let doc = try SkillCodec.decode(Self.folder())
        #expect(doc.name == "pdf-tools" && doc.files.count == 3 && doc.files["SKILL.md"] == nil)
        let again = try SkillCodec.decode(SkillCodec.encode(doc))
        #expect(again == doc, "encode → decode is lossless")
        let md = SkillCodec.encode(SkillDocument(name: "Weekly review", description: "Use for: Fridays", body: "Do it."))
        #expect(md.name == "weekly-review")
        #expect(md.skillMD == "---\nname: Weekly review\ndescription: \"Use for: Fridays\"\n---\n\nDo it.\n")
        #expect(throws: SkillCodecError.missingSkillMD) { try SkillCodec.decode(SkillFolder(name: "x", files: [:])) }
        #expect(throws: SkillCodecError.missingField("description")) {
            try SkillCodec.decode(SkillFolder(name: "x", files: ["SKILL.md": Data("---\nname: x\n---\nBody".utf8)]))
        }
        #expect(throws: SkillCodecError.unsafePath("../evil.sh")) {
            try SkillCodec.decode(SkillFolder(name: "x", files: ["SKILL.md": Data("---\nname: x\ndescription: d\n---\n".utf8), "../evil.sh": Data()]))
        }
        #expect(SkillCodec.folderName("PDF Tools (v2)!") == "pdf-tools-v2")
    }

    @Test func folderToPageToFolderRoundTrip() throws {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let r = try brain.importSkill(Self.folder())
        #expect(r.created && r.name == "pdf-tools" && r.files == 3)
        let skill = try #require(brain.skills().first { $0.id == r.id })
        #expect(skill.description == "Extract text and tables from PDFs. Use when the user mentions a PDF.")
        #expect(skill.body.contains("# PDF tools") && skill.body.contains("scripts/extract.py"))
        #expect(brain.skillFiles(r.id) == ["assets/logo.png", "reference.md", "scripts/extract.py"])

        let out = try #require(brain.exportSkill(r.id))
        let original = Self.folder()
        #expect(out.name == "pdf-tools")
        for f in ["scripts/extract.py", "reference.md", "assets/logo.png"] { #expect(out.files[f] == original.files[f], "\(f) must be byte-identical") }
        let a = try SkillCodec.decode(original), b = try SkillCodec.decode(out)
        #expect(b.name == a.name && b.description == a.description && b.extraFrontmatter == a.extraFrontmatter)
        #expect(b.body.contains("# PDF tools") && b.body.contains("Summarise the result") && b.body.contains("[reference](reference.md)"))
        #expect(!b.body.contains("based://page"), "file sub-pages are not part of SKILL.md")
        // Stable after the first pass: page → folder → page → folder changes nothing.
        let r2 = try brain.importSkill(out)
        #expect(!r2.created && r2.id == r.id)
        #expect(brain.exportSkill(r.id) == out)
        #expect(brain.skills().count == 1)
        #expect(brain.skillFiles(r.id).count == 3, "re-import replaces file pages, no duplicates")
    }

    @Test func reimportUpdatesAndKeepsHandMadePages() throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let r = try brain.importSkill(Self.folder())
        let notes = store.createPage(title: RichText("Notes"), in: .block(r.id))
        store.insertImported(MarkdownImporter().parse("Remember the **flag**."), in: .block(notes))
        var f = Self.folder()
        f.files["SKILL.md"] = Data(Self.skillMD.replacingOccurrences(of: "Summarise the result.", with: "Write a page.").utf8)
        _ = try brain.importSkill(f)
        let s = try #require(brain.skills().first)
        #expect(s.body.contains("Write a page.") && !s.body.contains("Summarise"))
        #expect(store.blocks[notes]?.trashedAt == nil, "a page the user added stays")
        let out = try #require(brain.exportSkill(r.id))
        #expect(String(decoding: out.files["Notes.md"] ?? Data(), as: UTF8.self).contains("**flag**"), "hand-made sub-pages export as Markdown files")
    }

    @Test func tooManyOrTooLargeFilesAreRefused() {
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        var f = Self.folder()
        f.files["big.bin"] = Data(count: SkillCodec.maxFileBytes + 1)
        #expect(throws: SkillCodecError.tooLarge("big.bin")) { try brain.importSkill(f) }
        #expect(brain.skills().isEmpty)
    }

    @Test func diskReadWriteAndDiscover() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("skills-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        try SkillFolderIO.write(Self.folder(), to: root.appendingPathComponent("pdf-tools"))
        try FileManager.default.createDirectory(at: root.appendingPathComponent("not-a-skill"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("pdf-tools/.DS_Store"))
        let found = SkillFolderIO.discover(root)
        #expect(found.map(\.lastPathComponent) == ["pdf-tools"])
        let read = try SkillFolderIO.read(found[0])
        #expect(read == Self.folder(), "hidden files skipped, everything else byte-identical")
        #expect(SkillFolderIO.discover(found[0]) == [found[0]], "a skill folder itself can be chosen")
    }

    // MARK: Mirror

    @Test func mirrorPlanConflictRule() {
        let s = SkillFolder(name: "a", files: ["SKILL.md": Data("v2".utf8), "x.py": Data("x".utf8)])
        let h = SkillMirror.hash
        // Missing folder → write everything.
        #expect(SkillMirror.plan(skills: [s], onDisk: [:], manifest: .init()) == [.write(folder: "a", files: ["SKILL.md", "x.py"])])
        // Unchanged since Based wrote v1 → overwrite with v2.
        let m = SkillMirror.Manifest(folders: ["a": ["SKILL.md": h(Data("v1".utf8)), "x.py": h(Data("x".utf8))]])
        #expect(SkillMirror.plan(skills: [s], onDisk: ["a": ["SKILL.md": h(Data("v1".utf8)), "x.py": h(Data("x".utf8))]], manifest: m)
                == [.write(folder: "a", files: ["SKILL.md"])])
        // Edited in the folder → conflict, nothing overwritten.
        #expect(SkillMirror.plan(skills: [s], onDisk: ["a": ["SKILL.md": h(Data("mine".utf8)), "x.py": h(Data("x".utf8))]], manifest: m)
                == [.conflict(folder: "a", file: "SKILL.md")])
        // Not created by Based → untouched.
        #expect(SkillMirror.plan(skills: [s], onDisk: ["a": [:]], manifest: .init()) == [.foreign(folder: "a")])
        // Skill gone from Based → reported, not deleted.
        #expect(SkillMirror.plan(skills: [], onDisk: ["a": [:]], manifest: m) == [.orphan(folder: "a")])
    }

    @Test func mirrorSyncOnDisk() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("mirror-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let id = try brain.importSkill(Self.folder()).id
        // A skill of the user's own with the same name as a Based skill would be: never touched.
        try SkillFolderIO.write(SkillFolder(name: "mine", files: ["SKILL.md": Data("own".utf8)]), to: root.appendingPathComponent("weekly-review"))
        brain.saveSkill(name: "Weekly review", description: "Fridays", body: "Review the week.")
        let exported = brain.skills(enabledOnly: true).compactMap { brain.exportSkill($0.id) }
        var r = try SkillMirror.sync(exported, to: root)
        #expect(r.written == ["pdf-tools"] && r.foreign == ["weekly-review"])
        #expect(try SkillFolderIO.read(root.appendingPathComponent("pdf-tools")).files["scripts/extract.py"] == Self.folder().files["scripts/extract.py"])
        #expect(String(decoding: try Data(contentsOf: root.appendingPathComponent("weekly-review/SKILL.md")), as: UTF8.self) == "own")
        // Change in Based → file updated.
        var f = Self.folder()
        f.files["SKILL.md"] = Data(Self.skillMD.replacingOccurrences(of: "Summarise", with: "Condense").utf8)
        _ = try brain.importSkill(f)
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.written == ["pdf-tools"] && r.conflicts.isEmpty)
        #expect(String(decoding: try Data(contentsOf: root.appendingPathComponent("pdf-tools/SKILL.md")), as: UTF8.self).contains("Condense"))
        // Edited in the folder, then changed in Based → the folder's version is kept and reported.
        try Data("edited by hand".utf8).write(to: root.appendingPathComponent("pdf-tools/SKILL.md"))
        f.files["SKILL.md"] = Data(Self.skillMD.replacingOccurrences(of: "Summarise", with: "Shorten").utf8)
        _ = try brain.importSkill(f)
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.written.isEmpty && r.conflicts == ["pdf-tools/SKILL.md"])
        #expect(r.summary.contains("changed in the folder kept"))
        #expect(String(decoding: try Data(contentsOf: root.appendingPathComponent("pdf-tools/SKILL.md")), as: UTF8.self) == "edited by hand")
        // Up to date → nothing to do.
        try FileManager.default.removeItem(at: root.appendingPathComponent("pdf-tools/SKILL.md"))
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.written == ["pdf-tools"])
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.written.isEmpty && r.conflicts.isEmpty)
    }
}
