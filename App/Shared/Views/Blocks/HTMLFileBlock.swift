import SwiftUI
import WebKit
import BasedCore
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#endif

/// An uploaded `.html` / `.htm` file rendered inline, like Notion's HTML embeds.
///
/// The file is loaded as a string into an isolated web view (`loadHTMLString` with no base URL and a
/// non-persistent data store): scripts run, but the document has an opaque origin, no access to the
/// app, other assets or local storage, and links open in the default browser. The block grows with its
/// content up to a draggable maximum height (stored in `props.height`); longer content scrolls inside.
struct HTMLFileBlockView: View {
    let block: Block
    let url: URL
    let editor: EditorController
    var onReplace: () -> Void
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    @State private var source: String?
    @State private var loadFailed = false
    @State private var reported: CGFloat?
    @State private var dragHeight: CGFloat?
    @State private var hovering = false
    @State private var fullScreen = false

    static let defaultMaxHeight: CGFloat = 1200
    static let maxBytes = 8_000_000

    static func isHTML(_ block: Block, url: URL?) -> Bool {
        if block.props.asset?.mime == "text/html" { return true }
        let name = block.props.asset?.name ?? url?.lastPathComponent ?? ""
        return ["html", "htm"].contains((name as NSString).pathExtension.lowercased())
    }

    private var locked: Bool { editor.isLocked }
    private var fileName: String { block.props.asset?.name ?? url.lastPathComponent }
    private var maxHeight: CGFloat { dragHeight ?? block.props.height.map { CGFloat($0) } ?? Self.defaultMaxHeight }

    var body: some View {
        let height = min(reported ?? 320, maxHeight)
        content
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .clipShape(RoundedRectangle(cornerRadius: 4))
            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Color(Theme.divider)))
            .overlay(alignment: .topTrailing) { if hovering { menu } }
            .overlay(alignment: .bottom) { if hovering, !locked { resizeHandle(height) } }
            .onHover { hovering = $0 }
            .task(id: url) { load() }
            .sheet(isPresented: $fullScreen) { fullScreenView }
            .accessibilityIdentifier("html.embed")
    }

    @ViewBuilder
    private var content: some View {
        if let source {
            WebContentView(html: HTMLPreview.document(source: source, language: "html"), onHeight: { h in
                if h > 40, abs((reported ?? 0) - h) > 2 { reported = min(h, 20_000) }
            })
        } else if loadFailed {
            Label("Can't read \(fileName)", systemImage: "exclamationmark.triangle")
                .foregroundStyle(Theme.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func load() {
        guard let data = try? Data(contentsOf: url), data.count <= Self.maxBytes else { loadFailed = true; return }
        source = String(data: data, encoding: .utf8) ?? String(data: data, encoding: .isoLatin1)
        loadFailed = source == nil
    }

    private var menu: some View {
        Menu {
            Button("Open in full screen", systemImage: "arrow.up.left.and.arrow.down.right") { fullScreen = true }
            Button("Open as file", systemImage: "arrow.up.forward.app") { openAsFile() }
            #if os(macOS)
            Button("Download", systemImage: "arrow.down.circle") { download() }
            #else
            ShareLink(item: url) { Label("Download", systemImage: "arrow.down.circle") }
            #endif
            if !locked {
                Divider()
                Button("Replace", systemImage: "arrow.triangle.2.circlepath") { onReplace() }
                Button("Delete", systemImage: "trash", role: .destructive) { model.store.deleteBlocks([block.id]) }
            }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold))
                .frame(width: 26, height: 22)
                .background(RoundedRectangle(cornerRadius: 4).fill(.regularMaterial))
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .padding(6)
        .accessibilityIdentifier("html.embed.menu")
    }

    private func resizeHandle(_ height: CGFloat) -> some View {
        Capsule()
            .fill(Color.black.opacity(0.45))
            .frame(width: 44, height: 6)
            .padding(.bottom, 4)
            .opacity(0.8)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { v in dragHeight = max(120, min(4000, height + v.translation.height)) }
                    .onEnded { _ in
                        if let h = dragHeight {
                            model.store.updateBlock(block.id, name: "Resize embed") { $0.props.height = Double(h) }
                        }
                        dragHeight = nil
                    }
            )
            .help("Drag to change the maximum height")
    }

    private var fullScreenView: some View {
        VStack(spacing: 0) {
            HStack {
                Text(fileName).font(.system(size: 13, weight: .semibold)).lineLimit(1)
                Spacer()
                Button("Done") { fullScreen = false }.keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            if let source {
                WebContentView(html: HTMLPreview.document(source: source, language: "html"), onHeight: { _ in })
            } else {
                Spacer()
            }
        }
        #if os(macOS)
        .frame(minWidth: 960, idealWidth: 1200, minHeight: 680, idealHeight: 860)
        #endif
    }

    private func openAsFile() {
        #if os(macOS)
        NSWorkspace.shared.open(url)
        #else
        openURL(url)
        #endif
    }

    #if os(macOS)
    private func download() {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = fileName
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        try? FileManager.default.removeItem(at: dest)
        try? FileManager.default.copyItem(at: url, to: dest)
    }
    #endif
}

/// Files dropped onto a page (from Finder / Files) become media blocks; HTML files become inline embeds.
enum FileDrop {
    @MainActor
    static func insert(_ providers: [NSItemProvider], into pageID: RecordID, after anchor: RecordID?, model: AppModel) -> Bool {
        let fileProviders = providers.filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }
        guard !fileProviders.isEmpty else { return false }
        let collector = URLCollector(count: fileProviders.count) { urls in
            Task { @MainActor in place(urls, into: pageID, after: anchor, model: model) }
        }
        for (i, p) in fileProviders.enumerated() {
            p.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                var url: URL?
                if let d = item as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
                else if let u = item as? URL { url = u }
                collector.set(i, url)
            }
        }
        return true
    }

    static func blockType(forMime mime: String?, name: String) -> BlockType {
        let m = mime ?? FileAssetStore.mime(for: (name as NSString).pathExtension) ?? ""
        if m == "text/html" { return .embed }
        if m == "application/pdf" { return .pdf }
        if m.hasPrefix("image/") { return .image }
        if m.hasPrefix("video/") { return .video }
        if m.hasPrefix("audio/") { return .audio }
        return .file
    }

    @MainActor
    private static func place(_ urls: [URL], into pageID: RecordID, after anchor: RecordID?, model: AppModel) {
        let store = model.store
        // Only anchor on a block that lives directly on this page; otherwise append at the end.
        var last: RecordID? = anchor.flatMap { id in store.blocks[id]?.parent == .block(pageID) ? id : nil }
        for url in urls {
            guard let ref = AssetImport.importFile(url, into: model.assets) else { continue }
            var props = BlockProps()
            props.asset = ref
            let type = blockType(forMime: ref.mime, name: ref.name)
            if let a = last, let id = store.insertBlock(type, after: a, props: props) {
                last = id
            } else {
                last = store.insertBlock(type, props: props, in: .block(pageID), at: .end, name: "Add file")
            }
        }
    }

    /// Collects asynchronously loaded URLs in their original order and fires once all have arrived.
    private final class URLCollector: @unchecked Sendable {
        private let lock = NSLock()
        private var slots: [URL?]
        private var remaining: Int
        private let done: @Sendable ([URL]) -> Void
        init(count: Int, done: @escaping @Sendable ([URL]) -> Void) {
            slots = Array(repeating: nil, count: count); remaining = count; self.done = done
        }
        func set(_ i: Int, _ url: URL?) {
            lock.lock()
            slots[i] = url; remaining -= 1
            let finished = remaining == 0
            let result = slots.compactMap { $0 }
            lock.unlock()
            if finished { done(result) }
        }
    }
}
