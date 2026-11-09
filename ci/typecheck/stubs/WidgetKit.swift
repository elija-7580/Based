// Signature-only stub of the WidgetKit parts the watch complication uses (BSD-66).
import Foundation
import SwiftUI

public protocol TimelineEntry { var date: Date { get } }
public struct TimelineReloadPolicy: Sendable { public static let never = TimelineReloadPolicy(), atEnd = TimelineReloadPolicy(); public static func after(_ d: Date) -> TimelineReloadPolicy { .init() } }
public struct Timeline<EntryType: TimelineEntry> { public init(entries: [EntryType], policy: TimelineReloadPolicy) {} }
public struct TimelineProviderContext { public var isPreview: Bool { false } }
public protocol TimelineProvider {
    associatedtype Entry: TimelineEntry
    typealias Context = TimelineProviderContext
    func placeholder(in context: Context) -> Entry
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void)
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void)
}
public struct WidgetFamily: Hashable, Sendable { public static let accessoryCircular = WidgetFamily(), accessoryCorner = WidgetFamily(), accessoryRectangular = WidgetFamily(), accessoryInline = WidgetFamily() }
public protocol WidgetConfiguration {}
public struct StaticConfiguration<Content: View>: WidgetConfiguration {
    public init<P: TimelineProvider>(kind: String, provider: P, @ViewBuilder content: @escaping (P.Entry) -> Content) {}
}
extension WidgetConfiguration {
    public func configurationDisplayName(_ s: String) -> Self { self }
    public func description(_ s: String) -> Self { self }
    public func supportedFamilies(_ f: [WidgetFamily]) -> Self { self }
}
@MainActor @preconcurrency public protocol Widget { associatedtype Body: WidgetConfiguration; init(); var body: Body { get } }
extension Widget { @MainActor public static func main() {} }
public struct AccessoryWidgetBackground: View { public init() {}; public var body: some View { EmptyView() } }
extension View {
    public func widgetURL(_ url: URL?) -> some View { self }
    public func containerBackground<S: ShapeStyle>(_ s: S, for placement: ContainerBackgroundPlacement) -> some View { self }
}
public struct ContainerBackgroundPlacement: Sendable { public static let widget = ContainerBackgroundPlacement() }
