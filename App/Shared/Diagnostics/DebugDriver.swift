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
        case "hover":
            // Shows the gutter handle of the n-th block of the open page (document order).
            if let ed = model.activeEditor {
                let ids = model.store.documentOrder(Array(ed.gutter.allFrames.keys))
                let i = Int(q["index"] ?? "0") ?? 0
                if ids.indices.contains(i) { ed.gutter.hovered = ids[i]; if q["pin"] == "1" { ed.gutter.menuFor = ids[i] } }
                Log.notice("debug hover: \(ids.count) frames, hovered \(ed.gutter.hovered ?? "-")", category: "debug")
                if let out = q["out"] {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        Log.notice("debug hover at snapshot: \(ed.gutter.hovered ?? "-") editor \(ObjectIdentifier(ed).hashValue) frame \(ed.gutter.hovered.flatMap { ed.gutter.frame(of: $0) }.map { "\($0)" } ?? "nil") locked \(ed.isLocked) same \(model.activeEditor === ed)", category: "debug")
                        snapshot(to: out)
                    }
                }
            } else {
                Log.notice("debug hover: no active editor", category: "debug")
            }
        case "pagemenu":
            NotificationCenter.default.post(name: .debugOpenPageMenu, object: nil)
        case "approve":
            for item in model.brain.happier.inbox where item.status == .pending {
                model.brain.happier.resolve(item, decision: q["decision"] ?? "allow_once")
            }
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
        case "state":
            let hc = model.brain.happier.chats.count
            let out = q["out"] ?? NSTemporaryDirectory() + "based-state.txt"
            let sessions = model.brain.brain.sessions()
            var lines = ["happier.chats \(hc)", "sessions \(sessions.count)", "chats(store) \(sessions.filter(\.isChat).count)"]
            lines += sessions.prefix(10).map { "  \($0.agentID) · \($0.title) · \($0.id)" }
            try? lines.joined(separator: "\n").write(toFile: out, atomically: true, encoding: .utf8)
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
        // A locked screen / occluded window gets no display-link ticks: force SwiftUI to commit pending updates.
        func touch(_ v: NSView) { v.needsLayout = true; v.needsDisplay = true; v.subviews.forEach(touch) }
        if let cv = win.contentView { touch(cv) }
        win.contentView?.layoutSubtreeIfNeeded()
        win.display()
        CATransaction.flush()
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
