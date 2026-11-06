import SwiftUI
import Observation
import BasedCore
import BasedBrain

/// State of a running Notion API import (lives outside the view so progress callbacks can reach it).
@MainActor @Observable
final class NotionImportRun {
    var progress: Double = 0
    var message = ""
    var running = false
    var summary: String?
    var error: String?
    var rootID: RecordID?
    @ObservationIgnored private var task: Task<Void, Never>?

    func start(token: String, targets: [NotionTarget], options: NotionImportOptions, store: WorkspaceStore, assets: AssetStore) {
        running = true; summary = nil; error = nil; rootID = nil
        progress = 0; message = "Connecting to Notion…"
        Log.notice("notion api import: \(targets.isEmpty ? "everything shared" : "\(targets.count) link(s)")", category: "import")
        let imp = NotionWorkspaceImport(token: token, options: options)
        imp.onProgress = { [weak self] p, m in
            Task { @MainActor in
                guard let self, self.running else { return }
                self.progress = max(self.progress, p)
                self.message = m
            }
        }
        task = Task { [weak self] in
            do {
                let r = try await imp.run(targets, into: store, assets: assets)
                self?.finish(r)
            } catch {
                self?.fail(error)
            }
        }
    }

    func cancel() {
        task?.cancel()
        message = "Cancelling…"
    }

    private func finish(_ r: ImportReport) {
        running = false
        progress = 1
        for w in r.warnings { Log.warning(w, category: "import") }
        Log.notice("notion api import done: \(r.pages) pages, \(r.databases) dbs, \(r.rows) rows, \(r.assets) files", category: "import")
        var s = "\(r.pages) pages, \(r.databases) databases, \(r.rows) rows and \(r.assets) files imported."
        if !r.warnings.isEmpty {
            s += "\n\n" + r.warnings.prefix(8).map { "• " + $0 }.joined(separator: "\n")
            if r.warnings.count > 8 { s += "\n… \(r.warnings.count - 8) more (Diagnostics → Log)" }
        }
        summary = s
        rootID = r.rootIDs.first
    }

    private func fail(_ e: Error) {
        running = false
        if case NotionAPIError.cancelled? = e as? NotionAPIError { message = "Import cancelled."; return }
        if e is CancellationError { message = "Import cancelled."; return }
        Log.error("notion api import failed: \(e)", category: "import")
        error = e.localizedDescription
    }
}

/// File ▸ Import from Notion…: 1:1 import through the Notion API (token + links), with the file import as alternative.
struct NotionImportSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var token = Secrets.get("notion") ?? ""
    @State private var links = ""
    @State private var everything = false
    @State private var options = NotionImportOptions()
    @State private var checking = false
    @State private var connection: String?
    @State private var tokenError: String?
    @State private var run = NotionImportRun()

    private var targets: [NotionTarget] { NotionTarget.parseList(links) }
    private var canStart: Bool { !token.isEmpty && !run.running && (everything || !targets.isEmpty) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.arrow.down.on.square").font(.title3)
                    Text("Import from Notion").font(.headline)
                }
                Text("Copies pages and databases 1:1 through the Notion API: text with all formatting and colors, toggles, callouts, columns, tables, synced blocks, images and files, databases with every property, views with filters, sorts and groups, rows with their content, relations, rollups and formulas. Importing again updates the same pages instead of duplicating them.")
                    .font(.callout).foregroundStyle(Theme.secondary)

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("1. Connect an integration").font(.subheadline.weight(.semibold))
                        Text("Create an internal integration (capabilities: read content, read user information), then copy its secret.")
                            .font(.caption).foregroundStyle(Theme.secondary)
                        Link("Open notion.so/profile/integrations ↗", destination: URL(string: "https://www.notion.so/profile/integrations")!)
                            .font(.caption)
                        HStack {
                            SecureField("Internal integration secret (ntn_…)", text: $token)
                                .textFieldStyle(.roundedBorder)
                                .accessibilityIdentifier("notionImport.token")
                            Button(checking ? "Checking…" : "Check") { check() }
                                .disabled(token.isEmpty || checking)
                        }
                        if let connection { Label(connection, systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green) }
                        if let tokenError { Text(tokenError).font(.caption).foregroundStyle(.red) }
                        Text("2. Share what you want to import: in Notion open the page or database → ••• → Connections → add your integration. Subpages and inline databases are included automatically.")
                            .font(.caption).foregroundStyle(Theme.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                GroupBox {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("3. What to import").font(.subheadline.weight(.semibold))
                        Picker("Source", selection: $everything) {
                            Text("Links").tag(false)
                            Text("Everything shared").tag(true)
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        if everything {
                            Text("Imports every page and database the integration can see, keeping their hierarchy.")
                                .font(.caption).foregroundStyle(Theme.secondary)
                        } else {
                            TextEditor(text: $links)
                                .font(.caption.monospaced())
                                .frame(minHeight: 64, maxHeight: 120)
                                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider)))
                                .overlay(alignment: .topLeading) {
                                    if links.isEmpty {
                                        Text("Paste page or database links (Share → Copy link), one per line")
                                            .font(.caption).foregroundStyle(Theme.secondary)
                                            .padding(.horizontal, 6).padding(.vertical, 8)
                                            .allowsHitTesting(false)
                                    }
                                }
                                .accessibilityIdentifier("notionImport.links")
                            if !links.isEmpty {
                                Text(targets.isEmpty ? "No Notion link or id recognized." : "\(targets.count) page(s) / database(s)")
                                    .font(.caption).foregroundStyle(targets.isEmpty ? .red : Theme.secondary)
                            }
                        }
                        Toggle("Subpages", isOn: $options.subpages)
                        Toggle("Content of database rows", isOn: $options.rowContent)
                        Toggle("Databases that relations point to", isOn: $options.followRelations)
                        Toggle("Copy images and files (Notion's file links expire after an hour)", isOn: $options.downloadFiles)
                    }
                    .toggleStyle(.switch)
                    .font(.callout)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }

                if run.running || run.progress > 0 {
                    VStack(alignment: .leading, spacing: 4) {
                        ProgressView(value: run.progress)
                        Text(run.message).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1)
                    }
                }
                if let e = run.error {
                    Text(e).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                }
                if let s = run.summary {
                    Text(s).font(.caption).textSelection(.enabled)
                }

                HStack {
                    Button("Import a Notion export file instead…") {
                        dismiss()
                        model.showImport = true
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    Spacer()
                    if run.running {
                        Button("Cancel") { run.cancel() }
                    } else {
                        Button(run.summary == nil ? "Close" : "Done") { dismiss() }
                    }
                    if let root = run.rootID, !run.running {
                        Button("Open") { model.openRoot(root); dismiss() }
                            .buttonStyle(.borderedProminent)
                    } else {
                        Button(run.running ? "Importing…" : "Import") { start() }
                            .buttonStyle(.borderedProminent)
                            .disabled(!canStart)
                            .keyboardShortcut(.defaultAction)
                            .accessibilityIdentifier("notionImport.start")
                    }
                }
                Text("Tip: without an integration, export from Notion as HTML (Settings → Export → HTML, include subpages) and import the .zip — it keeps all formatting too; views and formula expressions are only available through the API.")
                    .font(.caption2).foregroundStyle(Theme.secondary)
            }
            .padding(20)
        }
        .frame(minWidth: 520, idealWidth: 560, minHeight: 560)
        .interactiveDismissDisabled(run.running)
    }

    private func check() {
        checking = true; tokenError = nil; connection = nil
        let t = token
        Task {
            do {
                let name = try await NotionWorkspaceImport.verify(token: t)
                connection = "Connected: \(name)"
                Secrets.set("notion", t)
            } catch {
                tokenError = error.localizedDescription
            }
            checking = false
        }
    }

    private func start() {
        Secrets.set("notion", token)
        run.start(token: token, targets: everything ? [] : targets, options: options, store: model.store, assets: model.assets)
    }
}
