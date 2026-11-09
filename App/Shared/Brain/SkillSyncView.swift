import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

// BSD-60: Skills ↔ Agent Skills folders (SKILL.md). Codec, import/export and the mirror rules live in BasedBrain
// (`SkillCodec`, `BrainStore.importSkill/exportSkill`, `SkillMirror`); this file has the menu and the background
// mirror to ~/.claude/skills (macOS only — iOS has no such folder).

#if os(macOS)
/// Mirrors the enabled Based skills into a folder (default ~/.claude/skills) a few seconds after skills change.
@MainActor
final class SkillMirrorService {
    static let shared = SkillMirrorService()
    static let enabledKey = "skills.mirror.enabled"
    static let folderKey = "skills.mirror.folder"
    /// BSD-109: more mirror folders (e.g. ~/.codex/skills), each with its own manifest.
    static let extraFoldersKey = "skills.mirror.extraFolders"

    static var defaultFolder: String { NSHomeDirectory() + "/.claude/skills" }
    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }
    var folder: URL { URL(fileURLWithPath: UserDefaults.standard.string(forKey: Self.folderKey) ?? Self.defaultFolder) }
    private(set) var lastReport: String = ""
    /// Files changed in a mirror folder after Based wrote them: (folder root, "skill/file").
    private(set) var conflicts: [(root: URL, path: String)] = []

    var extraFolders: [String] {
        get { UserDefaults.standard.stringArray(forKey: Self.extraFoldersKey) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: Self.extraFoldersKey) }
    }
    var allFolders: [URL] { [folder] + extraFolders.map { URL(fileURLWithPath: $0) } }

    private weak var model: AppModel?
    private var token: ObservationToken?
    private var pending: Task<Void, Never>?

    func start(_ model: AppModel) {
        guard token == nil else { return }
        self.model = model
        token = model.store.observe { [weak self] change in
            guard let self, self.enabled, self.touchesSkills(change) else { return }
            self.schedule()
        }
        if enabled { schedule(delay: 1) }
    }

    private func touchesSkills(_ c: ChangeSet) -> Bool {
        guard let brain = model?.brain.brain, !brain.skillsDB.isEmpty else { return false }
        let store = brain.store
        let skillRows = Set(brain.skills().map(\.id))
        if c.parents.contains(ParentRef.database(brain.skillsDB).key) { return true }
        // A block inside a skill row (its body or file pages) changed.
        for id in c.blockIDs {
            var cur = store.blocks[id]
            var depth = 0
            while let b = cur, depth < 12 {
                if skillRows.contains(b.id) { return true }
                if case .block(let p) = b.parent { cur = store.blocks[p] } else { break }
                depth += 1
            }
        }
        return false
    }

    func schedule(delay: Double = 3) {
        pending?.cancel()
        pending = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self?.syncNow()
        }
    }

    /// Exports the enabled skills and writes what changed. Returns the report summary.
    @discardableResult
    func syncNow() async -> String {
        guard let brain = model?.brain.brain else { return "" }
        let folders = brain.skills(enabledOnly: true).compactMap { brain.exportSkill($0.id) }
        let roots = allFolders
        let results = await Task.detached(priority: .utility) { SkillMirror.sync(folders, to: roots) }.value
        var lines: [String] = []
        var found: [(root: URL, path: String)] = []
        for (root, result) in results {
            switch result {
            case .success(let r):
                lines.append(results.count > 1 ? "\(root.lastPathComponent): \(r.summary)" : r.summary)
                found += r.conflicts.map { (root, $0) }
                Log.info("skills mirror → \(root.path): \(r.summary)", category: "agents")
            case .failure(let e):
                lines.append("\(root.lastPathComponent): error \(e)")
                Log.error("skills mirror \(root.path) failed: \(e)", category: "agents")
            }
        }
        conflicts = found
        lastReport = lines.joined(separator: " · ")
        if !found.isEmpty { model?.showToast("Skills: \(found.count) file(s) changed in the mirror folder were kept — resolve in SKILL.md menu") }
        return lastReport
    }
}

extension SkillMirrorService {
    /// BSD-109: resolve a conflict — take the folder's file into Based, or write Based's file into the folder.
    func resolve(_ c: (root: URL, path: String), takeFolder: Bool) {
        guard let brain = model?.brain.brain else { return }
        let parts = c.path.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2, let skill = brain.skills().first(where: { brain.exportSkill($0.id)?.name == parts[0] }),
              let current = brain.exportSkill(skill.id) else { return }
        do {
            if takeFolder {
                let updated = try SkillMirror.folderVersion(of: current, file: parts[1], in: c.root)
                try brain.importSkill(updated)
                try SkillMirror.acknowledge(folder: parts[0], file: parts[1], data: updated.files[parts[1]]!, in: c.root)
            } else {
                try SkillMirror.writeBasedVersion(of: current, file: parts[1], to: c.root)
            }
            conflicts.removeAll { $0.root == c.root && $0.path == c.path }
            schedule(delay: 0.5)
        } catch { model?.showToast("Could not resolve \(c.path): \(error)") }
    }
}

/// Starts the mirror at launch (it only does something when turned on).
struct SkillMirrorStarter: ViewModifier {
    @Environment(AppModel.self) private var model
    func body(content: Content) -> some View {
        content.task { SkillMirrorService.shared.start(model) }
    }
}

/// Menu next to "Open as page" in Agent Brain → Skills.
struct SkillSyncMenu: View {
    @Environment(AppModel.self) private var model
    @AppStorage(SkillMirrorService.enabledKey) private var mirror = false

    var body: some View {
        Menu {
            Button("Import skill folder…") { importFolder() }
            Button("Import from ~/.claude/skills") { importAll(from: URL(fileURLWithPath: NSHomeDirectory() + "/.claude/skills")) }
            Button("Import ZIP…") { importZip() }
            Divider()
            Button("Export all skills…") { exportAll() }
            Divider()
            Toggle("Mirror to ~/.claude/skills", isOn: $mirror)
            Button("Sync mirror now") { Task { model.showToast("Skills: " + (await SkillMirrorService.shared.syncNow())) } }
                .disabled(!mirror)
            Menu("Mirror folders") {
                ForEach(SkillMirrorService.shared.extraFolders, id: \.self) { f in
                    Button("Remove \(f.replacingOccurrences(of: NSHomeDirectory(), with: "~"))") {
                        SkillMirrorService.shared.extraFolders.removeAll { $0 == f }
                    }
                }
                Button("Add mirror folder…") { addMirrorFolder() }
            }
            .disabled(!mirror)
            let conflicts = SkillMirrorService.shared.conflicts
            if !conflicts.isEmpty {
                Menu("Conflicts (\(conflicts.count))") {
                    ForEach(Array(conflicts.enumerated()), id: \.offset) { _, c in
                        Menu("\(c.root.lastPathComponent)/\(c.path)") {
                            Button("Use the folder's version") { SkillMirrorService.shared.resolve(c, takeFolder: true) }
                            Button("Write Based's version") { SkillMirrorService.shared.resolve(c, takeFolder: false) }
                        }
                    }
                }
            }
        } label: {
            Label("SKILL.md", systemImage: "arrow.left.arrow.right.square")
        }
        .controlSize(.small)
        .fixedSize()
        .onChange(of: mirror) { _, on in if on { SkillMirrorService.shared.schedule(delay: 0.2) } }
        .accessibilityIdentifier("brain.skills.sync")
    }

    private func importFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = true
        panel.message = "Choose a skill folder (with SKILL.md) or a folder of skills"
        guard panel.runModal() == .OK else { return }
        for url in panel.urls { importAll(from: url) }
    }

    private func importZip() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.zip]
        panel.message = "Choose a ZIP with one or more skill folders (SKILL.md)"
        guard panel.runModal() == .OK else { return }
        var created = 0, updated = 0, failed: [String] = []
        for url in panel.urls {
            do {
                for f in try SkillFolderIO.readZip(url) {
                    do { let r = try model.brain.brain.importSkill(f); if r.created { created += 1 } else { updated += 1 } }
                    catch { failed.append("\(f.name): \(error)") }
                }
            } catch { failed.append("\(url.lastPathComponent): \(error)") }
        }
        if !failed.isEmpty { Log.error("skill zip import: \(failed.joined(separator: "; "))", category: "agents") }
        model.showToast("Skills: \(created) imported, \(updated) updated" + (failed.isEmpty ? "" : ", \(failed.count) failed"))
    }

    private func addMirrorFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.directoryURL = URL(fileURLWithPath: NSHomeDirectory() + "/.codex")
        panel.message = "Another folder to mirror the skills into (e.g. ~/.codex/skills)"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let svc = SkillMirrorService.shared
        if !svc.allFolders.contains(where: { $0.standardizedFileURL == url.standardizedFileURL }) { svc.extraFolders.append(url.path) }
        svc.schedule(delay: 0.2)
    }

    private func importAll(from root: URL) {
        let dirs = SkillFolderIO.discover(root)
        guard !dirs.isEmpty else { model.showToast("No SKILL.md found in \(root.lastPathComponent)"); return }
        var created = 0, updated = 0, failed: [String] = []
        for d in dirs {
            do {
                let r = try model.brain.brain.importSkill(try SkillFolderIO.read(d))
                if r.created { created += 1 } else { updated += 1 }
            } catch { failed.append("\(d.lastPathComponent): \(error)") }
        }
        if !failed.isEmpty { Log.error("skill import: \(failed.joined(separator: "; "))", category: "agents") }
        model.showToast("Skills: \(created) imported, \(updated) updated" + (failed.isEmpty ? "" : ", \(failed.count) failed"))
    }

    private func exportAll() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Export"
        panel.message = "Each skill becomes a folder with SKILL.md"
        guard panel.runModal() == .OK, let root = panel.url else { return }
        let brain = model.brain.brain
        var n = 0
        for s in brain.skills() {
            guard let f = brain.exportSkill(s.id) else { continue }
            do { try SkillFolderIO.write(f, to: root.appendingPathComponent(f.name)); n += 1 }
            catch { Log.error("skill export \(s.name): \(error)", category: "agents") }
        }
        model.showToast("Exported \(n) skill\(n == 1 ? "" : "s")")
    }
}
#else
struct SkillMirrorStarter: ViewModifier {
    func body(content: Content) -> some View { content }
}
#endif
