#if DEBUG && os(macOS)
import AppKit
import SwiftUI
import BasedCore
import BasedBrain

/// Debug-only remote control through `based://debug/...` URLs, so the UI can be checked without a person at
/// the screen (e.g. `open -g "based://debug/snapshot?out=/tmp/a.png"`). Snapshots are drawn by the app itself
/// (`cacheDisplay`), so they also work while the screen is locked or the window is in the background.
///
/// Commands:
/// - `snapshot?out=<png>`              the key/main window
/// - `open?id=<pageID>` / `open?title=<text>`
/// - `go?to=home|library|settings|brain|projects|inbox|chat|trash`
/// - `chat?panel=1|0`                  ⌘J panel
/// - `newpage?title=<t>&cover=1&icon=1&md=<markdown>`  creates a page (Markdown body) and opens it
/// - `pages?out=<txt>`                 id ⟶ title list of all pages
/// - `size?w=<w>&h=<h>`                resize the main window
/// - `appearance?mode=light|dark`
@MainActor
enum DebugDriver {
    static func handle(_ url: URL, model: AppModel) -> Bool {
        guard url.scheme == "based", url.host == "debug" else { return false }
        let cmd = url.lastPathComponent
        let q = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? [])
            .map { ($0.name, $0.value ?? "") })
        Log.notice("debug: \(cmd) \(q)", category: "debug")
        switch cmd {
        case "snapshot":
            let out = q["out"] ?? NSTemporaryDirectory() + "based-snapshot.png"
            // Let SwiftUI settle (animations, async layout) before drawing.
            DispatchQueue.main.asyncAfter(deadline: .now() + (Double(q["delay"] ?? "") ?? 0.6)) { snapshot(to: out) }
        case "open":
            if let id = q["id"] { model.open(id) }
            else if let t = q["title"]?.lowercased(),
                    let id = model.store.blocks.values.first(where: { $0.type == .page && $0.text.plainText.lowercased() == t })?.id {
                model.open(id)
            }
        case "go":
            switch q["to"] {
            case "home": model.selection = .home
            case "library": model.selection = .library
            case "settings": model.selection = .settings
            case "brain": model.selection = .brain
            case "projects": model.selection = .projects
            case "inbox": model.selection = .inbox
            case "sessions": model.selection = .sessions
            case "trash": model.selection = .trash
            case "chat": model.openChat(q["id"], fullPage: true)
            default: break
            }
        case "engine":
            let kind = ChatEngineSpec.Kind(rawValue: q["kind"] ?? "auto") ?? .auto
            model.brain.engineSpec = ChatEngineSpec(kind: kind, model: q["model"] ?? "", effort: q["effort"] ?? "", permission: q["permission"] ?? "")
        case "ask":
            model.brain.ask(q["text"] ?? "hi", pageContext: nil)
        case "chat":
            model.showChatPanel = q["panel"] != "0"
        case "newpage":
            let id = model.store.createPage(title: RichText(q["title"] ?? "Debug page"))
            if q["cover"] == "1" { model.store.setPageCover(id, .gradient(2)) }
            if q["icon"] == "1" { model.store.setPageIcon(id, .emoji("🧪")) }
            if let md = q["md"], !md.isEmpty {
                model.store.insertImported(MarkdownImporter().parse(md), in: .block(id), name: "Debug")
            }
            model.open(id)
        case "pages":
            let out = q["out"] ?? NSTemporaryDirectory() + "based-pages.txt"
            let lines = model.store.blocks.values
                .filter { $0.type == .page || $0.type == .databasePage }
                .map { "\($0.id)\t\($0.text.plainText)" }
                .sorted { $0.split(separator: "\t").last ?? "" < $1.split(separator: "\t").last ?? "" }
            try? lines.joined(separator: "\n").write(toFile: out, atomically: true, encoding: .utf8)
        case "size":
            if let w = Double(q["w"] ?? ""), let h = Double(q["h"] ?? ""), let win = mainWindow() {
                var f = win.frame
                f.origin.y += f.height - h
                f.size = NSSize(width: w, height: h)
                win.setFrame(f, display: true)
            }
        case "appearance":
            NSApp.appearance = q["mode"] == "dark" ? NSAppearance(named: .darkAqua) : NSAppearance(named: .aqua)
        default:
            return true
        }
        return true
    }

    static func mainWindow() -> NSWindow? {
        NSApp.keyWindow ?? NSApp.mainWindow ?? NSApp.windows.first { $0.isVisible && $0.contentView != nil && !$0.isSheet }
    }

    static func snapshot(to path: String) {
        guard let win = mainWindow(), let view = win.contentView?.superview ?? win.contentView else {
            Log.error("debug snapshot: no window", category: "debug")
            return
        }
        view.layoutSubtreeIfNeeded()
        let bounds = view.bounds
        guard let rep = view.bitmapImageRepForCachingDisplay(in: bounds) else { return }
        view.cacheDisplay(in: bounds, to: rep)
        // Also draw overlay child windows (popovers, menus) that sit above the main window.
        let image = NSImage(size: bounds.size)
        image.addRepresentation(rep)
        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: URL(fileURLWithPath: path))
            Log.notice("debug snapshot → \(path)", category: "debug")
        }
        // Child windows (popovers) separately, so menus can be checked too.
        for (i, child) in (win.childWindows ?? []).enumerated() {
            guard let cv = child.contentView?.superview ?? child.contentView,
                  let r = cv.bitmapImageRepForCachingDisplay(in: cv.bounds) else { continue }
            cv.cacheDisplay(in: cv.bounds, to: r)
            let p = path.replacingOccurrences(of: ".png", with: "-child\(i).png")
            try? r.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: p))
        }
    }
}
#endif
