import SwiftUI
import BasedCore

@main
struct BasedApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                #if os(macOS)
                .frame(minWidth: 760, minHeight: 480)
                #endif
        }
        .commands { BasedCommands(model: model) }
        #if os(macOS)
        Settings {
            SettingsView()
                .environment(model)
                .frame(width: 520, height: 460)
        }
        #endif
    }
}

struct BasedCommands: Commands {
    let model: AppModel

    var body: some Commands {
        CommandGroup(replacing: .newItem) {
            Button("New Page") { model.newPage() }
                .keyboardShortcut("n")
            Button("Import…") { model.showImport = true }
                .keyboardShortcut("i", modifiers: [.command, .shift])
            Button("Export Page as Markdown…") { model.exportCurrentPage() }
                .keyboardShortcut("e", modifiers: [.command, .shift])
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
        CommandMenu("Format") {
            Button("Bold") { model.activeEditor?.toggleMark(.bold) }.keyboardShortcut("b")
            Button("Italic") { model.activeEditor?.toggleMark(.italic) }.keyboardShortcut("i")
            Button("Underline") { model.activeEditor?.toggleMark(.underline) }.keyboardShortcut("u")
            Button("Strikethrough") { model.activeEditor?.toggleMark(.strikethrough) }.keyboardShortcut("x", modifiers: [.command, .shift])
            Button("Inline Code") { model.activeEditor?.toggleMark(.code) }.keyboardShortcut("e")
            Button("Link…") { model.activeEditor?.beginLinkEditing() }.keyboardShortcut("k")
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
        CommandMenu("Go") {
            Button("Search…") { model.showQuickFind = true }.keyboardShortcut("p")
            Button("Back") { model.goBack() }.keyboardShortcut("[")
            Button("Home") { model.selection = .home }.keyboardShortcut("h", modifiers: [.command, .shift])
            Button("Trash") { model.showTrash = true }
            Divider()
            Button("Sync Now") { model.syncNow() }.keyboardShortcut("r", modifiers: [.command, .shift])
        }
    }
}
