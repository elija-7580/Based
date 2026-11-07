import SwiftUI
import UniformTypeIdentifiers
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#else
import UIKit
#endif

// Claude-style artifacts in Based: an answer's HTML page, SVG, Mermaid diagram or React component shows up as a
// card in the reply and opens in a panel next to the chat (live preview / code, copy, save as page, export).

extension ChatArtifact {
    var symbol: String {
        switch kind {
        case .html: return "safari"
        case .svg: return "photo"
        case .mermaid: return "point.3.connected.trianglepath.dotted"
        case .react: return "atom"
        case .markdown: return "doc.richtext"
        }
    }

    var kindLabel: String {
        switch kind {
        case .html: return "Web page"
        case .svg: return "SVG"
        case .mermaid: return "Diagram"
        case .react: return "React component"
        case .markdown: return "Document"
        }
    }

    /// Document for the web view (Mermaid goes through the same renderer as Mermaid blocks).
    var previewDocument: String {
        kind == .mermaid ? HTMLPreview.document(source: source, language: "mermaid") : document
    }
}

/// Inline card in the answer: icon, title, kind; click opens the panel.
struct ArtifactCardView: View {
    let artifact: ChatArtifact
    @Environment(BrainModel.self) private var brain
    @State private var hover = false

    var body: some View {
        let open = brain.artifact?.id == artifact.id
        Button { brain.artifact = open ? nil : artifact } label: {
            HStack(spacing: 12) {
                Image(systemName: artifact.symbol)
                    .font(.system(size: 16))
                    .frame(width: 38, height: 38)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Theme.accentBlue.opacity(0.12)))
                    .foregroundStyle(Theme.accentBlue)
                VStack(alignment: .leading, spacing: 2) {
                    Text(artifact.title).font(.system(size: 13.5, weight: .semibold)).lineLimit(1)
                    Text(open ? "\(artifact.kindLabel) · open" : "\(artifact.kindLabel) · Click to open")
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: open ? "sidebar.right" : "arrow.up.right").font(.system(size: 12)).foregroundStyle(Theme.secondary)
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12).fill(hover || open ? Color.primary.opacity(0.05) : Color.primary.opacity(0.025)))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(open ? Theme.accentBlue.opacity(0.6) : Color(Theme.divider)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityIdentifier("chat.artifact")
    }
}

/// The panel: header (title, Preview | Code, copy, save as page, export, close) and the live preview or source.
struct ArtifactPanel: View {
    let artifact: ChatArtifact
    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brain
    @State private var showCode = false
    @State private var copied = false
    @State private var exporting = false
    @State private var reload = UUID()

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: artifact.symbol).foregroundStyle(Theme.accentBlue)
                VStack(alignment: .leading, spacing: 0) {
                    Text(artifact.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(artifact.kindLabel).font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 8)
                Picker("", selection: $showCode) {
                    Text(artifact.kind == .markdown ? "Document" : "Preview").tag(false)
                    Text(artifact.kind == .markdown ? "Markdown" : "Code").tag(true)
                }
                .pickerStyle(.segmented).labelsHidden().fixedSize().controlSize(.small)
                Menu {
                    Button("Copy code", systemImage: "doc.on.doc") { copy() }
                    Button("Save as page", systemImage: "doc.badge.plus") { saveAsPage() }
                    Button(artifact.kind == .markdown ? "Export as Markdown…" : "Export as HTML…", systemImage: "square.and.arrow.up") { exporting = true }
                    Button("Reload preview", systemImage: "arrow.clockwise") { reload = UUID() }
                } label: { Image(systemName: copied ? "checkmark" : "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                Button { brain.artifact = nil } label: { Image(systemName: "xmark") }
                    .buttonStyle(.quiet)
                    .help("Close")
                    .accessibilityIdentifier("artifact.close")
            }
            .foregroundStyle(Theme.primary)
            .padding(.horizontal, 14)
            .frame(height: 46)
            Divider()
            Group {
                if showCode {
                    ScrollView([.vertical, .horizontal]) {
                        Text(artifact.source)
                            .font(.system(size: 12, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                    }
                } else if artifact.kind == .markdown {
                    // A document reads like a page: comfortable width and type, scrolls on its own.
                    ScrollView {
                        MarkdownMessageView(markdown: artifact.source)
                            .frame(maxWidth: 680, alignment: .leading)
                            .padding(.horizontal, 28).padding(.vertical, 24)
                            .frame(maxWidth: .infinity)
                    }
                } else {
                    WebContentView(html: artifact.previewDocument, onHeight: { _ in })
                        .id(reload)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(.background)
        .fileExporter(isPresented: $exporting, document: TextDocument(text: artifact.kind == .mermaid ? artifact.previewDocument : artifact.document),
                      contentType: artifact.kind == .markdown ? (UTType(filenameExtension: "md") ?? .plainText) : .html,
                      defaultFilename: MarkdownExporter.fileName(artifact.title) + (artifact.kind == .markdown ? ".md" : ".html")) { _ in }
        .accessibilityIdentifier("artifact.panel")
    }

    private func copy() {
        Clipboard.copy(artifact.source)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { copied = false }
    }

    /// New page with the artifact as a live HTML / Mermaid block (Preview on).
    private func saveAsPage() {
        let store = model.store
        if artifact.kind == .markdown {
            let page = store.createPage(title: RichText(artifact.title), icon: .emoji("📄"))
            var body = MarkdownImporter().parse(artifact.source)
            // The first heading became the title.
            if let first = body.first, first.type.isHeading, first.text.plainText == artifact.title { body.removeFirst() }
            store.insertImported(body, in: .block(page), name: "Save document")
            model.showToast("Saved “\(artifact.title)” as a page")
            model.openInNewTab(page, activate: false)
            return
        }
        let page = store.createPage(title: RichText(artifact.title), icon: .emoji(artifact.kind == .mermaid ? "🧭" : "✨"))
        var props = BlockProps()
        props.language = artifact.kind == .mermaid ? "mermaid" : "html"
        props.url = "preview"
        let code = artifact.kind == .mermaid || artifact.kind == .html ? artifact.source : artifact.document
        store.insertBlock(.code, text: RichText(code), props: props, in: .block(page))
        model.showToast("Saved “\(artifact.title)” as a page")
        model.openInNewTab(page, activate: false)
    }
}

// MARK: - Tool images (browser screenshots)

/// Latest image a tool returned (browser / computer use screenshots), click to enlarge.
struct ToolImageStrip: View {
    let images: [Data]
    @State private var large = false

    var body: some View {
        if let data = images.last, let image = Self.image(data) {
            image
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity, maxHeight: large ? 640 : 200, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color(Theme.divider)))
                .overlay(alignment: .bottomTrailing) {
                    if images.count > 1 {
                        Text("\(images.count) screenshots").font(.system(size: 10.5, weight: .medium))
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(.regularMaterial)).padding(6)
                    }
                }
                .onTapGesture { withAnimation(.easeOut(duration: 0.15)) { large.toggle() } }
                .help(large ? "Smaller" : "Larger")
                .padding(.horizontal, 10).padding(.bottom, 8)
                .accessibilityIdentifier("tool.screenshot")
        }
    }

    static func image(_ data: Data) -> Image? {
        #if os(macOS)
        return NSImage(data: data).map { Image(nsImage: $0) }
        #else
        return UIImage(data: data).map { Image(uiImage: $0) }
        #endif
    }
}


// MARK: - Pages the agent created or edited

/// Cards under an answer for every workspace page its tools created or changed (Claude-style "documents"):
/// icon, title and what happened; click opens the page (⌘-click in a new tab).
struct TouchedPagesCard: View {
    let parts: [ChatPart]
    @Environment(AppModel.self) private var model

    struct Touched: Identifiable { let id: RecordID; let created: Bool }

    static let writeTools = ["create_page", "append_markdown", "replace_page_content", "update_page", "find_replace", "add_row",
                             "update_row", "create_database", "update_database", "duplicate_page", "add_html", "add_mermaid",
                             "create_chart", "create_view", "update_view", "add_button", "move_page"]
    static let creating = ["create_page", "add_row", "create_database", "duplicate_page"]
    private static let uuid = try! NSRegularExpression(pattern: "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")

    static func touched(_ parts: [ChatPart], store: WorkspaceStore) -> [Touched] {
        var out: [Touched] = []
        var seen = Set<RecordID>()
        for p in parts where p.kind == .tool && p.status == .done {
            let name = p.toolName
            guard let tool = writeTools.first(where: { name == $0 || name.hasSuffix("__" + $0) }) else { continue }
            let text = (p.output ?? "") + " " + p.detail
            for m in uuid.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                guard let r = Range(m.range, in: text) else { continue }
                var id = String(text[r])
                if store.blocks[id] == nil, let db = store.databases[id] { id = db.blockID }
                guard let b = store.blocks[id], b.type.isPageLike, b.trashedAt == nil, seen.insert(id).inserted else { continue }
                out.append(Touched(id: id, created: creating.contains(tool)))
            }
        }
        return out
    }

    var body: some View {
        let items = Self.touched(parts, store: model.store)
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(items.prefix(8)) { t in PageResultRow(id: t.id, created: t.created) }
                if items.count > 8 {
                    Text("+\(items.count - 8) more pages").font(.system(size: 11.5)).foregroundStyle(Theme.secondary)
                }
            }
        }
    }
}

private struct PageResultRow: View {
    let id: RecordID
    let created: Bool
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let store = model.store
        let isDB = store.blocks[id]?.type == .databasePage
        Button {
            #if os(macOS)
            if NSEvent.modifierFlags.contains(.command) { model.openInNewTab(id, activate: false); return }
            #endif
            model.open(id)
        } label: {
            HStack(spacing: 10) {
                PageIconView(icon: store.icon(of: id), isDatabase: isDB, size: 18)
                    .frame(width: 34, height: 34)
                    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.primary.opacity(0.05)))
                VStack(alignment: .leading, spacing: 1) {
                    Text(store.title(of: id).isEmpty ? "Untitled" : store.title(of: id))
                        .font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.primary).lineLimit(1)
                    Text((created ? "Created" : "Edited") + " · " + (isDB ? "Database" : store.database(ofRow: id) != nil ? "Database page" : "Page"))
                        .font(.system(size: 12)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
                    .opacity(hover ? 1 : 0.5)
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(hover ? 0.05 : 0.025)))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Color(Theme.divider)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickableCursor()
        .onHover { hover = $0 }
        .help("Open page (⌘-click: new tab)")
        .accessibilityIdentifier("chat.pageResult")
    }
}
