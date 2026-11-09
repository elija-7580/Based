import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-109: ZIP import, skill files for agents, several mirror folders, resolving mirror conflicts.
@MainActor
struct SkillsPart2Tests {
    private func tempDir(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("\(name)-\(UUID().uuidString)")
    }

    private func zip(_ root: URL, into archive: URL) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/zip")
        p.currentDirectoryURL = root
        p.arguments = ["-q", "-r", archive.path, "."]
        try p.run(); p.waitUntilExit()
        #expect(p.terminationStatus == 0)
    }

    @Test(.enabled(if: FileManager.default.isExecutableFile(atPath: "/usr/bin/zip") && FileManager.default.isExecutableFile(atPath: "/usr/bin/unzip")))
    func zipWithTwoSkillsImportsBothByteForByte() throws {
        let root = tempDir("skillzip")
        defer { try? FileManager.default.removeItem(at: root) }
        let src = root.appendingPathComponent("src/skills")
        let pdf = SkillCodecTests.folder()
        try SkillFolderIO.write(pdf, to: src.appendingPathComponent("pdf-tools"))
        let review = SkillFolder(name: "weekly-review", files: ["SKILL.md": Data("---\nname: weekly-review\ndescription: Fridays\n---\nReview the week.\n".utf8),
                                                              "notes/a.txt": Data("x\ny\n".utf8)])
        try SkillFolderIO.write(review, to: src.appendingPathComponent("weekly-review"))
        let archive = root.appendingPathComponent("skills.zip")
        try zip(root.appendingPathComponent("src"), into: archive)   // wrapper folder "skills/" inside
        let folders = try SkillFolderIO.readZip(archive)
        #expect(folders.map(\.name) == ["pdf-tools", "weekly-review"])
        #expect(folders[0].files == pdf.files, "files byte-identical, binary included")
        #expect(folders[1].files == review.files)
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        for f in folders { _ = try brain.importSkill(f) }
        #expect(Set(brain.skills().map(\.name)) == ["pdf-tools", "weekly-review"])

        // A ZIP of a single skill folder's contents takes the archive's name.
        let single = root.appendingPathComponent("single.zip")
        try zip(src.appendingPathComponent("weekly-review"), into: single)
        #expect(try SkillFolderIO.readZip(single).map(\.name) == ["single"])
        // No SKILL.md → error.
        let none = root.appendingPathComponent("none.zip")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("empty"), withIntermediateDirectories: true)
        try Data("hi".utf8).write(to: root.appendingPathComponent("empty/readme.txt"))
        try zip(root.appendingPathComponent("empty"), into: none)
        #expect(throws: SkillCodecError.missingSkillMD) { try SkillFolderIO.readZip(none) }
    }

    @Test func agentsReadSkillFilesExactly() throws {
        let store = WorkspaceStore(persistence: nil, node: "t")
        let brain = BrainStore(store: store)
        let id = try brain.importSkill(SkillCodecTests.folder()).id
        let tools = AgentTools(store: store, brain: brain)
        let loaded = tools.call("load_skill", ["name": "pdf-tools"])
        #expect(!loaded.isError && loaded.text.contains("## Files (read with read_skill_file)"))
        #expect(loaded.text.contains("`scripts/extract.py` [page: "))
        let script = tools.call("read_skill_file", ["skill": "PDF-tools", "path": "scripts/extract.py"])
        #expect(!script.isError && script.text == String(decoding: SkillCodecTests.folder().files["scripts/extract.py"]!, as: UTF8.self))
        let png = tools.call("read_skill_file", ["skill": "pdf-tools", "path": "assets/logo.png"])
        #expect(png.text.hasPrefix("(binary file, 7 bytes"))
        let missing = tools.call("read_skill_file", ["skill": "pdf-tools", "path": "scripts/nope.py"])
        #expect(missing.isError && missing.text.contains("assets/logo.png, reference.md, scripts/extract.py"))
        #expect(brain.skillFile(id, path: "reference.md") == SkillCodecTests.folder().files["reference.md"])
        #expect(tools.specs.contains { $0.name == "read_skill_file" })
    }

    @Test func twoMirrorFoldersKeepTheirOwnManifest() throws {
        let a = tempDir("mirror-a"), b = tempDir("mirror-b")
        defer { try? FileManager.default.removeItem(at: a); try? FileManager.default.removeItem(at: b) }
        let skill = SkillCodecTests.folder()
        var results = SkillMirror.sync([skill], to: [a, b, a])
        #expect(results.count == 2, "the same folder twice is synced once")
        #expect(results.allSatisfy { (try? $0.report.get().written) == ["pdf-tools"] })
        // Edit only in b → conflict only in b.
        try Data("by hand".utf8).write(to: b.appendingPathComponent("pdf-tools/reference.md"))
        var changed = skill
        changed.files["reference.md"] = Data("# Options v2\n".utf8)
        results = SkillMirror.sync([changed], to: [a, b])
        #expect(try results[0].report.get().written == ["pdf-tools"] && results[0].report.get().conflicts.isEmpty)
        #expect(try results[1].report.get().conflicts == ["pdf-tools/reference.md"])
        let ma = try JSONDecoder().decode(SkillMirror.Manifest.self, from: Data(contentsOf: a.appendingPathComponent(SkillMirror.manifestFile)))
        let mb = try JSONDecoder().decode(SkillMirror.Manifest.self, from: Data(contentsOf: b.appendingPathComponent(SkillMirror.manifestFile)))
        #expect(ma.folders["pdf-tools"]?["reference.md"] != mb.folders["pdf-tools"]?["reference.md"])
    }

    @Test func takingTheFolderVersionEndsTheConflict() throws {
        let root = tempDir("mirror-c")
        defer { try? FileManager.default.removeItem(at: root) }
        let brain = BrainStore(store: WorkspaceStore(persistence: nil, node: "t"))
        let id = try brain.importSkill(SkillCodecTests.folder()).id
        _ = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        try Data("print('hand edit')\n".utf8).write(to: root.appendingPathComponent("pdf-tools/scripts/extract.py"))
        var f = SkillCodecTests.folder()
        f.files["reference.md"] = Data("# changed in Based\n".utf8)
        _ = try brain.importSkill(f)
        var r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.conflicts == ["pdf-tools/scripts/extract.py"])

        // "Take the folder's version": import it into Based, record it as Based's.
        let taken = try SkillMirror.folderVersion(of: brain.exportSkill(id)!, file: "scripts/extract.py", in: root)
        _ = try brain.importSkill(taken)
        try SkillMirror.acknowledge(folder: "pdf-tools", file: "scripts/extract.py", data: taken.files["scripts/extract.py"]!, in: root)
        #expect(brain.skillFile(id, path: "scripts/extract.py") == Data("print('hand edit')\n".utf8))
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.conflicts.isEmpty)

        // "Write Based's version": overwrite the folder, no conflict afterwards.
        try Data("again by hand".utf8).write(to: root.appendingPathComponent("pdf-tools/reference.md"))
        f.files["reference.md"] = Data("# changed in Based again\n".utf8)
        _ = try brain.importSkill(f)
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.conflicts == ["pdf-tools/reference.md"])
        try SkillMirror.writeBasedVersion(of: brain.exportSkill(id)!, file: "reference.md", to: root)
        #expect(try Data(contentsOf: root.appendingPathComponent("pdf-tools/reference.md")) == Data("# changed in Based again\n".utf8))
        r = try SkillMirror.sync([brain.exportSkill(id)!], to: root)
        #expect(r.conflicts.isEmpty)
    }
}
