import SwiftUI
import BasedCore
import BasedBrain

/// ⌘J — chat with the workspace agent. Opens as a sheet (iOS) or a floating panel (macOS).
struct AIPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @Environment(\.dismiss) private var dismiss
    @State private var input = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "sparkles").foregroundStyle(Color.accentColor)
                Text("Ask Based").font(.headline)
                Spacer()
                if !brain.turns.isEmpty { Button("Clear") { brain.clearChat() }.buttonStyle(.plain).foregroundStyle(Theme.secondary) }
                Button { dismiss() } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(Theme.secondary) }.buttonStyle(.plain)
            }
            .padding(12)
            Divider()
            if !brain.hasProvider {
                ContentUnavailableView("No AI provider", systemImage: "key", description: Text("Add an Anthropic or OpenAI API key, or an Ollama URL, in Settings → AI."))
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if brain.turns.isEmpty { suggestions }
                            ForEach(brain.turns) { t in TurnView(turn: t).id(t.id) }
                        }
                        .padding(14)
                    }
                    .onChange(of: brain.turns.last?.text) { if let id = brain.turns.last?.id { proxy.scrollTo(id, anchor: .bottom) } }
                }
            }
            Divider()
            HStack(alignment: .bottom, spacing: 8) {
                TextField("Ask anything about your notes… (⏎ to send)", text: $input, axis: .vertical)
                    .textFieldStyle(.plain).lineLimit(1...6).focused($focused)
                    .onSubmit { send() }
                Button { send() } label: { Image(systemName: brain.isRunning ? "stop.circle" : "arrow.up.circle.fill").font(.title2) }
                    .buttonStyle(.plain).disabled(input.isEmpty || brain.isRunning).foregroundStyle(Color.accentColor)
            }
            .padding(12)
            if !brain.modelChoices.isEmpty {
                HStack {
                    Picker("Model", selection: Binding(get: { brain.defaultModel.isEmpty ? (brain.modelChoices.first ?? "") : brain.defaultModel }, set: { brain.defaultModel = $0 })) {
                        ForEach(brain.modelChoices, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden().font(.caption)
                    Spacer()
                }
                .padding(.horizontal, 12).padding(.bottom, 8)
            }
        }
        .frame(minWidth: 380, idealWidth: 460, minHeight: 420, idealHeight: 600)
        .onAppear { focused = true }
    }

    private var suggestions: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Try").font(.caption).foregroundStyle(Theme.secondary)
            ForEach(["Summarise this page in 5 bullets", "What did I decide about …?", "Create a weekly review page from my open to-dos", "Remember that I prefer short answers"], id: \.self) { s in
                Button(s) { input = s; send() }.buttonStyle(.plain).foregroundStyle(Color.accentColor)
            }
        }
    }

    private func send() {
        let text = input; input = ""
        brain.ask(text, pageContext: model.currentPageID)
    }
}

struct TurnView: View {
    let turn: ChatTurn
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if turn.role == .user {
                Text(turn.text).padding(10).background(RoundedRectangle(cornerRadius: 10).fill(Color(Theme.codeBackground)))
                    .frame(maxWidth: .infinity, alignment: .trailing)
            } else {
                if !turn.progress.isEmpty {
                    DisclosureGroup("\(turn.progress.count) tool call\(turn.progress.count == 1 ? "" : "s")") {
                        ForEach(Array(turn.progress.enumerated()), id: \.offset) { Text($0.element).font(.caption.monospaced()).foregroundStyle(Theme.secondary) }
                    }.font(.caption).foregroundStyle(Theme.secondary)
                }
                if turn.text.isEmpty { ProgressView().controlSize(.small) }
                else { Text(turn.text).textSelection(.enabled) }
            }
        }
    }
}

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

    var body: some View {
        @Bindable var brain = brain
        Group {
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
                Button("Connect") { Secrets.set("server.token", serverToken); brain.startServerSyncIfConfigured() }
                LabeledContent("Status", value: brain.serverStatus)
                Button("Sync now") { brain.syncServerNow() }.disabled(brain.serverSync == nil)
                Text("The server keeps the workspace online around the clock, runs scheduled agents and serves MCP to Claude, ChatGPT and Cursor. iCloud sync can stay on as a second channel.").font(.caption).foregroundStyle(Theme.secondary)
            }
            Section("Agents") {
                Toggle("Run scheduled agents on this device too", isOn: $brain.runSchedulesLocally)
                ForEach(brain.brain.agents()) { a in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(a.name)
                            Text([a.schedule, a.model, a.lastRun.map { "last " + $0.formatted(date: .abbreviated, time: .shortened) }].compactMap { $0 }.joined(separator: " · "))
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
                TextField("Page or database IDs to import (comma-separated; prefix db: for databases)", text: $pageIDs)
                Button(importing ? "Importing…" : "Import") {
                    Secrets.set("notion", notionToken); importing = true
                    Task {
                        importResult = await brain.importFromNotion(token: notionToken, memoriesDB: memoriesDB, skillsDB: skillsDB, aboutPage: aboutPage,
                                                                    pages: pageIDs.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
                        importing = false
                    }
                }.disabled(notionToken.isEmpty || importing)
                if let importResult { Text(importResult).font(.caption) }
                Text("Share the pages/databases with your integration in Notion first (••• → Connections).").font(.caption).foregroundStyle(Theme.secondary)
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
        } label: { Label(running ? "Filling…" : "Autofill with AI", systemImage: "sparkles") }
        .disabled(running || !brain.hasProvider)
    }
}
