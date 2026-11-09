import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
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

    static var defaultFolder: String { NSHomeDirectory() + "/.claude/skills" }
    var enabled: Bool { UserDefaults.standard.bool(forKey: Self.enabledKey) }
    var folder: URL { URL(fileURLWithPath: UserDefaults.standard.string(forKey: Self.folderKey) ?? Self.defaultFolder) }
    private(set) var lastReport: String = ""

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
        let root = folder
        let result: Result<SkillMirror.Report, Error> = await Task.detached(priority: .utility) {
            Result { try SkillMirror.sync(folders, to: root) }
        }.value
        switch result {
        case .success(let r):
            lastReport = r.summary
            Log.info("skills mirror → \(root.path): \(r.summary)", category: "agents")
            if !r.conflicts.isEmpty { model?.showToast("Skills: \(r.conflicts.count) file(s) changed in \(root.lastPathComponent) were kept") }
        case .failure(let e):
            lastReport = "Error: \(e)"
            Log.error("skills mirror failed: \(e)", category: "agents")
        }
        return lastReport
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
            Divider()
            Button("Export all skills…") { exportAll() }
            Divider()
            Toggle("Mirror to ~/.claude/skills", isOn: $mirror)
            Button("Sync mirror now") { Task { model.showToast("Skills: " + (await SkillMirrorService.shared.syncNow())) } }
                .disabled(!mirror)
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
