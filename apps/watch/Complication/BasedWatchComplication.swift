// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import SwiftUI
import WidgetKit

// BSD-66: complication — a microphone on the watch face that opens the watch app straight into recording.
// Taken over from legacy/App/watchOSWidget/BasedWatchComplication.swift; new: the inline family.

struct ThoughtEntry: TimelineEntry { let date: Date }

struct ThoughtProvider: TimelineProvider {
    func placeholder(in context: Context) -> ThoughtEntry { ThoughtEntry(date: Date()) }
    func getSnapshot(in context: Context, completion: @escaping (ThoughtEntry) -> Void) { completion(ThoughtEntry(date: Date())) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<ThoughtEntry>) -> Void) {
        completion(Timeline(entries: [ThoughtEntry(date: Date())], policy: .never))
    }
}

struct ThoughtComplicationView: View {
    @Environment(\.widgetFamily) private var family
    var entry: ThoughtEntry

    var body: some View {
        Group {
            if family == .accessoryInline {
                Label("Hold a thought", systemImage: "mic.fill")
            } else {
                ZStack {
                    AccessoryWidgetBackground()
                    Image(systemName: "mic.fill").font(.system(size: 20, weight: .semibold))
                }
            }
        }
        .widgetURL(URL(string: "basedwatch://record"))
        .containerBackground(Color.clear, for: .widget)
    }
}

@main
struct BasedWatchComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BasedRecordThought", provider: ThoughtProvider()) { entry in
            ThoughtComplicationView(entry: entry)
        }
        .configurationDisplayName("Record a Thought")
        .description("Opens Based and starts recording.")
        .supportedFamilies([.accessoryCircular, .accessoryCorner, .accessoryInline])
    }
}
