import SwiftUI
import BasedCore

#if os(macOS)
/// Notion's floating formatting toolbar over a text selection: Ask AI · Turn into · B I U S <> · link · colour.
struct FormatToolbar: View {
    let editor: EditorController
    let blockID: RecordID
    @Environment(AppModel.self) private var model
    @State private var colors = false
    @State private var turn = false

    var body: some View {
        HStack(spacing: 0) {
            ToolbarButton(help: "Ask AI about the selection") {
                HStack(spacing: 4) { AIGlyph(size: 13, vivid: true); Text("Ask AI").font(DS.Text.body(.medium)) }
                    .padding(.horizontal, DS.Space.xs)
            } action: { askAI() }
            divider
            ToolbarButton(help: "Turn into") {
                HStack(spacing: 2) {
                    Text(model.store.blocks[blockID]?.type.displayName ?? "Text").font(DS.Text.body())
                    Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold))
                }.padding(.horizontal, DS.Space.xs)
            } action: { turn.toggle() }
            .panelPopover(isPresented: $turn, arrowEdge: .bottom) {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(TurnIntoOptions.types, id: \.self) { t in
                        PanelActionRow(title: t.displayName, symbol: t.symbol) { turn = false; editor.turnTargets(into: t) }
                    }
                }
                .padding(DS.Space.sm).frame(width: 220)
            }
            divider
            mark(.bold, "bold", "Bold ⌘B")
            mark(.italic, "italic", "Italic ⌘I")
            mark(.underline, "underline", "Underline ⌘U")
            mark(.strikethrough, "strikethrough", "Strikethrough ⌘⇧S")
            mark(.code, "chevron.left.forwardslash.chevron.right", "Inline code ⌘E")
            divider
            ToolbarButton(help: "Link ⌘K") { Image(systemName: "link").font(DS.Text.body()) } action: { editor.beginLinkEditing() }
            ToolbarButton(help: "Colour") {
                Text("A").font(DS.Text.ui(.semibold)).underline()
            } action: { colors.toggle() }
            .panelPopover(isPresented: $colors, arrowEdge: .bottom) { colorMenu }
        }
        .padding(3)
        .frame(height: 36)
        .background(RoundedRectangle(cornerRadius: DS.Radius.card).fill(.background))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.card).stroke(Theme.dividerColor))
        .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
        .fixedSize()
        .accessibilityIdentifier("format.toolbar")
    }

    private var divider: some View { Rectangle().fill(Theme.dividerColor).frame(width: 1, height: 20).padding(.horizontal, DS.Space.xxs) }

    private func mark(_ kind: MarkKind, _ symbol: String, _ help: String) -> some View {
        ToolbarButton(help: help) { Image(systemName: symbol).font(DS.Text.body(.medium)) } action: { editor.toggleMark(kind) }
    }

    private var colorMenu: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 1) {
                SectionLabel("Text colour")
                ForEach(TColor.textColors, id: \.self) { c in
                    PanelActionRow(title: c.displayName, symbol: "character") { colors = false; editor.setTextColor(c) }
                        .foregroundStyle(Theme.color(c))
                }
                SectionLabel("Background colour")
                ForEach(TColor.backgroundColors, id: \.self) { c in
                    PanelActionRow(title: c.displayName, symbol: "a.square.fill") { colors = false; editor.setTextColor(c) }
                }
            }
            .padding(DS.Space.sm)
        }
        .frame(width: 220, height: 380)
    }

    /// Opens the AI panel with the selected text quoted, ready for an instruction.
    private func askAI() {
        guard let h = editor.host(blockID), let b = model.store.blocks[blockID] else { return }
        let r = h.selectedRange()
        let text = (b.text.plainText as NSString).substring(with: NSRange(location: r.location, length: min(r.length, (b.text.plainText as NSString).length - r.location)))
        model.chatDraft = "> " + text.replacingOccurrences(of: "\n", with: "\n> ") + "\n\n"
        model.showChatPanel = true
    }
}

private struct ToolbarButton<Label: View>: View {
    let help: String
    @ViewBuilder let label: () -> Label
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            label()
                .foregroundStyle(Theme.primary)
                .frame(minWidth: 28, minHeight: 28)
                .background(RoundedRectangle(cornerRadius: 5).fill(hover ? Theme.hoverFill : .clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .help(help)
    }
}
#endif
