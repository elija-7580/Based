import SwiftUI
import BasedCore
import BasedBrain

/// Notion's inline AI: space on an empty line → "Ask AI to write…". The answer appears as a preview under the
/// line with Insert / Try again / Discard; Insert turns the Markdown into blocks right there.
struct InlineAIBox: View {
    let editor: EditorController
    let blockID: RecordID
    @Environment(AppModel.self) private var model
    @State private var prompt = ""
    @State private var phase: Phase = .asking
    @FocusState private var focused: Bool

    enum Phase: Equatable { case asking, writing, result(String), failed(String) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if case .result(let md) = phase {
                ScrollView {
                    MarkdownMessageView(markdown: md, streaming: false)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 320)
                Divider()
            }
            HStack(spacing: 8) {
                AIGlyph(size: 15, vivid: true)
                    .symbolEffectPulse(phase == .writing)
                switch phase {
                case .writing:
                    ShimmerText(text: "Writing…").font(.system(size: 14))
                    Spacer()
                    Button("Stop") { close() }.buttonStyle(PillButtonStyle())
                case .result:
                    Text("Insert below?").font(.system(size: 13)).foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Discard") { close() }.buttonStyle(PillButtonStyle()).keyboardShortcut(.cancelAction)
                    Button("Try again") { run() }.buttonStyle(PillButtonStyle())
                    Button("Insert") { insert() }.buttonStyle(PillButtonStyle(prominent: true)).keyboardShortcut(.defaultAction)
                case .failed(let msg):
                    Text(msg).font(.system(size: 12.5)).foregroundStyle(.red).lineLimit(2)
                    Spacer()
                    Button("Close") { close() }.buttonStyle(PillButtonStyle())
                case .asking:
                    TextField("Ask AI to write…", text: $prompt)
                        .textFieldStyle(.plain)
                        .font(.system(size: 14))
                        .focused($focused)
                        .onSubmit(run)
                        .onKeyPress(.escape) { close(); return .handled }
                    Text(model.brain.chatEngine).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.dividerColor))
        .shadow(color: .black.opacity(0.16), radius: 14, y: 5)
        .animation(.spring(response: 0.3, dampingFraction: 0.88), value: phase)
        .onAppear { focused = true }
        .accessibilityIdentifier("inline.ai")
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugInlineAI)) { n in
            if let p = n.userInfo?["prompt"] as? String { prompt = p; run() }
            if n.userInfo?["insert"] != nil { insert() }
        }
        #endif
    }

    private func run() {
        let ask = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !ask.isEmpty else { close(); return }
        phase = .writing
        let page = editor.pageID
        Task {
            do {
                let md = try await model.brain.write(ask, pageID: page)
                guard editor.aiPrompt == blockID else { return }   // closed meanwhile
                phase = md.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? .failed("No answer.") : .result(md)
            } catch {
                guard editor.aiPrompt == blockID else { return }
                phase = .failed("\(error)")
            }
        }
    }

    private func insert() {
        guard case .result(let md) = phase, let b = model.store.blocks[blockID] else { close(); return }
        let items = MarkdownImporter().parse(md)
        let ids = model.store.insertImported(items, in: b.parent, at: .after(blockID), name: "AI")
        // The empty trigger line goes away (Notion replaces it with the answer).
        if b.text.isEmpty { model.store.deleteBlocks([blockID]) }
        editor.aiPrompt = nil
        if let last = ids.last { editor.focusEnd(last) }
    }

    private func close() {
        editor.aiPrompt = nil
        editor.focus(FocusTarget(blockID, 0))
    }
}

#if DEBUG
extension Notification.Name { static let debugInlineAI = Notification.Name("based.debug.inlineAI") }
#endif
