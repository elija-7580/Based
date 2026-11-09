#if os(macOS)
import SwiftUI
import AppKit
import Carbon
import BasedCore
import BasedBrain

// BSD-64: capture a thought from anywhere on the Mac.
//
// * A system-wide shortcut (default ⌥⇧Space, Settings → Capture) opens a small floating field in the middle of the
//   screen, like Spotlight, without switching to Based's main window. Enter saves to Captures, Esc closes, focus goes
//   back to the app you were in.
// * A menu bar icon (can be hidden) opens the same field.
// * "To main agent" sends the text to the main agent's thread as a task instead of filing it.
// The parsing and saving logic lives in BasedBrain (`HotKey`, `QuickCapture`) and is tested there.

enum QuickCapturePrefs {
    static let hotKey = "pref.quickCapture.hotKey"
    static let menuBar = "pref.quickCapture.menuBar"
    static let enabled = "pref.quickCapture.enabled"

    static var currentHotKey: HotKey {
        UserDefaults.standard.string(forKey: hotKey).flatMap(HotKey.parse) ?? .defaultQuickCapture
    }
    static var isEnabled: Bool { UserDefaults.standard.object(forKey: enabled) as? Bool ?? true }
}

/// One system-wide hot key through Carbon's `RegisterEventHotKey` (works without Accessibility permission).
@MainActor
final class GlobalHotKey {
    static let shared = GlobalHotKey()

    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private(set) var registered: HotKey?
    var onPress: (() -> Void)?

    /// Registers `key` (replacing an earlier one). Returns false when the system refused it (taken by another app).
    @discardableResult
    func register(_ key: HotKey) -> Bool {
        unregister()
        if handler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            let status = InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { MainActor.assumeIsolated { GlobalHotKey.shared.onPress?() } }
                return OSStatus(noErr)
            }, 1, &spec, nil, &handler)
            guard status == OSStatus(noErr) else {
                Log.warning("Quick capture: event handler not installed (\(status))", category: "capture")
                return false
            }
        }
        let id = EventHotKeyID(signature: 0x4253_4443 /* BSDC */, id: 1)
        let status = RegisterEventHotKey(key.carbonKeyCode, key.carbonModifiers, id, GetApplicationEventTarget(), 0, &ref)
        guard status == OSStatus(noErr), ref != nil else {
            Log.warning("Quick capture: \(key) could not be registered (\(status)) — probably used by another app", category: "capture")
            ref = nil
            return false
        }
        registered = key
        return true
    }

    func unregister() {
        if let ref { _ = UnregisterEventHotKey(ref) }
        ref = nil
        registered = nil
    }
}

/// The floating field (a borderless-looking panel in the middle of the screen).
@MainActor
final class QuickCapturePanel {
    static let shared = QuickCapturePanel()

    private var window: NSWindow?
    private var previousApp: NSRunningApplication?
    weak var model: AppModel?

    /// Starts the hot key with the saved shortcut (called once the workspace is open).
    func install(model: AppModel) {
        self.model = model
        GlobalHotKey.shared.onPress = { [weak self] in self?.toggle() }
        applyPreferences()
    }

    func applyPreferences() {
        if QuickCapturePrefs.isEnabled { GlobalHotKey.shared.register(QuickCapturePrefs.currentHotKey) }
        else { GlobalHotKey.shared.unregister() }
    }

    func toggle() {
        if let w = window, w.isVisible { close(restoreFocus: true) } else { show() }
    }

    func show() {
        guard let model else { return }
        let front = NSWorkspace.shared.frontmostApplication
        previousApp = front?.bundleIdentifier == NSRunningApplication.current.bundleIdentifier ? nil : front
        let link = QuickCapture.prefillLink(clipboard: NSPasteboard.general.string(forType: .string))
        let view = QuickCaptureView(initialLink: link, onDone: { [weak self] in self?.close(restoreFocus: true) })
            .environment(model)
        let w = window ?? Self.makeWindow()
        w.contentView = NSHostingView(rootView: view)
        w.center()
        window = w
        NSApp.activate(ignoringOtherApps: true)
        w.makeKeyAndOrderFront(nil)
    }

    func close(restoreFocus: Bool) {
        window?.orderOut(nil)
        window?.contentView = nil
        if restoreFocus, let app = previousApp { app.activate() }
        previousApp = nil
    }

    private static func makeWindow() -> NSWindow {
        let w = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 150),
                        styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        w.titleVisibility = .hidden
        w.titlebarAppearsTransparent = true
        w.isMovableByWindowBackground = true
        w.level = .floating
        w.standardWindowButton(.closeButton)?.isHidden = true
        w.standardWindowButton(.miniaturizeButton)?.isHidden = true
        w.standardWindowButton(.zoomButton)?.isHidden = true
        return w
    }
}

/// Text, optional link (pre-filled from a web link on the clipboard), microphone, "To main agent".
struct QuickCaptureView: View {
    @Environment(AppModel.self) private var model
    let initialLink: String?
    var onDone: () -> Void
    @State private var text = ""
    @State private var link = ""
    @State private var toMainAgent = false
    @State private var error: String?
    @State private var voice = VoiceCaptureService.shared
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: toMainAgent ? "sparkles" : "tray.and.arrow.down").foregroundStyle(Theme.secondary)
                TextField(toMainAgent ? "Task for the main agent…" : "Capture a thought…", text: $text)
                    .textFieldStyle(.plain)
                    .font(.system(size: 18))
                    .focused($focused)
                    .onSubmit { save() }
                    .onKeyPress(.escape) { cancel(); return .handled }
                Button { toggleRecording() } label: {
                    Image(systemName: voice.isRecording ? "stop.circle.fill" : "mic").font(.system(size: 16))
                        .foregroundStyle(voice.isRecording ? Color.red : Theme.secondary)
                }
                .buttonStyle(.plain)
                .help(voice.isRecording ? "Stop and save the voice note" : "Record a voice note")
            }
            HStack(spacing: 8) {
                Image(systemName: "link").foregroundStyle(Theme.secondary).font(.system(size: 11))
                TextField("Link (optional)", text: $link).textFieldStyle(.plain).font(.system(size: 12))
                Toggle("To main agent", isOn: $toMainAgent).toggleStyle(.checkbox).font(.system(size: 12))
            }
            if let e = error ?? voice.lastError {
                Text(e).font(.caption).foregroundStyle(.red)
            } else {
                Text(voice.isRecording ? "Recording \(CaptureSheet.clock(voice.elapsed)) — ↩ saves" : "↩ save · esc close")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(16)
        .frame(width: 560)
        .onAppear {
            link = initialLink ?? ""
            focused = true
        }
    }

    private func toggleRecording() {
        if voice.isRecording { save() } else { Task { await voice.start() } }
    }

    private func save() {
        error = nil
        var saved = 0
        if voice.isRecording {
            switch voice.stopAndSave(model: model) {
            case .saved?: saved += 1
            case .failed(let m)?: error = m; return
            default: break
            }
        }
        let hasText = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if hasText || (!toMainAgent && !link.trimmingCharacters(in: .whitespaces).isEmpty) {
            switch QuickCapture.submit(text: text, link: link, toMainAgent: toMainAgent, source: .mac, brain: model.brain.brain) {
            case .captured: saved += 1
            case .askMainAgent(let task):
                model.brain.openChat(model.brain.mainThreadID())
                model.brain.ask(task)
                model.showToast("Sent to the main agent")
                onDone()
                return
            case .failed(let m): error = m; return
            }
        }
        guard saved > 0 else { error = CaptureInput.Problem.empty.description; return }
        model.showToast(saved == 1 ? "Saved to Captures" : "Saved \(saved) captures")
        onDone()
    }

    private func cancel() {
        voice.cancel()
        onDone()
    }
}

/// Settings → My settings → Capture.
struct QuickCaptureSettings: View {
    @AppStorage(QuickCapturePrefs.enabled) private var enabled = true
    @AppStorage(QuickCapturePrefs.menuBar) private var menuBar = true
    @AppStorage(QuickCapturePrefs.hotKey) private var hotKeyText = HotKey.defaultQuickCapture.description
    @State private var problem: String?

    var body: some View {
        Section("Capture") {
            Toggle("Capture from anywhere with a shortcut", isOn: $enabled)
                .onChange(of: enabled) { _, _ in QuickCapturePanel.shared.applyPreferences() }
            HStack {
                TextField("Shortcut", text: $hotKeyText)
                    .onSubmit { apply() }
                    .frame(maxWidth: 200)
                Button("Apply") { apply() }
            }
            .disabled(!enabled)
            if let problem { Text(problem).font(.caption).foregroundStyle(.red) }
            Toggle("Show in menu bar", isOn: $menuBar)
            Text("Type e.g. ⌥⇧Space, ctrl+option+n or cmd+shift+F5. The field opens over any app; ↩ saves to Captures.")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
    }

    private func apply() {
        guard let key = HotKey.parse(hotKeyText) else {
            problem = "Not a shortcut. Use modifiers (⌃⌥⇧⌘ or ctrl/option/shift/cmd) and a key."
            return
        }
        hotKeyText = key.description
        problem = GlobalHotKey.shared.register(key) ? nil : "\(key) is taken by another app or the system."
    }
}

/// The menu bar icon's window.
struct QuickCaptureMenuBarContent: View {
    let model: AppModel

    var body: some View {
        QuickCaptureView(initialLink: QuickCapture.prefillLink(clipboard: NSPasteboard.general.string(forType: .string)),
                         onDone: { NSApp.keyWindow?.orderOut(nil) })
            .environment(model)
    }
}
#endif
