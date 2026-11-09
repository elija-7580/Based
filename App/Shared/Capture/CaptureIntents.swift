#if os(iOS) && canImport(AppIntents)
import AppIntents
import BasedCore
import BasedBrain

// BSD-65: App Intents for capturing on iPhone — Shortcuts, Siri, Spotlight and the Action Button
// (Settings → Action Button → Shortcut → Based). Not checked by the Linux typecheck (no AppIntents stub): written
// against the iOS 17 App Intents API, to be verified in Xcode. The logic lives in BasedBrain (CaptureIntentLogic).

enum CaptureIntentError: Error, CustomLocalizedStringResourceConvertible {
    case notReady
    case invalid(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .notReady: return "Based isn't ready yet. Open the app once and try again."
        case .invalid(let m): return "\(m)"
        }
    }
}

@MainActor
private func currentModel() throws -> AppModel {
    guard let m = AppModel.current, !m.store.isReadOnly else { throw CaptureIntentError.notReady }
    return m
}

/// "Capture a thought": saves the text without opening the app; asks for it when it is missing.
struct CaptureThoughtIntent: AppIntent {
    static let title: LocalizedStringResource = "Capture a Thought"
    static let description: IntentDescription? = IntentDescription("Saves a thought or a link to Captures in Based. It is sorted into the right project tonight.")
    static let openAppWhenRun = false

    @Parameter(title: "Thought", inputOptions: String.IntentInputOptions(multiline: true))
    var text: String?

    static var parameterSummary: some ParameterSummary { Summary("Capture \(\.$text)") }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let model = try currentModel()
        var value = text
        if (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            value = try await $text.requestValue(IntentDialog(stringLiteral: CaptureIntentLogic.capturePrompt))
        }
        switch CaptureIntentLogic.capture(text: value, source: .shortcut, brain: model.brain.brain) {
        case .saved(_, let dialog): return .result(dialog: IntentDialog(stringLiteral: dialog))
        case .needsInput(let prompt): throw $text.needsValueError(IntentDialog(stringLiteral: prompt))
        case .failed(let m): throw CaptureIntentError.invalid(m)
        }
    }
}

/// "Record a thought": opens Based on the capture sheet and starts recording right away.
struct RecordThoughtIntent: AppIntent {
    static let title: LocalizedStringResource = "Record a Thought"
    static let description: IntentDescription? = IntentDescription("Opens Based and records a voice note. It is transcribed on this iPhone and saved to Captures.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        let model = try currentModel()
        model.captureRoute = .record
        return .result()
    }
}

/// "Ask my agent": opens the main agent's thread with the request sent.
struct AskMainAgentIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask My Agent"
    static let description: IntentDescription? = IntentDescription("Hands a task to your main agent in Based.")
    static let openAppWhenRun = true

    @Parameter(title: "Task", inputOptions: String.IntentInputOptions(multiline: true))
    var task: String?

    static var parameterSummary: some ParameterSummary { Summary("Ask my agent to \(\.$task)") }

    @MainActor
    func perform() async throws -> some IntentResult {
        let model = try currentModel()
        var value = task
        if (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            value = try await $task.requestValue(IntentDialog(stringLiteral: CaptureIntentLogic.askPrompt))
        }
        switch CaptureIntentLogic.ask(value) {
        case .success(let route): model.captureRoute = route
        case .failure(let p): throw CaptureIntentError.invalid(p.description)
        }
        return .result()
    }
}

/// Phrases for Siri / Spotlight; the shortcuts also appear in the Shortcuts app and the Action Button picker.
/// German phrases need an AppShortcuts.xcstrings in a German build; the English ones work everywhere.
struct BasedShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: CaptureThoughtIntent(),
                    phrases: ["Capture a thought in \(.applicationName)", "Note something in \(.applicationName)",
                              "Gedanke in \(.applicationName)", "Notiz in \(.applicationName)"],
                    shortTitle: "Capture", systemImageName: "square.and.pencil")
        AppShortcut(intent: RecordThoughtIntent(),
                    phrases: ["Record a thought in \(.applicationName)", "Sprachnotiz in \(.applicationName)"],
                    shortTitle: "Record Thought", systemImageName: "mic")
        AppShortcut(intent: AskMainAgentIntent(),
                    phrases: ["Ask my agent in \(.applicationName)", "Frag meinen Agenten in \(.applicationName)"],
                    shortTitle: "Ask Agent", systemImageName: "sparkles")
    }
}
#endif
