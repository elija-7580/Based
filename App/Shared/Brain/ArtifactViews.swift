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
        }
    }

    var kindLabel: String {
        switch kind {
        case .html: return "Web page"
        case .svg: return "SVG"
        case .mermaid: return "Diagram"
        case .react: return "React component"
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
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentColor.opacity(0.12)))
                    .foregroundStyle(Color.accentColor)
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
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(open ? Color.accentColor.opacity(0.6) : Color(Theme.divider)))
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
                Image(systemName: artifact.symbol).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 0) {
                    Text(artifact.title).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    Text(artifact.kindLabel).font(.system(size: 11)).foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 8)
                Picker("", selection: $showCode) {
                    Text("Preview").tag(false)
                    Text("Code").tag(true)
                }
                .pickerStyle(.segmented).labelsHidden().fixedSize().controlSize(.small)
                Menu {
                    Button("Copy code", systemImage: "doc.on.doc") { copy() }
                    Button("Save as page", systemImage: "doc.badge.plus") { saveAsPage() }
                    Button("Export as HTML…", systemImage: "square.and.arrow.up") { exporting = true }
                    Button("Reload preview", systemImage: "arrow.clockwise") { reload = UUID() }
                } label: { Image(systemName: copied ? "checkmark" : "ellipsis") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
                Button { brain.artifact = nil } label: { Image(systemName: "xmark") }
                    .buttonStyle(.plain)
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
                } else {
                    WebContentView(html: artifact.previewDocument, onHeight: { _ in })
                        .id(reload)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(.background)
        .fileExporter(isPresented: $exporting, document: TextDocument(text: artifact.kind == .mermaid ? artifact.previewDocument : artifact.document),
                      contentType: .html, defaultFilename: MarkdownExporter.fileName(artifact.title) + ".html") { _ in }
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
