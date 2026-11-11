import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Back / forward from every input, not just the title-bar arrows and ⌘[ / ⌘]:
/// - mouse side buttons (button 4 = back, 5 = forward — Logitech & co. send these),
/// - trackpad swipe (three fingers, or two with "Swipe between pages" set to that in System Settings),
/// - ⌘← / ⌘→ when no text field or page text has keyboard focus (in text they keep moving the caret).
/// Installed once for the app; events are only taken when the key window is one of ours.
enum NavigationInput {
    #if os(macOS)
    @MainActor private static var monitor: Any?

    @MainActor static func install(model: AppModel) {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.otherMouseDown, .swipe, .keyDown]) { [weak model] event in
            guard let model else { return event }
            switch event.type {
            case .otherMouseDown:
                switch event.buttonNumber {
                case 3: model.goBack(); return nil
                case 4: model.goForward(); return nil
                default: return event
                }
            case .swipe:
                if event.deltaX > 0 { model.goBack(); return nil }
                if event.deltaX < 0 { model.goForward(); return nil }
                return event
            case .keyDown:
                let mods = event.modifierFlags.intersection([.command, .shift, .option, .control])
                guard mods == .command else { return event }
                guard !textHasFocus(in: event.window) else { return event }
                switch event.keyCode {
                case 123: model.goBack(); return nil      // ←
                case 124: model.goForward(); return nil   // →
                default: return event
                }
            default:
                return event
            }
        }
    }

    /// A text view (page editor or a field's editor) is first responder → arrows belong to the text.
    @MainActor static func textHasFocus(in window: NSWindow?) -> Bool {
        (window ?? NSApp.keyWindow)?.firstResponder is NSTextView
    }
    #endif
}

/// Back / forward arrows with a history menu (right-click or long-press shows where they lead).
struct HistoryButtons: View {
    var size: CGFloat = 14
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 2) {
            arrow("arrow.left", help: "Back (⌘[, mouse button 4, swipe right)", enabled: model.canGoBack, entries: model.backEntries) { model.goBack() }
                .accessibilityIdentifier("toolbar.back")
            arrow("arrow.right", help: "Forward (⌘], mouse button 5, swipe left)", enabled: model.canGoForward, entries: model.forwardEntries) { model.goForward() }
                .accessibilityIdentifier("toolbar.forward")
        }
    }

    private func arrow(_ symbol: String, help: String, enabled: Bool, entries: [AppModel.HistoryEntry], action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: size, weight: .medium))
                .frame(width: 28, height: 28)
                .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill)
        .foregroundStyle(enabled ? Theme.primary.opacity(0.75) : Theme.secondary.opacity(0.4))
        .disabled(!enabled)
        .help(help)
        .contextMenu {
            ForEach(entries) { e in
                Button(e.title) { model.jumpHistory(e.id) }
            }
        }
    }
}
