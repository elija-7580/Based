import SwiftUI
import WidgetKit
import BasedBrain

// BSD-11: Home/Lock Screen widgets. "Capture" opens Based straight into recording a thought (based://capture/record,
// BSD-65); "Running now" and "Needs you" show the snapshot the app writes into the App Group (`WidgetSnapshot`).

struct SnapshotEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot
}

struct SnapshotProvider: TimelineProvider {
    static func load() -> WidgetSnapshot {
        let group = (Bundle.main.object(forInfoDictionaryKey: "BasedAppGroup") as? String) ?? ""
        let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)?.appendingPathComponent("widget.json")
        return WidgetSnapshot.decode(url.flatMap { try? Data(contentsOf: $0) })
    }
    func placeholder(in context: Context) -> SnapshotEntry { SnapshotEntry(date: Date(), snapshot: .empty) }
    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: Date(), snapshot: Self.load()))
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        // The app reloads the timelines when the snapshot changes; refresh every 30 minutes anyway.
        completion(Timeline(entries: [SnapshotEntry(date: Date(), snapshot: Self.load())], policy: .after(Date().addingTimeInterval(1800))))
    }
}

struct CaptureWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BasedCapture", provider: SnapshotProvider()) { entry in
            VStack(spacing: 6) {
                Image(systemName: "mic.fill").font(.title)
                Text("Hold a thought").font(.caption).bold()
                if entry.snapshot.capturesToday > 0 {
                    Text("\(entry.snapshot.capturesToday) today").font(.caption2).foregroundStyle(.secondary)
                }
            }
            .widgetURL(URL(string: "based://capture/record"))
            .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Capture")
        .description("Record a thought into Captures.")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

struct ListWidgetView: View {
    let title: String
    let symbol: String
    let count: Int
    let lines: [WidgetSnapshot.Line]
    let empty: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Label("\(count) \(title)", systemImage: symbol).font(.headline)
            if lines.isEmpty {
                Text(empty).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                VStack(alignment: .leading, spacing: 0) {
                    Text(line.title).font(.caption).lineLimit(1)
                    if !line.detail.isEmpty { Text(line.detail).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(.fill.tertiary, for: .widget)
    }
}

struct RunningWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BasedRunning", provider: SnapshotProvider()) { entry in
            ListWidgetView(title: "running", symbol: "bolt.fill", count: entry.snapshot.running,
                           lines: entry.snapshot.runningTop, empty: "No agent is working right now.")
        }
        .configurationDisplayName("Running now")
        .description("Agents working right now.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

struct NeedsYouWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "BasedNeedsYou", provider: SnapshotProvider()) { entry in
            ListWidgetView(title: "need you", symbol: "hand.raised.fill", count: entry.snapshot.needsYou,
                           lines: entry.snapshot.needsYouTop, empty: "Nothing waits for you.")
        }
        .configurationDisplayName("Needs you")
        .description("Approvals and questions from your agents.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryRectangular])
    }
}

@main
struct BasedWidgetBundle: WidgetBundle {
    var body: some Widget {
        CaptureWidget()
        RunningWidget()
        NeedsYouWidget()
    }
}
