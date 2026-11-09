import SwiftUI
import BasedCore
import BasedBrain

/// Settings → AI: keys, models, server, scheduler, Notion import.
struct AISettingsView: View {
    @Environment(BrainModel.self) private var brain
    @State private var anthropic = Secrets.get("anthropic") ?? ""
    @State private var openai = Secrets.get("openai") ?? ""
    @State private var serverToken = Secrets.get("server.token") ?? ""
    @State private var notionToken = Secrets.get("notion") ?? ""
    @State private var memoriesDB = ""
    @State private var skillsDB = ""
    @State private var aboutPage = ""
    @State private var pageIDs = ""
    @State private var importResult: String?
    @State private var importing = false
    private var secrets: SecretsStatus { SecretsStatus.shared }

    var body: some View {
        @Bindable var brain = brain
        Group {
            SecretsPermissionSection()
            Section("Providers") {
                SecureField("Anthropic API key", text: $anthropic).onSubmit { Secrets.set("anthropic", anthropic); brain.reloadProviders() }
                SecureField("OpenAI API key", text: $openai).onSubmit { Secrets.set("openai", openai); brain.reloadProviders() }
                TextField("Ollama / OpenAI-compatible URL (optional)", text: Binding(get: { brain.ollamaURL }, set: { brain.ollamaURL = $0 }))
                    .onSubmit { brain.reloadProviders() }
                Button("Save keys") { Secrets.set("anthropic", anthropic); Secrets.set("openai", openai); brain.reloadProviders() }
                LabeledContent("Active", value: brain.providerSummary)
                if AppleIntelligenceProvider.isAvailable { Label("Apple Intelligence available for on-device autofill", systemImage: "apple.logo").font(.caption) }
                if !brain.modelChoices.isEmpty {
                    Picker("Default model", selection: $brain.defaultModel) { ForEach(brain.modelChoices, id: \.self) { Text($0).tag($0) } }
                }
            }
            Section("Based server (VPS)") {
                TextField("Server URL (https://based.example.com)", text: $brain.serverURL)
                SecureField("Server token", text: $serverToken)
                Button("Connect") { Secrets.set("server.token", serverToken); brain.startServerSyncIfConfigured(); brain.configureScheduler() }
                LabeledContent("Status", value: brain.serverStatus)
                Button("Sync now") { brain.syncServerNow() }.disabled(brain.serverSync == nil)
                Text("The server keeps the workspace online around the clock, runs scheduled agents and serves MCP to Claude, ChatGPT and Cursor. iCloud sync can stay on as a second channel.").font(.caption).foregroundStyle(Theme.secondary)
            }
            Section("Agents") {
                Picker("Run scheduled agents on", selection: $brain.scheduleHost) {
                    ForEach(ScheduleHost.allCases, id: \.self) { Text($0.label).tag($0) }
                }
                // BSD-105: ⌘J talks to the main agent by default; "New chat" stays in the chat menu.
                Picker("⌘J opens", selection: $brain.chatShortcut) {
                    ForEach(ChatShortcutTarget.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .accessibilityIdentifier("settings.chatShortcut")
                ForEach(brain.brain.agents()) { a in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(a.name)
                            Text([a.schedule, a.model, a.lastRun.map { "last " + $0.formatted(date: .abbreviated, time: .shortened) },
                                  a.monthlyBudget.map { String(format: "€%.2f of €%.2f this month", brain.brain.spentThisMonth(agent: a.id), $0) },
                                  a.runningNode.map { "running on " + $0 }].compactMap { $0 }.joined(separator: " · "))
                                .font(.caption).foregroundStyle(Theme.secondary)
                        }
                        Spacer()
                        Button("Run now") { brain.runAgent(a) }.disabled(!brain.hasProvider)
                    }
                }
                if !brain.schedulerLog.isEmpty {
                    DisclosureGroup("Log") { ForEach(Array(brain.schedulerLog.suffix(30).enumerated()), id: \.offset) { Text($0.element).font(.caption.monospaced()) } }
                }
            }
            Section("Import from Notion (API)") {
                SecureField("Notion integration token (ntn_…)", text: $notionToken)
                TextField("Memories database ID", text: $memoriesDB)
                TextField("Skills database ID", text: $skillsDB)
                TextField("About page ID", text: $aboutPage)
                TextField("Page or database links / IDs to import (comma-separated)", text: $pageIDs)
                Button(importing ? "Importing…" : "Import") {
                    Secrets.set("notion", notionToken); importing = true
                    Task {
                        importResult = await brain.importFromNotion(token: notionToken, memoriesDB: memoriesDB, skillsDB: skillsDB, aboutPage: aboutPage,
                                                                    pages: pageIDs.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                        importing = false
                    }
                }.disabled(notionToken.isEmpty || importing)
                if let importResult { Text(importResult).font(.caption) }
                Text("Share the pages/databases with your integration in Notion first (••• → Connections). For a full workspace import use File → Import from Notion….").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        // Keys load from the Keychain in the background — fill fields that were empty when the view appeared.
        .onChange(of: secrets.revision) { _, _ in
            if anthropic.isEmpty { anthropic = Secrets.get("anthropic") ?? "" }
            if openai.isEmpty { openai = Secrets.get("openai") ?? "" }
            if serverToken.isEmpty { serverToken = Secrets.get("server.token") ?? "" }
            if notionToken.isEmpty { notionToken = Secrets.get("notion") ?? "" }
        }
    }
}

/// "N keys need Keychain permission" — shown when this build couldn't read stored keys without a prompt
/// (locally built apps get a new code signature with each build). Nothing is asked at launch any more.
struct SecretsPermissionSection: View {
    private var status: SecretsStatus { SecretsStatus.shared }
    var body: some View {
        if !status.pending.isEmpty || status.lastMessage != nil {
            Section("Keychain") {
                if !status.pending.isEmpty {
                    Label("\(status.pending.count) saved key\(status.pending.count == 1 ? " needs" : "s need") Keychain permission: \(status.pendingDescription)", systemImage: "key")
                    Text("This copy of Based has a new code signature (each local build gets one), so macOS asks before handing out keys an earlier build saved. Based no longer asks at launch — allow it here. macOS shows one prompt per key; choose “Always Allow”. Signing with your Apple development team (DEVELOPMENT_TEAM in Config/Local.xcconfig) keeps the signature stable across rebuilds.")
                        .font(.caption).foregroundStyle(Theme.secondary)
                    HStack {
                        Button(status.requesting ? "Waiting for macOS…" : "Allow Keychain access…") { status.requestAccess() }
                            .disabled(status.requesting)
                            .accessibilityIdentifier("secrets.allowKeychain")
                        Button("Not now") { Secrets.dismissPending() }.disabled(status.requesting)
                    }
                }
                if let m = status.lastMessage { Text(m).font(.caption).foregroundStyle(Theme.secondary) }
            }
        }
    }
}

/// Column header / row context action: fill a property with AI.
struct AutofillButton: View {
    @Environment(BrainModel.self) private var brain
    let databaseID: RecordID
    let propertyID: String
    let rows: [RecordID]
    @State private var running = false
    var body: some View {
        Button {
            running = true
            Task { await brain.autofill(databaseID: databaseID, propertyID: propertyID, rows: rows); running = false }
        } label: { Label { Text(running ? "Filling…" : "Autofill with AI") } icon: { AIGlyph(size: 14) } }
        .disabled(running || !brain.hasProvider)
    }
}
