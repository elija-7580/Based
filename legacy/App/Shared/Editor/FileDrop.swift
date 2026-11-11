import SwiftUI
import UniformTypeIdentifiers
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Dragging files from Finder (or pasting copied files) into Based, like Notion:
/// - onto a page: images, PDFs, video and audio become media blocks, anything else a file block;
///   documents (Markdown, HTML, CSV, Notion export .zip, folders) are imported as sub-pages of that page,
/// - onto the sidebar / a screen without a page: documents are imported at the top level.
enum FileDrop {
    enum Kind: Equatable { case media(BlockType), document, file }

    static let imageExt: Set<String> = ["png", "jpg", "jpeg", "gif", "heic", "heif", "webp", "tif", "tiff", "bmp", "svg"]
    static let videoExt: Set<String> = ["mov", "mp4", "m4v", "webm"]
    static let audioExt: Set<String> = ["mp3", "m4a", "wav", "aif", "aiff", "aac", "flac", "ogg"]
    static let documentExt: Set<String> = ["md", "markdown", "txt", "html", "htm", "csv", "zip"]

    static func kind(of url: URL) -> Kind {
        if url.hasDirectoryPath { return .document }
        let ext = url.pathExtension.lowercased()
        if imageExt.contains(ext) { return .media(.image) }
        if ext == "pdf" { return .media(.pdf) }
        if videoExt.contains(ext) { return .media(.video) }
        if audioExt.contains(ext) { return .media(.audio) }
        if documentExt.contains(ext) { return .document }
        return .file
    }

    /// Reads file URLs from drop providers (SwiftUI `onDrop(of: [.fileURL])`).
    static func loadURLs(_ providers: [NSItemProvider], _ done: @escaping @MainActor ([URL]) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var urls: [URL] = []
        for p in providers where p.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
            group.enter()
            p.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                var url: URL?
                if let d = item as? Data { url = URL(dataRepresentation: d, relativeTo: nil) }
                else if let u = item as? URL { url = u }
                if let url { lock.lock(); urls.append(url); lock.unlock() }
                group.leave()
            }
        }
        group.notify(queue: .main) { MainActor.assumeIsolated { done(urls) } }
    }

    #if os(macOS)
    /// File URLs on a pasteboard (Finder drag or ⌘C on files).
    static func fileURLs(on pb: NSPasteboard) -> [URL] {
        (pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]) ?? []
    }
    #endif
}

extension AppModel {
    /// Drop / paste files into a page, after `blockID` (nil = at the end).
    func dropFiles(_ urls: [URL], onto pageID: RecordID, after blockID: RecordID? = nil) {
        guard !urls.isEmpty, store.blocks[pageID] != nil else { return }
        var documents: [URL] = []
        var anchor = blockID
        let parent: ParentRef = anchor.flatMap { store.blocks[$0]?.parent } ?? .block(pageID)
        for url in urls {
            let k = FileDrop.kind(of: url)
            if k == .document { documents.append(url); continue }
            guard let ref = AssetImport.importFile(url, into: assets) else {
                errorMessage = "Couldn't add “\(url.lastPathComponent)”."
                continue
            }
            var props = BlockProps()
            props.asset = ref
            let type: BlockType
            if case .media(let t) = k { type = t } else { type = .file }
            let id = store.insertBlock(type, props: props, in: parent, at: anchor.map { .after($0) } ?? .end, name: "Add \(type.displayName.lowercased())")
            anchor = id
        }
        if !documents.isEmpty { pendingImport = PendingImport(urls: documents, parent: .block(pageID)) }
        Log.notice("dropped \(urls.count) file(s) onto page", category: "import")
    }

    /// Drop onto the sidebar or a non-page screen: import documents at the top level; media go to the open page
    /// if there is one, otherwise each becomes a new page holding it.
    func dropFilesOnWorkspace(_ urls: [URL], intoOpenPage: Bool = true) {
        guard !urls.isEmpty else { return }
        if intoOpenPage, let page = currentPageID { dropFiles(urls, onto: page); return }
        let docs = urls.filter { FileDrop.kind(of: $0) == .document }
        let other = urls.filter { FileDrop.kind(of: $0) != .document }
        if !docs.isEmpty { pendingImport = PendingImport(urls: docs, parent: .workspace) }
        for url in other {
            let page = store.createPage(title: RichText(url.deletingPathExtension().lastPathComponent))
            dropFiles([url], onto: page)
            if url == other.last { open(page) }
        }
    }
}

/// Makes a view accept files from Finder.
struct FileDropModifier: ViewModifier {
    let onDrop: ([URL]) -> Void
    @State private var targeted = false

    func body(content: Content) -> some View {
        content
            .onDrop(of: [.fileURL], isTargeted: $targeted) { providers in
                FileDrop.loadURLs(providers) { onDrop($0) }
                return true
            }
            .overlay {
                if targeted {
                    RoundedRectangle(cornerRadius: DS.Radius.card).stroke(Theme.accentBlue, lineWidth: 2)
                        .background(Theme.accentBlue.opacity(0.06))
                        .allowsHitTesting(false)
                }
            }
    }
}

extension View {
    func acceptsFileDrops(_ onDrop: @escaping ([URL]) -> Void) -> some View { modifier(FileDropModifier(onDrop: onDrop)) }
}
