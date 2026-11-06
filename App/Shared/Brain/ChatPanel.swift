import SwiftUI
import BasedCore
import BasedBrain

// MARK: - Docked chat (⌘J)

/// Notion-AI-style chat docked on the right of the window: history menu, new chat, expand to full page.
struct ChatPanel: View {
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @Environment(HappierModel.self) private var happier

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if brain.turns.isEmpty {
                ChatEmptyState(compact: true)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ChatTranscriptView(compact: true)
            }
            ChatComposer(compact: true)
        }
        .background(.background)
    }

    private var header: some View {
        HStack(spacing: 10) {
            Menu {
                Button("New chat", systemImage: "square.and.pencil") { brain.newChat() }
                if !happier.chats.isEmpty { Divider() }
                ForEach(happier.chats.prefix(20)) { c in
                    Button(c.title.nonEmptyOr("New chat")) { model.openChat(c.id, fullPage: false) }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold))
                }
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .accessibilityIdentifier("chat.history")
            Spacer(minLength: 4)
            Button { brain.newChat() } label: { Image(systemName: "square.and.pencil") }
                .help("New chat")
            Button { model.openChat(brain.chatID, fullPage: true) } label: { Image(systemName: "arrow.up.left.and.arrow.down.right") }
                .help("Open as full page")
                .accessibilityIdentifier("chat.expand")
            Button { model.showChatPanel = false } label: { Image(systemName: "xmark") }
                .help("Close (⌘J)")
                .accessibilityIdentifier("chat.close")
        }
        .buttonStyle(.plain)
        .foregroundStyle(Theme.secondary)
        .padding(.horizontal, 14)
        .frame(height: 40)
    }

    private var title: String {
        guard let id = brain.chatID else { return "New AI chat" }
        return happier.chats.first { $0.id == id }?.title.nonEmptyOr("Chat") ?? "Chat"
    }
}

// MARK: - Full-page chat

/// `.chat(id)` — big centered composer when empty ("What can I fetch for you?"), conversation otherwise.
struct ChatFullPage: View {
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain

    var body: some View {
        Group {
            if brain.turns.isEmpty {
                VStack(spacing: 0) {
                    Spacer(minLength: 40)
                    ChatEmptyState(compact: false)
                    ChatComposer(compact: false)
                        .frame(maxWidth: 680)
                        .padding(.horizontal, 32)
                    Spacer(minLength: 80)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 0) {
                    ChatTranscriptView(compact: false)
                    ChatComposer(compact: false)
                        .frame(maxWidth: 760)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .onAppear { syncFromSelection() }
        .onChange(of: model.selection) { _, _ in syncFromSelection() }
        .onChange(of: brain.chatID) { _, id in
            // First message of a new chat: the sidebar / tab now point at the saved chat.
            if case .chat(nil)? = model.selection, let id { model.selection = .chat(id) }
        }
        .accessibilityIdentifier("chat.page")
    }

    private func syncFromSelection() {
        guard case .chat(let id)? = model.selection, id != brain.chatID else { return }
        brain.openChat(id)
    }
}

// MARK: - Shared pieces

struct ChatEmptyState: View {
    let compact: Bool
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain

    var body: some View {
        VStack(spacing: compact ? 12 : 18) {
            Image(systemName: "sparkles")
                .font(.system(size: compact ? 26 : 34))
                .foregroundStyle(Color.accentColor)
            Text(compact ? "How can I help?" : "What can I fetch for you?")
                .font(.system(size: compact ? 18 : 28, weight: .semibold))
            if !brain.hasProvider && !brain.claudeAvailable {
                VStack(spacing: 6) {
                    Text("No AI connected yet. Add an API key in Settings → AI, or install Claude Code to use your Claude subscription.")
                        .multilineTextAlignment(.center).foregroundStyle(Theme.secondary).font(.callout)
                    Button("Agent setup…") { model.selection = .projects }
                        .controlSize(.small)
                }
                .frame(maxWidth: 420)
            }
            ChatSuggestions(compact: compact)
        }
        .padding(compact ? 20 : 32)
    }
}

struct ChatSuggestions: View {
    let compact: Bool
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain

    private var suggestions: [(String, String)] {
        var s: [(String, String)] = []
        if model.currentPageID != nil { s.append(("doc.text", "Summarize this page")) }
        s += [("magnifyingglass", "Find my notes about …"), ("checklist", "What are my open to-dos?"),
              ("square.and.pencil", "Draft a weekly review page"), ("brain", "Remember that I prefer short answers")]
        return s
    }

    var body: some View {
        let layout = compact ? AnyLayout(VStackLayout(alignment: .leading, spacing: 6)) : AnyLayout(HStackLayout(spacing: 8))
        layout {
            ForEach(suggestions.prefix(compact ? 5 : 4), id: \.1) { icon, text in
                Button {
                    if text.hasSuffix("…") { return }
                    brain.ask(text, pageContext: model.currentPageID)
                } label: {
                    Label(text, systemImage: icon)
                        .font(.system(size: 12.5))
                        .lineLimit(1)
                        .padding(.horizontal, 10).padding(.vertical, 6)
                        .background(Capsule().fill(Color.primary.opacity(0.05)))
                }
                .buttonStyle(.plain)
                .foregroundStyle(Theme.secondary)
            }
        }
    }
}

struct ChatTranscriptView: View {
    let compact: Bool
    @Environment(BrainModel.self) private var brain

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 16) {
                    ForEach(brain.turns) { ChatTurnView(turn: $0).id($0.id) }
                    Color.clear.frame(height: 1).id("end")
                }
                .padding(.horizontal, compact ? 16 : 32)
                .padding(.vertical, 16)
                .frame(maxWidth: compact ? .infinity : 760)
                .frame(maxWidth: .infinity)
            }
            .onChange(of: brain.turns.last?.text) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onChange(of: brain.turns.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}

struct ChatTurnView: View {
    let turn: ChatTurn

    var body: some View {
        if turn.role == .user {
            HStack {
                Spacer(minLength: 40)
                Text(turn.text)
                    .textSelection(.enabled)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.06)))
            }
        } else {
            VStack(alignment: .leading, spacing: 6) {
                if !turn.progress.isEmpty {
                    DisclosureGroup {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(Array(turn.progress.enumerated()), id: \.offset) { Text($0.element).font(.caption.monospaced()) }
                        }
                    } label: {
                        Label("\(turn.progress.count) step\(turn.progress.count == 1 ? "" : "s")", systemImage: "wrench.and.screwdriver")
                    }
                    .font(.caption)
                    .foregroundStyle(Theme.secondary)
                }
                if turn.text.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Thinking…").foregroundStyle(Theme.secondary)
                    }
                } else {
                    Text(ConsoleItemView.markdown(turn.text))
                        .textSelection(.enabled)
                        .lineSpacing(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}

/// Composer: multi-line field, current-page context chip, engine label, run-with-agent menu, send / stop.
struct ChatComposer: View {
    let compact: Bool
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    private var engineSelection: Binding<String> {
        let brain = brain
        return Binding(get: { brain.chatEngineChoice }, set: { brain.chatEngineChoice = $0 })
    }
    @Environment(HappierModel.self) private var happier
    @State private var input = ""
    @State private var usePage = true
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(compact ? "Ask AI anything…" : "Ask, search or make anything…", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: compact ? 13.5 : 15))
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit(send)
                .accessibilityIdentifier("ai.input")
            HStack(spacing: 8) {
                if let page = model.currentPageID {
                    Button { usePage.toggle() } label: {
                        Label(model.store.title(of: page).nonEmptyOr("Untitled"), systemImage: usePage ? "doc.text.fill" : "doc.text")
                            .lineLimit(1)
                            .font(.system(size: 11.5))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(Capsule().fill(usePage ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.05)))
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(usePage ? Color.accentColor : Theme.secondary)
                    .help(usePage ? "The current page is shared as context" : "Not sharing the current page")
                }
                Menu {
                    ForEach(happier.agents.filter(\.enabled)) { a in
                        Button("Run with \(a.name)") { runWithAgent(a.id) }
                    }
                } label: { Image(systemName: "terminal") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                .help("Hand this prompt to a coding agent in a new session")
                .accessibilityIdentifier("ai.runWithAgent")
                Spacer(minLength: 4)
                if brain.engineChoices.count > 2 {
                    Picker("", selection: engineSelection) {
                        ForEach(brain.engineChoices) { Text($0.label).tag($0.id) }
                    }
                    .labelsHidden().fixedSize().controlSize(.small)
                    .help("Which AI answers in this chat")
                    .accessibilityIdentifier("ai.engine")
                } else {
                    Text(brain.chatEngine).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                }
                Button(action: send) {
                    Image(systemName: brain.isRunning ? "stop.circle.fill" : "arrow.up.circle.fill").font(.system(size: 20))
                }
                .buttonStyle(.plain)
                .foregroundStyle(input.isEmpty && !brain.isRunning ? Theme.secondary.opacity(0.5) : Color.accentColor)
                .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || brain.isRunning)
                .accessibilityIdentifier("ai.send")
            }
            .foregroundStyle(Theme.secondary)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color(Theme.divider)))
        .shadow(color: .black.opacity(compact ? 0 : 0.06), radius: 8, y: 2)
        .padding(compact ? 10 : 16)
        .onAppear { focused = true }
    }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !brain.isRunning else { return }
        input = ""
        brain.ask(text, pageContext: usePage ? model.currentPageID : nil)
    }

    private func runWithAgent(_ agentID: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        happier.startSession(agentID: agentID, cwd: happier.defaultDirectory, title: text.isEmpty ? nil : String(text.prefix(60)), prompt: text)
        input = ""
    }
}
