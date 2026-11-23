// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import AppIntents

// BSD-66: Action Button (Apple Watch Ultra) and Shortcuts: "Record a thought" opens the app and starts recording.
// Taken over from legacy/App/watchOS/WatchIntents.swift.

struct RecordThoughtIntent: AppIntent {
    static let title: LocalizedStringResource = "Record a Thought"
    static let description = IntentDescription("Records a voice note and sends it to Based on your iPhone.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        if !WatchCaptureModel.shared.isRecording { WatchCaptureModel.shared.toggle() }
        return .result()
    }
}

struct BasedWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(intent: RecordThoughtIntent(), phrases: ["Record a thought in \(.applicationName)"],
                    shortTitle: "Record a Thought", systemImageName: "mic.fill")
    }
}
