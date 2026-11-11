import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

@main
struct BasedApp: App {
    @State private var model = AppModel()
    #if os(macOS)
    /// BSD-64: menu bar icon for quick capture (Settings → Capture).
    @AppStorage(QuickCapturePrefs.menuBar) private var showCaptureInMenuBar = true
    #endif

    // BSD-135 (hang on start, 09.11.): this body must stay cheap and must not read the model. Every re-evaluation
    // of the App body rebuilt the whole window content (environment pushed through every Text and NSTextView of
    // a large page); together with the MenuBarExtra writing its `isInserted` binding back on each scene update
    // that became an endless loop at 100 % CPU. The window content lives in `MainWindowRoot` (its own view: an
    // App body re-evaluation is a cheap struct comparison there), and the binding only writes real changes.
    var body: some Scene {
        #if os(macOS)
        // One main window: the app has one model (tabs, active editor, chat), so a second window showed the
        // same page with its own editor — and every based:// link (deep links, the debug driver) opened
        // another one through WindowGroup. `Window` is single-instance and receives the URLs itself.
        Window("Based", id: "main") { MainWindowRoot(model: $model) }
            .defaultSize(width: 1240, height: 820)
            .windowResizability(.contentMinSize)
            // Notion-style chrome: content runs under the (hidden) title bar; MacTitleBar draws tabs + controls.
            .windowStyle(.hiddenTitleBar)
            .commands { BasedCommands(model: model) }
        MenuBarExtra("Capture a Thought", systemImage: "square.and.pencil", isInserted: menuBarInserted) {
            QuickCaptureMenuBarContent(model: model)
        }
        .menuBarExtraStyle(.window)
        #else
        WindowGroup { MainWindowRoot(model: $model) }
            .commands { BasedCommands(model: model) }
        #endif
        // No separate Settings window: ⌘, opens Settings inside the main window (see BasedCommands).
    }

    #if os(macOS)
    /// Writes only real changes: AppKit reports the status item's visibility back on every scene update, and an
    /// @AppStorage write invalidates the App body even when the value is the same.
    private var menuBarInserted: Binding<Bool> {
        Binding(get: { showCaptureInMenuBar },
                set: { if $0 != showCaptureInMenuBar { showCaptureInMenuBar = $0 } })
    }
    #endif
}

/// The main window's content with the app-wide environment. A separate view so that the App body (scenes, menus,
/// menu bar extra) can be re-evaluated without rebuilding and re-propagating the environment of every page view.
struct MainWindowRoot: View {
    @Binding var model: AppModel
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue

    var body: some View {
        RootView()
            .environment(model)
            .environment(model.brain)
            .environment(model.brain.happier)
            .preferredColorScheme(Appearance(rawValue: appearance)?.colorScheme)
            // The workspace file opens again after the storage error screen's "Try again" (BSD-15).
            .onChange(of: model.reopenRequest) { _, _ in model = AppModel() }
            #if os(macOS)
            // BSD-64: system-wide quick capture (hot key → floating field); follows the model when it is replaced.
            .onAppear { QuickCapturePanel.shared.install(model: model) }
            .onChange(of: ObjectIdentifier(model)) { _, _ in QuickCapturePanel.shared.install(model: model) }
            #endif
            // BSD-11: Share extension inbox and widget snapshot (App Group).
            .onAppear { AppGroupBridge.shared.start(model: model) }
            .onChange(of: ObjectIdentifier(model)) { _, _ in AppGroupBridge.shared.start(model: model) }
            #if os(iOS)
            // BSD-66: voice notes from the Apple Watch app.
            .onAppear { WatchReceiver.shared.start(model: model) }
            .onChange(of: ObjectIdentifier(model)) { _, _ in WatchReceiver.shared.start(model: model) }
            #endif
            #if os(macOS)
            // Small enough for split-screen; the window can't shrink below it (contentMinSize), so nothing is
            // clipped or shifted when the window opens at its restored size.
            .frame(minWidth: 640, minHeight: 420)
            #endif
    }
}

struct BasedCommands: Commands {
    let model: AppModel

    /// Runs a menu command and leaves a breadcrumb (crash reports show the last commands).
    @MainActor private func run(_ name: String, _ action: () -> Void) {
        Log.breadcrumb("cmd \(name)")
        action()
    }

    // Xcode 26: CommandsBuilder nimmt höchstens 10 Elemente pro Block – daher zwei Teile (P0, CI 09.11.).
    var body: some Commands {
        fileAndEditCommands
        formatAndNavigationCommands
    }

    @CommandsBuilder private var fileAndEditCommands: some Commands {
        #if os(macOS)
        CommandGroup(after: .appInfo) {
            Button("Check for Updates…") {
                run("updates") {
                    if model.updater.channel == .source { model.openSettings(page: "updates") }
                    Task { await model.updater.checkWithUI() }
                }
            }
        }
        #endif
        CommandGroup(replacing: .appSettings) {
            Button("Settings…") { run("⌘,") { model.openSettings() } }
                .keyboardShortcut(",")
        }
        CommandGroup(replacing: .newItem) {
            Button("New…") { run("⌘N") { model.showQuickFind = false; model.showCommandPalette.toggle() } }
                .keyboardShortcut("n")
            Button("New Page") { run("⌥⌘N") { model.newPage() } }
                .keyboardShortcut("n", modifiers: [.command, .option])
            Button("New AI Chat") { run("⇧⌘N") { model.openChat(nil, fullPage: true) } }
                .keyboardShortcut("n", modifiers: [.command, .shift])
            Button("New Meeting Notes") { run("meeting") { model.newMeetingNotes() } }
            // BSD-111: quick capture into Captures (same sheet as based://capture and the iPhone shortcut).
            Button("Capture a Thought…") { run("capture") { model.captureRoute = .compose("") } }
                .keyboardShortcut("c", modifiers: [.command, .control])
            Button("Record a Voice Note") { run("capture-record") { model.captureRoute = .record } }
            Button("New Tab") { run("⌘T") { model.newTabWithSearch() } }
                .keyboardShortcut("t")
            Divider()
            Button("Import from Notion…") { model.showNotionImport = true }
                .keyboardShortcut("i", modifiers: [.command, .option])
            Button("Import File…") { model.showImport = true }
                .keyboardShortcut("i", modifiers: [.command, .shift])
            Button("Export Page as Markdown…") { model.exportCurrentPage() }
                .keyboardShortcut("e", modifiers: [.command, .shift])
            Button("Export Page as HTML…") { model.exportCurrentPage(as: .html) }
                .keyboardShortcut("e", modifiers: [.command, .shift, .option])
        }
        CommandGroup(replacing: .saveItem) {
            Button("Close Tab") {
                run("⌘W") {
                    #if os(macOS)
                    // Settings / other windows close normally; tabs only apply to the main window.
                    if let key = NSApp.keyWindow, key !== model.mainWindow { key.performClose(nil); return }
                    #endif
                    if model.showQuickFind || model.showCommandPalette { model.showQuickFind = false; model.showCommandPalette = false; return }
                    if model.peek != nil { model.peek = nil; return }
                    if model.tabs.count > 1 { model.closeTab(); return }
                    #if os(macOS)
                    NSApp.keyWindow?.performClose(nil)
                    #endif
                }
            }
            .keyboardShortcut("w")
        }
        CommandGroup(replacing: .undoRedo) {
            Button("Undo") { model.undo() }
                .keyboardShortcut("z")
            Button("Redo") { model.redo() }
                .keyboardShortcut("z", modifiers: [.command, .shift])
        }
        CommandGroup(after: .pasteboard) {
            Button("Duplicate") { model.activeEditor?.duplicateTargets() }
                .keyboardShortcut("d")
        }
        CommandGroup(replacing: .textEditing) {
            Button("Find…") { run("⌘F") { find() } }
                .keyboardShortcut("f")
            Button("Search Workspace…") { run("⌘P") { model.showCommandPalette = false; model.showQuickFind = true } }
                .keyboardShortcut("p")
        }
    }

    @CommandsBuilder private var formatAndNavigationCommands: some Commands {
        CommandMenu("Format") {
            Button("Bold") { model.activeEditor?.toggleMark(.bold) }.keyboardShortcut("b")
            Button("Italic") { model.activeEditor?.toggleMark(.italic) }.keyboardShortcut("i")
            Button("Underline") { model.activeEditor?.toggleMark(.underline) }.keyboardShortcut("u")
            Button("Strikethrough") { model.activeEditor?.toggleMark(.strikethrough) }.keyboardShortcut("x", modifiers: [.command, .shift])
            Button("Inline Code") { model.activeEditor?.toggleMark(.code) }.keyboardShortcut("e")
            Button("Link… (⌘K with text selected)") { model.activeEditor?.beginLinkEditing() }
            Divider()
            Button("Text") { model.activeEditor?.turnTargets(into: .text) }.keyboardShortcut("0", modifiers: [.command, .option])
            Button("Heading 1") { model.activeEditor?.turnTargets(into: .heading1) }.keyboardShortcut("1", modifiers: [.command, .option])
            Button("Heading 2") { model.activeEditor?.turnTargets(into: .heading2) }.keyboardShortcut("2", modifiers: [.command, .option])
            Button("Heading 3") { model.activeEditor?.turnTargets(into: .heading3) }.keyboardShortcut("3", modifiers: [.command, .option])
            Button("To-do List") { model.activeEditor?.turnTargets(into: .todo) }.keyboardShortcut("4", modifiers: [.command, .option])
            Button("Bulleted List") { model.activeEditor?.turnTargets(into: .bulletedList) }.keyboardShortcut("5", modifiers: [.command, .option])
            Button("Numbered List") { model.activeEditor?.turnTargets(into: .numberedList) }.keyboardShortcut("6", modifiers: [.command, .option])
            Button("Toggle List") { model.activeEditor?.turnTargets(into: .toggle) }.keyboardShortcut("7", modifiers: [.command, .option])
            Button("Code") { model.activeEditor?.turnTargets(into: .code) }.keyboardShortcut("8", modifiers: [.command, .option])
            Button("Page") { model.activeEditor?.turnTargets(into: .page) }.keyboardShortcut("9", modifiers: [.command, .option])
            Divider()
            Button("Expand / Collapse Toggles") { model.activeEditor?.toggleAllToggles() }.keyboardShortcut("t", modifiers: [.command, .option])
        }
        CommandGroup(after: .toolbar) {
            Button("Zoom In") { model.pageZoom += 0.1 }.keyboardShortcut("+")
            Button("Zoom In") { model.pageZoom += 0.1 }.keyboardShortcut("=")   // US layouts: ⌘= is ⌘+
            Button("Zoom Out") { model.pageZoom -= 0.1 }.keyboardShortcut("-")
            Button("Actual Size") { model.pageZoom = 1 }.keyboardShortcut("0")
            Divider()
            Button("Toggle Dark Mode") { Appearance.toggle() }.keyboardShortcut("l", modifiers: [.command, .shift])
            Button(model.showChatPanel ? "Hide AI Chat" : "Show AI Chat") { run("⌘J") { model.toggleChatPanel() } }
                .keyboardShortcut("j")
        }
        CommandMenu("Go") {
            Button("Search…") {
                run("⌘K") {
                    // Notion: ⌘K with selected text adds a link, otherwise it opens search.
                    if let ed = model.activeEditor, ed.hasTextSelection, !model.showQuickFind, OverlayFocus.editorIsFirstResponder { ed.beginLinkEditing() }
                    else { model.showCommandPalette = false; model.showQuickFind.toggle() }
                }
            }
            .keyboardShortcut("k")
            Button("Open Parent Page") { model.openParent() }.keyboardShortcut("u", modifiers: [.command, .shift])
            #if os(macOS)
            Button(model.sidebarCollapsed ? "Show Sidebar" : "Hide Sidebar") { model.toggleSidebar() }.keyboardShortcut("\\")
            Button(model.sidebarMode == .notes ? "Switch Sidebar to AI" : "Switch Sidebar to Notes") {
                model.switchSidebar(to: model.sidebarMode == .notes ? .ai : .notes)
            }
            .keyboardShortcut("\\", modifiers: [.command, .option])
            #endif
            Button("Back") { model.goBack() }.keyboardShortcut("[").disabled(!model.canGoBack)
            Button("Forward") { model.goForward() }.keyboardShortcut("]").disabled(!model.canGoForward)
            Divider()
            Button("Home") { model.goHome() }.keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Agents") { model.selection = .projects }.keyboardShortcut("1", modifiers: [.command, .shift])
            Button("Inbox") { model.selection = .inbox }.keyboardShortcut("2", modifiers: [.command, .shift])
            Button("Agent Brain") { model.selection = .brain }.keyboardShortcut("3", modifiers: [.command, .shift])
            Button("Trash") { model.showTrash = true }
            Divider()
            Button("Sync Now") { model.syncNow() }.keyboardShortcut("r", modifiers: [.command, .shift])
        }
        #if os(macOS)
        let tabPlacement = CommandGroupPlacement.windowList
        #else
        let tabPlacement = CommandGroupPlacement.toolbar
        #endif
        CommandGroup(before: tabPlacement) {
            Button("Next Tab") { model.cycleTab(1) }.keyboardShortcut(.tab, modifiers: .control)
            Button("Previous Tab") { model.cycleTab(-1) }.keyboardShortcut(.tab, modifiers: [.control, .shift])
            Button("Show Next Tab") { model.cycleTab(1) }.keyboardShortcut("]", modifiers: [.command, .shift])
            Button("Show Previous Tab") { model.cycleTab(-1) }.keyboardShortcut("[", modifiers: [.command, .shift])
            ForEach(1...9, id: \.self) { i in
                Button(i == 9 ? "Last Tab" : "Tab \(i)") { model.selectTab(index: i - 1) }
                    .keyboardShortcut(KeyEquivalent(Character("\(i)")), modifiers: .command)
            }
            Divider()
        }
        CommandGroup(after: .help) {
            Divider()
            Button("Diagnostics & Logs") { model.openDiagnostics(.logs) }
                .keyboardShortcut("d", modifiers: [.command, .option, .shift])
            Button("Copy Diagnostic Report") { AppDiagnostics.copyReport(model: model) }
        }
    }

    /// ⌘F: page find bar, database search on full-page databases, workspace search elsewhere.
    @MainActor private func find() {
        guard let id = model.currentPageID else { model.showQuickFind = true; return }
        if model.store.blocks[id]?.type == .databasePage { model.dbSearchRequest += 1; return }
        if model.showFind { model.findFocusRequest += 1 } else { model.showFind = true }
    }
}

/// Light / dark / follow-system appearance, stored in UserDefaults (Notion: ⇧⌘L).
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    static let key = "appearance"
    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: return "Use system setting"
        case .light: return "Light"
        case .dark: return "Dark"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
    static var current: Appearance {
        get { Appearance(rawValue: UserDefaults.standard.string(forKey: key) ?? "") ?? .system }
        set { UserDefaults.standard.set(newValue.rawValue, forKey: key) }
    }
    /// Cycles light → dark → light (system resolves to the opposite of the current look).
    static func toggle() {
        current = current == .dark ? .light : .dark
    }
}
