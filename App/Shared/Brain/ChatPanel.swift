import SwiftUI
import UniformTypeIdentifiers
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
            if let a = brain.artifact {
                ArtifactPanel(artifact: a)
            } else {
                if brain.turns.isEmpty {
                    ChatEmptyState(compact: true)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ChatTranscriptView(compact: true)
                }
                ChatComposer(compact: true)
            }
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
        .buttonStyle(.hoverFill)
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
    @AppStorage("chat.artifactWidth") private var artifactWidth: Double = 560

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
                HStack(spacing: 0) {
                    VStack(spacing: 0) {
                        ChatTranscriptView(compact: brain.artifact != nil)
                        ChatComposer(compact: false)
                            .frame(maxWidth: 760)
                            .frame(maxWidth: .infinity)
                    }
                    .frame(minWidth: 340)
                    if let a = brain.artifact {
                        PanelResizeHandle(width: $artifactWidth, range: 360...1100)
                        ArtifactPanel(artifact: a)
                            .frame(width: artifactWidth)
                            .transition(.move(edge: .trailing).combined(with: .opacity))
                    }
                }
                .animation(.easeOut(duration: 0.2), value: brain.artifact?.id)
            }
        }
        .onChange(of: brain.newArtifact) { _, a in
            // A reply just finished with an artifact: open it next to the chat (like Claude).
            if let a { brain.artifact = a; brain.newArtifact = nil }
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
            AIGlyph(size: compact ? 30 : 40, vivid: true)
            Text(compact ? "How can I help?" : "What can I fetch for you?")
                .font(.system(size: compact ? 18 : 28, weight: .semibold))
            if !brain.hasProvider && brain.installedCLIs.isEmpty {
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
        if compact {
            VStack(alignment: .leading, spacing: 6) { chips(suggestions.prefix(5)) }
        } else {
            // As many chips as fit in one row (they used to run off both edges in narrower windows).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { chips(suggestions.prefix(4)) }
                HStack(spacing: 8) { chips(suggestions.prefix(3)) }
                HStack(spacing: 8) { chips(suggestions.prefix(2)) }
                HStack(spacing: 8) { chips(suggestions.prefix(1)) }
            }
        }
    }

    private func chips(_ list: ArraySlice<(String, String)>) -> some View {
        ForEach(Array(list), id: \.1) { icon, text in SuggestionChip(icon: icon, text: text) {
            if text.hasSuffix("…") { return }
            brain.ask(text, pageContext: model.currentPageID)
        } }
    }
}

private struct SuggestionChip: View {
    let icon: String
    let text: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Label(text, systemImage: icon)
                .font(.system(size: 12.5))
                .lineLimit(1)
                .fixedSize()
                .padding(.horizontal, 10).padding(.vertical, 6)
                .background(Capsule().fill(Color.primary.opacity(hover ? 0.09 : 0.05)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .foregroundStyle(hover ? Theme.primary : Theme.secondary)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}

struct ChatTranscriptView: View {
    let compact: Bool
    @Environment(BrainModel.self) private var brain
    /// Pinned to the bottom while the reply streams; scrolling up unpins and shows the ↓ button.
    @State private var atBottom = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(brain.turns) { t in
                        ChatTurnView(turn: t, compact: compact)
                            .id(t.id)
                            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 10)), removal: .opacity))
                    }
                    // Permission requests of this chat (Claude Code's --permission-prompt-tool → Inbox) answered inline.
                    if let sid = brain.chatID {
                        ForEach(brain.happier.pendingInbox(for: sid)) { item in
                            ChatApprovalCard(item: item)
                                .transition(.asymmetric(insertion: .opacity.combined(with: .scale(scale: 0.97, anchor: .top)), removal: .opacity))
                        }
                    }
                    Color.clear.frame(height: 1).id("end")
                        .onAppear { atBottom = true }
                        .onDisappear { atBottom = false }
                }
                .padding(.horizontal, compact ? 16 : 32)
                .padding(.vertical, 16)
                .frame(maxWidth: compact ? .infinity : 760)
                .frame(maxWidth: .infinity)
                .animation(.spring(response: 0.38, dampingFraction: 0.9), value: brain.turns.map(\.id))
            }
            .overlay(alignment: .bottom) {
                if !atBottom {
                    ScrollToBottomButton {
                        withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { proxy.scrollTo("end", anchor: .bottom) }
                    }
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .scale(scale: 0.8)).combined(with: .offset(y: 8)))
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.8), value: atBottom)
            .onChange(of: brain.turns.last?.reply) { _, _ in
                if atBottom { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onChange(of: brain.chatID.map { brain.happier.pendingInbox(for: $0).count } ?? 0) { _, n in
                if n > 0 { withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { proxy.scrollTo("end", anchor: .bottom) } }
            }
            .onChange(of: brain.turns.count) { _, _ in
                // A new message always brings the bottom into view (like Claude / ChatGPT).
                withAnimation(.spring(response: 0.4, dampingFraction: 0.9)) { proxy.scrollTo("end", anchor: .bottom) }
            }
            .onAppear { proxy.scrollTo("end", anchor: .bottom) }
        }
    }
}

/// Round ↓ button centred above the composer (ChatGPT / Claude) when the transcript is scrolled up.
struct ScrollToBottomButton: View {
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(Theme.primary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(.background))
                .overlay(Circle().stroke(Theme.dividerColor))
                .shadow(color: .black.opacity(hover ? 0.18 : 0.10), radius: hover ? 8 : 5, y: 2)
                .scaleEffect(hover ? 1.06 : 1)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
        .help("Scroll to bottom")
        .accessibilityIdentifier("chat.scrollToBottom")
    }
}

/// Composer: multi-line field, current-page context chip, engine label, run-with-agent menu, send / stop.
struct ChatComposer: View {
    let compact: Bool
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @Environment(HappierModel.self) private var happier
    @State private var input = ""
    @State private var usePage = true
    @State private var attachments: [ChatAttachment] = []
    /// "@" mentions: pages of the workspace and, for coding-agent CLIs, files of the working folder.
    @State private var mentions: [Mention] = []
    @State private var mentionQuery: String?
    @State private var openModelPicker = false
    @State private var chooseFolder = false
    @State private var pickFiles = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(attachments) { a in AttachmentChip(name: a.name) { attachments.removeAll { $0.id == a.id } } }
                    }
                }
            }
            if !mentions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(mentions) { m in
                            AttachmentChip(name: (m.isFile ? "📄 " : "🔗 ") + m.title) { mentions.removeAll { $0.id == m.id } }
                        }
                    }
                }
            }
            TextField(compact ? "Ask AI anything… (@ to mention)" : "Ask, search or make anything… (@ to mention)", text: $input, axis: .vertical)
                .textFieldStyle(.plain)
                .font(.system(size: compact ? 13.5 : 15))
                .lineLimit(1...8)
                .focused($focused)
                .onSubmit {
                    if mentionQuery != nil, let first = mentionHits.first { pick(first) }
                    else if let c = slashMatches?.first { run(c) }
                    else { send() }
                }
                .onChange(of: input) { _, v in mentionQuery = MentionPicker.query(in: v) }
                .accessibilityIdentifier("ai.input")
            if let cmds = slashMatches, !cmds.isEmpty {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(cmds, id: \.name) { c in
                        PanelActionRow(title: "/" + c.name, symbol: c.symbol, shortcut: c.detail) { run(c) }
                    }
                }
                .padding(4)
                .background(RoundedRectangle(cornerRadius: 8).fill(Theme.hoverFill.opacity(0.5)))
                .transition(.opacity.combined(with: .offset(y: 4)))
            }
            if let q = mentionQuery, !mentionHits.isEmpty {
                MentionPicker(hits: mentionHits, query: q) { pick($0) }
                    .transition(.opacity.combined(with: .offset(y: 4)))
            }
            HStack(spacing: 8) {
                Button { pickFiles = true } label: { Image(systemName: "plus") }
                    .buttonStyle(.quiet)
                    .help("Attach files (or drop them here)")
                    .accessibilityIdentifier("ai.attach")
                if let page = model.currentPageID {
                    Button { usePage.toggle() } label: {
                        Label(model.store.title(of: page).nonEmptyOr("Untitled"), systemImage: usePage ? "doc.text.fill" : "doc.text")
                            .lineLimit(1)
                            .font(.system(size: 11.5))
                            .padding(.horizontal, 7).padding(.vertical, 3)
                            .background(Capsule().fill(usePage ? Theme.accentBlue.opacity(0.12) : Color.primary.opacity(0.05)))
                    }
                    .buttonStyle(.hoverFill)
                    .foregroundStyle(usePage ? Theme.accentBlue : Theme.secondary)
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
                // Narrow composers (next to an artifact, docked panel): the permission chip shrinks to its icon
                // so the model name stays readable.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { FolderChip(); PermissionModeButton(); EnginePickerButton(openRequest: $openModelPicker) }
                    HStack(spacing: 8) { PermissionModeButton(iconOnly: true); EnginePickerButton(openRequest: $openModelPicker) }
                    EnginePickerButton(openRequest: $openModelPicker)
                }
                DictationButton { focused = true }
                SendStopButton(running: brain.isRunning, enabled: canSend) {
                    if brain.isRunning { brain.stop() } else { send() }
                }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.85), value: brain.engineSpec.kind)
            .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 10)
        .background(RoundedRectangle(cornerRadius: compact ? 14 : 20, style: .continuous).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: compact ? 14 : 20, style: .continuous)
            .stroke(focused ? Theme.secondary.opacity(0.45) : Color(Theme.divider), lineWidth: focused ? 1 : 0.8))
        .shadow(color: .black.opacity(compact ? 0.03 : (focused ? 0.10 : 0.06)), radius: focused ? 14 : 8, y: 3)
        .animation(.easeOut(duration: 0.18), value: focused)
        .acceptsFileDrops { urls in attachments += urls.map { ChatAttachment(url: $0) } }
        .padding(compact ? 10 : 16)
        .onAppear { focused = true; takeDraft() }
        .onChange(of: model.chatDraft) { _, _ in takeDraft() }
        .onChange(of: chooseFolder) { _, v in if v { chooseFolder = false; FolderChip.choose(brain) } }
        .fileImporter(isPresented: $pickFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { r in
            if case .success(let urls) = r { attachments += urls.map { ChatAttachment(url: $0) } }
        }
    }

    /// "/" commands (Claude Code app style): engine, permission mode, effort, folder, new chat.
    struct SlashCommand { let name: String; let symbol: String; let detail: String; let action: (BrainModel) -> Void }

    private var slashCommands: [SlashCommand] {
        var out: [SlashCommand] = [
            SlashCommand(name: "new", symbol: "square.and.pencil", detail: "New chat") { $0.newChat() },
            SlashCommand(name: "model", symbol: "cpu", detail: "Choose model") { _ in openModelPicker = true },
        ]
        if [.claudeCode, .codex, .gemini, .opencode].contains(brain.engineSpec.kind) {
            out.append(SlashCommand(name: "folder", symbol: "folder", detail: "Working folder") { _ in chooseFolder = true })
            for m in CLICatalog.permissions(for: brain.engineSpec.kind) {
                let name: String
                switch m.id {
                case "": name = "ask"
                case "acceptEdits", "workspace-write", "auto_edit": name = "edits"
                case "plan": name = "plan"
                default: name = m.id == "bypassPermissions" || m.id == "danger-full-access" || m.id == "yolo" ? "bypass" : m.id
                }
                out.append(SlashCommand(name: name, symbol: m.symbol, detail: m.label) { $0.engineSpec.permission = m.id })
            }
        }
        for e in CLICatalog.efforts(for: brain.engineSpec.kind == .auto ? .claudeCode : brain.engineSpec.kind) where !e.id.isEmpty {
            out.append(SlashCommand(name: "effort " + e.id, symbol: "gauge.with.dots.needle.50percent", detail: "Effort: " + e.label) { b in
                guard b.engineSpec.kind != .auto else { return }
                b.engineSpec.effort = e.id
            })
        }
        return out
    }

    private var slashMatches: [SlashCommand]? {
        guard input.hasPrefix("/"), !input.contains("\n") else { return nil }
        let q = input.dropFirst().lowercased()
        return slashCommands.filter { q.isEmpty || $0.name.hasPrefix(q) || $0.name.contains(q) }
    }

    private func run(_ c: SlashCommand) {
        input = ""
        withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { c.action(brain) }
        focused = true
    }

    struct Mention: Identifiable, Hashable { let id: String; let title: String; let isFile: Bool; var path: String { id } }

    private var mentionHits: [Mention] {
        guard let q = mentionQuery else { return [] }
        var out: [Mention] = []
        var f = SearchFilters(); f.titleOnly = true
        let pages = q.isEmpty ? model.store.recentPages(limit: 6).map(\.id)
                              : SearchEngine(store: model.store).search(q, filters: f, limit: 6).map(\.pageID)
        for id in pages where !mentions.contains(where: { $0.id == id }) {
            out.append(Mention(id: id, title: model.store.title(of: id).nonEmptyOr("Untitled"), isFile: false))
        }
        if [.claudeCode, .codex, .gemini, .opencode].contains(brain.engineSpec.kind) {
            for path in MentionPicker.files(in: brain.chatFolder, matching: q).prefix(6) {
                out.append(Mention(id: path, title: (path as NSString).lastPathComponent, isFile: true))
            }
        }
        return out
    }

    private func pick(_ m: Mention) {
        if let r = input.range(of: "@" + (mentionQuery ?? ""), options: .backwards) { input.replaceSubrange(r, with: "") }
        if !mentions.contains(m) { mentions.append(m) }
        mentionQuery = nil
        focused = true
    }

    private func takeDraft() {
        guard let d = model.chatDraft else { return }
        model.chatDraft = nil
        input = d
        focused = true
    }

    private var canSend: Bool { !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty }

    private func send() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !brain.isRunning else { return }
        input = ""
        let files = attachments
        attachments = []
        var prompt = text
        if !mentions.isEmpty {
            prompt += "\n\n---\nReferenced:\n" + mentions.map { m in
                m.isFile ? "- file \(m.path)" : "- page “\(m.title)” (page id \(m.id)) — read it with the tools"
            }.joined(separator: "\n")
            mentions = []
        }
        brain.ask(prompt, pageContext: usePage ? model.currentPageID : nil, attachments: files)
    }

    private func runWithAgent(_ agentID: String) {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        happier.startSession(agentID: agentID, cwd: happier.defaultDirectory, title: text.isEmpty ? nil : String(text.prefix(60)), prompt: text)
        input = ""
    }
}


/// Claude-style send button: a filled circle with an arrow that springs in when there is something to send,
/// turning into a square stop button while the reply runs.
struct SendStopButton: View {
    let running: Bool
    let enabled: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            ZStack {
                Circle()
                    .fill(running || enabled ? Theme.primary : Theme.secondary.opacity(0.25))
                    .frame(width: 28, height: 28)
                    .scaleEffect(hover && (running || enabled) ? 1.06 : 1)
                if running {
                    RoundedRectangle(cornerRadius: 2.5)
                        .fill(Color(PlatformColor.textBackgroundColorCompat))
                        .frame(width: 10, height: 10)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                } else {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(Color(PlatformColor.textBackgroundColorCompat))
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled && !running)
        .onHover { hover = $0 }
        .animation(.spring(response: 0.28, dampingFraction: 0.7), value: running)
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: enabled)
        .animation(.easeOut(duration: 0.12), value: hover)
        .keyboardShortcut(running ? KeyboardShortcut(".", modifiers: .command) : nil)
        .help(running ? "Stop (⌘.)" : "Send (↩)")
        .accessibilityIdentifier("ai.send")
    }
}

extension PlatformColor {
    /// The window background (white / near-black) — the glyph colour on the filled send button.
    static var textBackgroundColorCompat: PlatformColor {
        #if os(macOS)
        return .textBackgroundColor
        #else
        return .systemBackground
        #endif
    }
}


/// "Allow Claude to read …?" — an approval request of the running chat, answered in place (Claude Code app style).
struct ChatApprovalCard: View {
    let item: InboxItem
    @Environment(BrainModel.self) private var brain

    var body: some View {
        let opts = PermissionPrompt.options(item)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text(Self.question(item.title, detail: Self.code(item.detail))).font(.system(size: 13.5, weight: .semibold)).lineLimit(2).truncationMode(.middle)
            }
            if !Self.display(Self.code(item.detail)).isEmpty {
                ScrollView {
                    Text(Self.display(Self.code(item.detail)))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(Theme.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 140)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.04)))
            }
            HStack(spacing: 8) {
                Spacer()
                ForEach(opts.reversed(), id: \.id) { o in
                    let primary = o.id == "allow_once"
                    Button(shortLabel(o)) {
                        withAnimation(.easeOut(duration: 0.2)) { brain.happier.resolve(item, decision: o.id) }
                    }
                    .buttonStyle(PillButtonStyle(prominent: primary))
                    .keyboardShortcut(primary ? .defaultAction : (o.id.hasPrefix("reject") ? .cancelAction : nil))
                }
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.orange.opacity(0.35)))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
        .accessibilityIdentifier("chat.approval")
    }

    /// "Read(/a/b/file.txt)" → "Allow reading file.txt?"; "Bash(ls -la)" → "Allow running ls -la?".
    static func question(_ title: String, detail: String = "") -> String {
        guard let open = title.firstIndex(of: "("), title.hasSuffix(")") else { return "Allow \(title)?" }
        let tool = String(title[..<open])
        var arg = String(title[title.index(after: open)..<title.index(before: title.endIndex)])
        // The title is shortened ("…"); the tool input has the full path / command.
        if let v = try? JSONValue.parse(Data(detail.utf8)) {
            if let p = v["file_path"]?.string ?? v["notebook_path"]?.string ?? v["path"]?.string { arg = p }
            else if let c = v["command"]?.string { arg = c.count > 60 ? String(c.prefix(60)) + "…" : c }
            else if let q = v["pattern"]?.string ?? v["query"]?.string ?? v["url"]?.string { arg = q }
        }
        if arg.hasPrefix("/") { arg = URL(fileURLWithPath: arg.replacingOccurrences(of: "…", with: "")).lastPathComponent }
        let verb: String
        switch tool {
        case "Read", "NotebookRead": verb = "reading"
        case "Write": verb = "writing"
        case "Edit", "MultiEdit", "NotebookEdit": verb = "editing"
        case "Bash": verb = "running"
        case "Glob", "Grep": verb = "searching"
        case "WebFetch": verb = "fetching"
        case "WebSearch": verb = "searching the web for"
        default: verb = "using \(tool) on"
        }
        return "Allow \(verb) \(arg)?"
    }

    /// Tool input for people: the command / path / pattern as plain text, other inputs as readable JSON.
    static func display(_ code: String) -> String {
        guard let v = try? JSONValue.parse(Data(code.utf8)) else { return code }
        if let c = v["command"]?.string { return c }
        if let p = v["file_path"]?.string ?? v["notebook_path"]?.string { return p }
        if let u = v["url"]?.string { return u }
        if let q = v["pattern"]?.string ?? v["query"]?.string { return q }
        return code.replacingOccurrences(of: "\\/", with: "/")
    }

    /// The fenced part of the Inbox detail (the tool input), without the Markdown lead line.
    static func code(_ detail: String) -> String {
        let parts = detail.components(separatedBy: "```")
        if parts.count >= 3 { return parts[1].trimmingCharacters(in: .newlines) }
        return detail.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func shortLabel(_ o: (id: String, label: String)) -> String {
        if o.id.hasPrefix("allow_always") { return "Always allow" }
        if o.id.hasPrefix("reject") { return "Deny" }
        if o.id == "allow_once" { return "Allow" }
        return o.label
    }
}


/// Rounded pill button: filled (primary action) or quiet grey, with a press/hover response.
struct PillButtonStyle: ButtonStyle {
    var prominent = false
    func makeBody(configuration: Configuration) -> some View {
        PillBody(configuration: configuration, prominent: prominent)
    }

    private struct PillBody: View {
        let configuration: ButtonStyleConfiguration
        let prominent: Bool
        @State private var hover = false
        var body: some View {
            configuration.label
                .font(.system(size: 12.5, weight: .medium))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .foregroundStyle(prominent ? Color(PlatformColor.textBackgroundColorCompat) : Theme.primary)
                .background(Capsule().fill(prominent ? Theme.primary.opacity(hover ? 0.88 : 1) : Theme.hoverFill.opacity(hover ? 1.6 : 1)))
                .scaleEffect(configuration.isPressed ? 0.96 : 1)
                .animation(.spring(response: 0.2, dampingFraction: 0.7), value: configuration.isPressed)
                .animation(.easeOut(duration: 0.12), value: hover)
                .onHover { hover = $0 }
        }
    }
}


/// Suggestions for an "@" mention in the chat composer.
struct MentionPicker: View {
    let hits: [ChatComposer.Mention]
    let query: String
    let pick: (ChatComposer.Mention) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            ForEach(hits) { h in
                PanelActionRow(title: h.title, symbol: h.isFile ? "doc.text" : "doc.richtext",
                               shortcut: h.isFile ? FolderChip.short((h.path as NSString).deletingLastPathComponent) : "") { pick(h) }
            }
        }
        .padding(4)
        .background(RoundedRectangle(cornerRadius: 8).fill(Theme.hoverFill.opacity(0.5)))
    }

    /// The text after the last "@" when the caret is still inside that word ("see @plan" → "plan").
    static func query(in text: String) -> String? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex, !text[text.index(before: at)].isWhitespace { return nil }   // e-mail addresses
        let q = String(text[text.index(after: at)...])
        return q.contains(where: { $0.isWhitespace }) || q.count > 40 ? nil : q
    }

    /// Files under `folder` whose name contains `q` (depth ≤ 6, skips hidden folders, build output, node_modules).
    static func files(in folder: String, matching q: String) -> [String] {
        guard folder != NSHomeDirectory() else { return [] }   // only real project folders
        let fm = FileManager.default
        guard let e = fm.enumerator(at: URL(fileURLWithPath: folder), includingPropertiesForKeys: [.isDirectoryKey],
                                    options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { return [] }
        var out: [String] = []
        let skip: Set<String> = ["node_modules", "build", "build-ios", "DerivedData", ".build", "Pods", "dist"]
        var seen = 0
        for case let url as URL in e {
            seen += 1
            if seen > 8000 || out.count >= 20 { break }
            if skip.contains(url.lastPathComponent) || e.level > 6 { e.skipDescendants(); continue }
            if (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true { continue }
            if q.isEmpty || url.lastPathComponent.localizedCaseInsensitiveContains(q) { out.append(url.path) }
        }
        return out
    }
}
