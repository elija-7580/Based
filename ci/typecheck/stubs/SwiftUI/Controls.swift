import UniformTypeIdentifiers

// MARK: Stacks & containers
public struct HStack<Content: View>: _PrimitiveView { public init(alignment: VerticalAlignment = .center, spacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {} }
public struct VStack<Content: View>: _PrimitiveView { public init(alignment: HorizontalAlignment = .center, spacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {} }
public struct ZStack<Content: View>: _PrimitiveView { public init(alignment: Alignment = .center, @ViewBuilder content: () -> Content) {} }
public struct LazyVStack<Content: View>: _PrimitiveView { public init(alignment: HorizontalAlignment = .center, spacing: CGFloat? = nil, pinnedViews: PinnedScrollableViews = .init(), @ViewBuilder content: () -> Content) {} }
public struct LazyHStack<Content: View>: _PrimitiveView { public init(alignment: VerticalAlignment = .center, spacing: CGFloat? = nil, pinnedViews: PinnedScrollableViews = .init(), @ViewBuilder content: () -> Content) {} }
public struct GridItem: Sendable {
    public enum Size: Sendable { case fixed(CGFloat), flexible(minimum: CGFloat = 10, maximum: CGFloat = .infinity), adaptive(minimum: CGFloat, maximum: CGFloat = .infinity) }
    public init(_ size: Size = .flexible(), spacing: CGFloat? = nil, alignment: Alignment? = nil) {}
}
public struct LazyVGrid<Content: View>: _PrimitiveView { public init(columns: [GridItem], alignment: HorizontalAlignment = .center, spacing: CGFloat? = nil, pinnedViews: PinnedScrollableViews = .init(), @ViewBuilder content: () -> Content) {} }
public struct LazyHGrid<Content: View>: _PrimitiveView { public init(rows: [GridItem], alignment: VerticalAlignment = .center, spacing: CGFloat? = nil, pinnedViews: PinnedScrollableViews = .init(), @ViewBuilder content: () -> Content) {} }
public struct Grid<Content: View>: _PrimitiveView { public init(alignment: Alignment = .center, horizontalSpacing: CGFloat? = nil, verticalSpacing: CGFloat? = nil, @ViewBuilder content: () -> Content) {} }
public struct GridRow<Content: View>: _PrimitiveView { public init(alignment: VerticalAlignment? = nil, @ViewBuilder content: () -> Content) {} }
public struct Spacer: _PrimitiveView { public init(minLength: CGFloat? = nil) {} }
public struct Divider: _PrimitiveView { public init() {} }
public struct Group<Content> { }
extension Group: View, _PrimitiveView where Content: View { public init(@ViewBuilder content: () -> Content) {} }
public struct ScrollView<Content: View>: _PrimitiveView { public init(_ axes: Axis.Set = .vertical, showsIndicators: Bool = true, @ViewBuilder content: () -> Content) {} }
public struct ScrollViewProxy { public func scrollTo<ID: Hashable>(_ id: ID, anchor: UnitPoint? = nil) {} }
public struct ScrollViewReader<Content: View>: _PrimitiveView { public init(@ViewBuilder content: @escaping (ScrollViewProxy) -> Content) {} }

public struct ForEach<Data: RandomAccessCollection, ID: Hashable, Content> { public var data: Data; public var content: (Data.Element) -> Content }
extension ForEach: View, _PrimitiveView where Content: View {}
extension ForEach where Content: View {
    public init(_ data: Data, @ViewBuilder content: @escaping (Data.Element) -> Content) where ID == Data.Element.ID, Data.Element: Identifiable { fatalError() }
    public init(_ data: Data, id: KeyPath<Data.Element, ID>, @ViewBuilder content: @escaping (Data.Element) -> Content) { fatalError() }
    public init(_ data: Range<Int>, @ViewBuilder content: @escaping (Int) -> Content) where Data == Range<Int>, ID == Int { fatalError() }
    public init<C: MutableCollection & RandomAccessCollection>(_ data: Binding<C>, @ViewBuilder content: @escaping (Binding<C.Element>) -> Content) where Data == Binding<C>, ID == C.Element.ID, C.Element: Identifiable, C.Index: Hashable { fatalError() }
    public init<C: MutableCollection & RandomAccessCollection>(_ data: Binding<C>, id: KeyPath<C.Element, ID>, @ViewBuilder content: @escaping (Binding<C.Element>) -> Content) where Data == Binding<C>, C.Index: Hashable { fatalError() }
}

public struct List<SelectionValue: Hashable, Content: View>: _PrimitiveView {
    public init(selection: Binding<Set<SelectionValue>>?, @ViewBuilder content: () -> Content) {}
    public init(selection: Binding<SelectionValue?>?, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init(selection: Binding<SelectionValue>?, @ViewBuilder content: () -> Content) {}
    public init<Data: RandomAccessCollection, RowContent: View>(_ data: Data, selection: Binding<Set<SelectionValue>>?, @ViewBuilder rowContent: @escaping (Data.Element) -> RowContent) where Content == ForEach<Data, Data.Element.ID, RowContent>, Data.Element: Identifiable {}
    public init<Data: RandomAccessCollection, RowContent: View>(_ data: Data, selection: Binding<SelectionValue?>?, @ViewBuilder rowContent: @escaping (Data.Element) -> RowContent) where Content == ForEach<Data, Data.Element.ID, RowContent>, Data.Element: Identifiable {}
}
extension List where SelectionValue == Never {
    public init(@ViewBuilder content: () -> Content) {}
    public init<Data: RandomAccessCollection, RowContent: View>(_ data: Data, @ViewBuilder rowContent: @escaping (Data.Element) -> RowContent) where Content == ForEach<Data, Data.Element.ID, RowContent>, Data.Element: Identifiable {}
    public init<Data: RandomAccessCollection, ID: Hashable, RowContent: View>(_ data: Data, id: KeyPath<Data.Element, ID>, @ViewBuilder rowContent: @escaping (Data.Element) -> RowContent) where Content == ForEach<Data, ID, RowContent> {}
}
public struct Section<Parent, Content, Footer> {}
extension Section: View, _PrimitiveView where Parent: View, Content: View, Footer: View {
    public init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Parent, @ViewBuilder footer: () -> Footer) {}
    public init(isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content, @ViewBuilder header: () -> Parent) where Footer == EmptyView {}
}
extension Section where Parent: View, Content: View, Footer == EmptyView {
    public init(@ViewBuilder content: () -> Content, @ViewBuilder header: () -> Parent) {}
}
extension Section where Parent == EmptyView, Content: View, Footer: View {
    public init(@ViewBuilder content: () -> Content, @ViewBuilder footer: () -> Footer) {}
}
extension Section where Parent == EmptyView, Content: View, Footer == EmptyView {
    public init(@ViewBuilder content: () -> Content) {}
}
extension Section where Parent == Text, Content: View, Footer == EmptyView {
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, @ViewBuilder content: () -> Content) {}
    public init(_ titleKey: LocalizedStringKey, isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, isExpanded: Binding<Bool>, @ViewBuilder content: () -> Content) {}
}
public struct Form<Content: View>: _PrimitiveView { public init(@ViewBuilder content: () -> Content) {} }
public struct GroupBox<Label: View, Content: View>: _PrimitiveView {
    public init(@ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {}
    public init(@ViewBuilder content: () -> Content) where Label == EmptyView {}
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content) where Label == Text {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, @ViewBuilder content: () -> Content) where Label == Text {}
    public init(label: Label, @ViewBuilder content: () -> Content) {}
}
public struct DisclosureGroup<Label: View, Content: View>: _PrimitiveView {
    public init(@ViewBuilder content: @escaping () -> Content, @ViewBuilder label: () -> Label) {}
    public init(isExpanded: Binding<Bool>, @ViewBuilder content: @escaping () -> Content, @ViewBuilder label: () -> Label) {}
}
extension DisclosureGroup where Label == Text {
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: @escaping () -> Content) {}
    public init(_ titleKey: LocalizedStringKey, isExpanded: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, @ViewBuilder content: @escaping () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, isExpanded: Binding<Bool>, @ViewBuilder content: @escaping () -> Content) {}
}
public struct NavigationSplitViewVisibility: Equatable, Codable, Sendable { public static let all = NavigationSplitViewVisibility(), doubleColumn = NavigationSplitViewVisibility(), detailOnly = NavigationSplitViewVisibility(), automatic = NavigationSplitViewVisibility() }
public struct NavigationSplitView<Sidebar: View, Content: View, Detail: View>: _PrimitiveView {
    public init(columnVisibility: Binding<NavigationSplitViewVisibility>, @ViewBuilder sidebar: () -> Sidebar, @ViewBuilder content: () -> Content, @ViewBuilder detail: () -> Detail) {}
    public init(@ViewBuilder sidebar: () -> Sidebar, @ViewBuilder content: () -> Content, @ViewBuilder detail: () -> Detail) {}
}
extension NavigationSplitView where Content == EmptyView {
    public init(columnVisibility: Binding<NavigationSplitViewVisibility>, @ViewBuilder sidebar: () -> Sidebar, @ViewBuilder detail: () -> Detail) {}
    public init(@ViewBuilder sidebar: () -> Sidebar, @ViewBuilder detail: () -> Detail) {}
}
public struct NavigationPath: Equatable { public init() {}; public var count: Int { 0 }; public var isEmpty: Bool { true }; public mutating func append<V: Hashable>(_ v: V) {}; public mutating func removeLast(_ k: Int = 1) {} }
public struct NavigationStack<Data, Root: View>: _PrimitiveView {
    public init(@ViewBuilder root: () -> Root) where Data == NavigationPath {}
    public init(path: Binding<NavigationPath>, @ViewBuilder root: () -> Root) where Data == NavigationPath {}
    public init(path: Binding<Data>, @ViewBuilder root: () -> Root) where Data: MutableCollection, Data: RandomAccessCollection, Data: RangeReplaceableCollection, Data.Element: Hashable {}
}
public struct NavigationLink<Label: View, Destination: View>: _PrimitiveView {
    public init(@ViewBuilder destination: () -> Destination, @ViewBuilder label: () -> Label) {}
    public init<P: Hashable>(value: P?, @ViewBuilder label: () -> Label) where Destination == Never {}
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder destination: () -> Destination) where Label == Text {}
    public init<P: Hashable>(_ titleKey: LocalizedStringKey, value: P?) where Label == Text, Destination == Never {}
}

// MARK: Controls
public enum ButtonRole: Equatable, Sendable { case destructive, cancel, close, confirm }
public struct Button<Label: View>: _PrimitiveView {
    public init(action: @escaping @MainActor () -> Void, @ViewBuilder label: () -> Label) {}
    public init(role: ButtonRole?, action: @escaping @MainActor () -> Void, @ViewBuilder label: () -> Label) {}
}
extension Button where Label == Text {
    public init(_ titleKey: LocalizedStringKey, action: @escaping @MainActor () -> Void) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, action: @escaping @MainActor () -> Void) {}
    public init(_ titleKey: LocalizedStringKey, role: ButtonRole?, action: @escaping @MainActor () -> Void) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, role: ButtonRole?, action: @escaping @MainActor () -> Void) {}
}
extension Button where Label == SwiftUI.Label<Text, Image> {
    public init(_ titleKey: LocalizedStringKey, systemImage: String, action: @escaping @MainActor () -> Void) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String, action: @escaping @MainActor () -> Void) {}
    public init(_ titleKey: LocalizedStringKey, systemImage: String, role: ButtonRole?, action: @escaping @MainActor () -> Void) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String, role: ButtonRole?, action: @escaping @MainActor () -> Void) {}
    public init(_ titleKey: LocalizedStringKey, image: String, action: @escaping @MainActor () -> Void) {}
}
public struct Label<Title: View, Icon: View>: _PrimitiveView { public init(@ViewBuilder title: () -> Title, @ViewBuilder icon: () -> Icon) {} }
extension Label where Title == Text, Icon == Image {
    public init(_ titleKey: LocalizedStringKey, systemImage: String) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String) {}
    public init(_ titleKey: LocalizedStringKey, image: String) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, image: String) {}
}
public struct Toggle<Label: View>: _PrimitiveView {
    public init(isOn: Binding<Bool>, @ViewBuilder label: () -> Label) {}
}
extension Toggle where Label == Text {
    public init(_ titleKey: LocalizedStringKey, isOn: Binding<Bool>) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, isOn: Binding<Bool>) {}
}
extension Toggle where Label == SwiftUI.Label<Text, Image> {
    public init(_ titleKey: LocalizedStringKey, systemImage: String, isOn: Binding<Bool>) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String, isOn: Binding<Bool>) {}
}
public struct Picker<Label: View, SelectionValue: Hashable, Content: View>: _PrimitiveView {
    public init(selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {}
}
extension Picker where Label == Text {
    public init(_ titleKey: LocalizedStringKey, selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content) {}
}
extension Picker where Label == SwiftUI.Label<Text, Image> {
    public init(_ titleKey: LocalizedStringKey, systemImage: String, selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String, selection: Binding<SelectionValue>, @ViewBuilder content: () -> Content) {}
}
public struct Menu<Label: View, Content: View>: _PrimitiveView {
    public init(@ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {}
    public init(@ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label, primaryAction: @escaping () -> Void) {}
}
extension Menu where Label == Text {
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, @ViewBuilder content: () -> Content) {}
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content, primaryAction: @escaping () -> Void) {}
}
extension Menu where Label == SwiftUI.Label<Text, Image> {
    public init(_ titleKey: LocalizedStringKey, systemImage: String, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage: String, @ViewBuilder content: () -> Content) {}
}
public enum TextFieldAxis {}
public struct TextField<Label: View>: _PrimitiveView {
    public init(text: Binding<String>, prompt: Text? = nil, @ViewBuilder label: () -> Label) {}
    public init(text: Binding<String>, prompt: Text? = nil, axis: Axis, @ViewBuilder label: () -> Label) {}
}
extension TextField where Label == Text {
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>) {}
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>, prompt: Text?) {}
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>, axis: Axis) {}
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>, prompt: Text?, axis: Axis) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>, prompt: Text?) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>, axis: Axis) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>, prompt: Text?, axis: Axis) {}
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>, onEditingChanged: @escaping (Bool) -> Void = { _ in }, onCommit: @escaping () -> Void = {}) {}
    public init<F: ParseableFormatStyle>(_ titleKey: LocalizedStringKey, value: Binding<F.FormatInput>, format: F, prompt: Text? = nil) where F.FormatOutput == String {}
    public init<F: ParseableFormatStyle>(_ titleKey: LocalizedStringKey, value: Binding<F.FormatInput?>, format: F, prompt: Text? = nil) where F.FormatOutput == String {}
    @_disfavoredOverload public init<S: StringProtocol, F: ParseableFormatStyle>(_ title: S, value: Binding<F.FormatInput>, format: F, prompt: Text? = nil) where F.FormatOutput == String {}
    public init<V>(_ titleKey: LocalizedStringKey, value: Binding<V>, formatter: Formatter) {}
}
public struct SecureField<Label: View>: _PrimitiveView { public init(text: Binding<String>, prompt: Text? = nil, @ViewBuilder label: () -> Label) {} }
extension SecureField where Label == Text {
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>) {}
    public init(_ titleKey: LocalizedStringKey, text: Binding<String>, prompt: Text?) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, text: Binding<String>, prompt: Text?) {}
}
public struct TextEditor: _PrimitiveView { public init(text: Binding<String>) {}; public init(text: Binding<AttributedString>, selection: Binding<AttributedTextSelection>? = nil) {} }
public struct AttributedTextSelection {}
public struct LabeledContent<Label: View, Content: View>: _PrimitiveView { public init(@ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {} }
extension LabeledContent where Label == Text {
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, @ViewBuilder content: () -> Content) {}
}
extension LabeledContent where Label == Text, Content == Text {
    public init<S: StringProtocol>(_ titleKey: LocalizedStringKey, value: S) {}
    @_disfavoredOverload public init<S1: StringProtocol, S2: StringProtocol>(_ title: S1, value: S2) {}
    public init<F: FormatStyle>(_ titleKey: LocalizedStringKey, value: F.FormatInput, format: F) where F.FormatInput: Equatable, F.FormatOutput == String {}
    @_disfavoredOverload public init<S: StringProtocol, F: FormatStyle>(_ title: S, value: F.FormatInput, format: F) where F.FormatInput: Equatable, F.FormatOutput == String {}
}
public struct DatePickerComponents: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let date = DatePickerComponents(rawValue: 1), hourAndMinute = DatePickerComponents(rawValue: 2), hourMinuteAndSecond = DatePickerComponents(rawValue: 4) }
public struct DatePicker<Label: View>: _PrimitiveView {
    public typealias Components = DatePickerComponents
    public init(selection: Binding<Date>, displayedComponents: Components = [.hourAndMinute, .date], @ViewBuilder label: () -> Label) {}
    public init(selection: Binding<Date>, in range: ClosedRange<Date>, displayedComponents: Components = [.hourAndMinute, .date], @ViewBuilder label: () -> Label) {}
}
extension DatePicker where Label == Text {
    public init(_ titleKey: LocalizedStringKey, selection: Binding<Date>, displayedComponents: Components = [.hourAndMinute, .date]) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, selection: Binding<Date>, displayedComponents: Components = [.hourAndMinute, .date]) {}
    public init(_ titleKey: LocalizedStringKey, selection: Binding<Date>, in range: ClosedRange<Date>, displayedComponents: Components = [.hourAndMinute, .date]) {}
    public init(_ titleKey: LocalizedStringKey, selection: Binding<Date>, in range: PartialRangeFrom<Date>, displayedComponents: Components = [.hourAndMinute, .date]) {}
}
public struct Stepper<Label: View>: _PrimitiveView {
    public init<V: Strideable>(value: Binding<V>, in bounds: ClosedRange<V>, step: V.Stride = 1, @ViewBuilder label: () -> Label) {}
    public init(@ViewBuilder label: () -> Label, onIncrement: (() -> Void)?, onDecrement: (() -> Void)?) {}
}
extension Stepper where Label == Text {
    public init<V: Strideable>(_ titleKey: LocalizedStringKey, value: Binding<V>, in bounds: ClosedRange<V>, step: V.Stride = 1) {}
    @_disfavoredOverload public init<S: StringProtocol, V: Strideable>(_ title: S, value: Binding<V>, in bounds: ClosedRange<V>, step: V.Stride = 1) {}
    public init<V: Strideable>(_ titleKey: LocalizedStringKey, value: Binding<V>, step: V.Stride = 1) {}
    @_disfavoredOverload public init<S: StringProtocol, V: Strideable>(_ title: S, value: Binding<V>, step: V.Stride = 1) {}
}
public struct Slider<Label: View, ValueLabel: View>: _PrimitiveView {
    public init<V: BinaryFloatingPoint>(value: Binding<V>, in bounds: ClosedRange<V> = 0...1, @ViewBuilder label: () -> Label) where V.Stride: BinaryFloatingPoint, ValueLabel == EmptyView {}
    public init<V: BinaryFloatingPoint>(value: Binding<V>, in bounds: ClosedRange<V>, step: V.Stride = 1, @ViewBuilder label: () -> Label) where V.Stride: BinaryFloatingPoint, ValueLabel == EmptyView {}
}
extension Slider where Label == EmptyView, ValueLabel == EmptyView {
    public init<V: BinaryFloatingPoint>(value: Binding<V>, in bounds: ClosedRange<V> = 0...1, onEditingChanged: @escaping (Bool) -> Void = { _ in }) where V.Stride: BinaryFloatingPoint {}
    public init<V: BinaryFloatingPoint>(value: Binding<V>, in bounds: ClosedRange<V>, step: V.Stride = 1, onEditingChanged: @escaping (Bool) -> Void = { _ in }) where V.Stride: BinaryFloatingPoint {}
}
public struct ProgressView<Label: View, CurrentValueLabel: View>: _PrimitiveView {
    public init<V: BinaryFloatingPoint>(value: V?, total: V = 1.0, @ViewBuilder label: () -> Label) where CurrentValueLabel == EmptyView {}
    public init(@ViewBuilder label: () -> Label) where CurrentValueLabel == EmptyView {}
}
extension ProgressView where Label == EmptyView, CurrentValueLabel == EmptyView {
    public init() {}
    public init<V: BinaryFloatingPoint>(value: V?, total: V = 1.0) {}
    public init(_ progress: Progress) {}
}
extension ProgressView where Label == Text, CurrentValueLabel == EmptyView {
    public init(_ titleKey: LocalizedStringKey) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S) {}
    public init<V: BinaryFloatingPoint>(_ titleKey: LocalizedStringKey, value: V?, total: V = 1.0) {}
    @_disfavoredOverload public init<S: StringProtocol, V: BinaryFloatingPoint>(_ title: S, value: V?, total: V = 1.0) {}
}
public struct ContentUnavailableView<Label: View, Description: View, Actions: View>: _PrimitiveView {
    public init(@ViewBuilder label: () -> Label, @ViewBuilder description: () -> Description = { EmptyView() }, @ViewBuilder actions: () -> Actions = { EmptyView() }) {}
}
extension ContentUnavailableView where Label == SwiftUI.Label<Text, Image>, Description == Text?, Actions == EmptyView {
    public init(_ titleKey: LocalizedStringKey, systemImage name: String, description: Text? = nil) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, systemImage name: String, description: Text? = nil) {}
    public static var search: ContentUnavailableView<SwiftUI.Label<Text, Image>, Text?, EmptyView> { fatalError() }
    public static func search(text: String) -> ContentUnavailableView<SwiftUI.Label<Text, Image>, Text?, EmptyView> { fatalError() }
}
public struct Link<Label: View>: _PrimitiveView { public init(destination: URL, @ViewBuilder label: () -> Label) {} }
extension Link where Label == Text {
    public init(_ titleKey: LocalizedStringKey, destination: URL) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, destination: URL) {}
}
public struct SharePreview<Image, Icon> { public init(_ titleKey: LocalizedStringKey) where Image == Never, Icon == Never {}; public init<S: StringProtocol>(_ title: S) where Image == Never, Icon == Never {} }
public struct ShareLink<Data: RandomAccessCollection, PreviewImage, PreviewIcon, Label: View>: _PrimitiveView where Data.Element: Transferable {}
extension ShareLink {
    public init<I: Transferable>(item: I, subject: Text? = nil, message: Text? = nil, @ViewBuilder label: () -> Label) where Data == CollectionOfOne<I>, PreviewImage == Never, PreviewIcon == Never {}
}
extension ShareLink where Label == DefaultShareLinkLabel {
    public init<I: Transferable>(item: I, subject: Text? = nil, message: Text? = nil) where Data == CollectionOfOne<I>, PreviewImage == Never, PreviewIcon == Never {}
    public init<I: Transferable>(_ titleKey: LocalizedStringKey, item: I, subject: Text? = nil, message: Text? = nil) where Data == CollectionOfOne<I>, PreviewImage == Never, PreviewIcon == Never {}
}
public struct DefaultShareLinkLabel: _PrimitiveView {}
public enum AsyncImagePhase { case empty, success(Image), failure(Error); public var image: Image? { nil }; public var error: Error? { nil } }
public struct AsyncImage<Content: View>: _PrimitiveView {
    public init(url: URL?, scale: CGFloat = 1) where Content == Image {}
    public init<I: View, P: View>(url: URL?, scale: CGFloat = 1, @ViewBuilder content: @escaping (Image) -> I, @ViewBuilder placeholder: @escaping () -> P) where Content == _ConditionalContent<I, P> {}
    public init(url: URL?, scale: CGFloat = 1, transaction: Transaction = Transaction(), @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {}
}
public protocol TimelineSchedule { associatedtype Entries: Sequence where Entries.Element == Date }
public struct PeriodicTimelineSchedule: TimelineSchedule { public typealias Entries = [Date]; public init(from: Date, by: TimeInterval) {} }
public struct EveryMinuteTimelineSchedule: TimelineSchedule { public typealias Entries = [Date] }
public struct AnimationTimelineSchedule: TimelineSchedule { public typealias Entries = [Date]; public init(minimumInterval: Double? = nil, paused: Bool = false) {} }
extension TimelineSchedule where Self == PeriodicTimelineSchedule { public static func periodic(from: Date, by: TimeInterval) -> PeriodicTimelineSchedule { .init(from: from, by: by) } }
extension TimelineSchedule where Self == EveryMinuteTimelineSchedule { public static var everyMinute: EveryMinuteTimelineSchedule { .init() } }
extension TimelineSchedule where Self == AnimationTimelineSchedule { public static var animation: AnimationTimelineSchedule { .init() }; public static func animation(minimumInterval: Double? = nil, paused: Bool = false) -> AnimationTimelineSchedule { .init() } }
public struct TimelineViewDefaultContext { public var date: Date { Date() } }
public struct TimelineView<Schedule: TimelineSchedule, Content>: _PrimitiveView { public typealias Context = TimelineViewDefaultContext }
extension TimelineView where Content: View { public init(_ schedule: Schedule, @ViewBuilder content: @escaping (TimelineViewDefaultContext) -> Content) {} }

// MARK: Styles
@MainActor @preconcurrency public protocol ButtonStyle { associatedtype Body: View; @ViewBuilder func makeBody(configuration: Configuration) -> Body; typealias Configuration = ButtonStyleConfiguration }
public struct ButtonStyleConfiguration { public struct Label: _PrimitiveView {}; public var label: Label { Label() }; public var isPressed: Bool { false }; public var role: ButtonRole? { nil } }
@MainActor @preconcurrency public protocol PrimitiveButtonStyle { associatedtype Body: View; @ViewBuilder func makeBody(configuration: Configuration) -> Body; typealias Configuration = PrimitiveButtonStyleConfiguration }
public struct PrimitiveButtonStyleConfiguration { public struct Label: _PrimitiveView {}; public var label: Label { Label() }; public var role: ButtonRole? { nil }; public func trigger() {} }
public struct PlainButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct BorderlessButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct BorderedButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct BorderedProminentButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct LinkButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct DefaultButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct AccessoryBarButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
public struct AccessoryBarActionButtonStyle: PrimitiveButtonStyle { public init() {}; public func makeBody(configuration: Configuration) -> EmptyView { EmptyView() } }
extension PrimitiveButtonStyle where Self == PlainButtonStyle { public static var plain: PlainButtonStyle { .init() } }
extension PrimitiveButtonStyle where Self == BorderlessButtonStyle { public static var borderless: BorderlessButtonStyle { .init() } }
extension PrimitiveButtonStyle where Self == BorderedButtonStyle { public static var bordered: BorderedButtonStyle { .init() } }
extension PrimitiveButtonStyle where Self == BorderedProminentButtonStyle { public static var borderedProminent: BorderedProminentButtonStyle { .init() } }
#if !STUB_IOS   // .link gibt es auf iOS nicht
extension PrimitiveButtonStyle where Self == LinkButtonStyle { public static var link: LinkButtonStyle { .init() } }
#endif
extension PrimitiveButtonStyle where Self == DefaultButtonStyle { public static var automatic: DefaultButtonStyle { .init() } }
extension PrimitiveButtonStyle where Self == AccessoryBarButtonStyle { public static var accessoryBar: AccessoryBarButtonStyle { .init() } }
extension PrimitiveButtonStyle where Self == AccessoryBarActionButtonStyle { public static var accessoryBarAction: AccessoryBarActionButtonStyle { .init() } }

public protocol TextFieldStyle {}
public struct PlainTextFieldStyle: TextFieldStyle { public init() {} }
public struct RoundedBorderTextFieldStyle: TextFieldStyle { public init() {} }
public struct SquareBorderTextFieldStyle: TextFieldStyle { public init() {} }
public struct DefaultTextFieldStyle: TextFieldStyle { public init() {} }
extension TextFieldStyle where Self == PlainTextFieldStyle { public static var plain: PlainTextFieldStyle { .init() } }
extension TextFieldStyle where Self == RoundedBorderTextFieldStyle { public static var roundedBorder: RoundedBorderTextFieldStyle { .init() } }
extension TextFieldStyle where Self == SquareBorderTextFieldStyle { public static var squareBorder: SquareBorderTextFieldStyle { .init() } }
extension TextFieldStyle where Self == DefaultTextFieldStyle { public static var automatic: DefaultTextFieldStyle { .init() } }
public protocol ToggleStyle {}
public struct SwitchToggleStyle: ToggleStyle { public init() {} }
public struct CheckboxToggleStyle: ToggleStyle { public init() {} }
public struct ButtonToggleStyle: ToggleStyle { public init() {} }
public struct DefaultToggleStyle: ToggleStyle { public init() {} }
extension ToggleStyle where Self == SwitchToggleStyle { public static var `switch`: SwitchToggleStyle { .init() } }
extension ToggleStyle where Self == CheckboxToggleStyle { public static var checkbox: CheckboxToggleStyle { .init() } }
extension ToggleStyle where Self == ButtonToggleStyle { public static var button: ButtonToggleStyle { .init() } }
extension ToggleStyle where Self == DefaultToggleStyle { public static var automatic: DefaultToggleStyle { .init() } }
public protocol PickerStyle {}
public struct SegmentedPickerStyle: PickerStyle { public init() {} }
public struct MenuPickerStyle: PickerStyle { public init() {} }
public struct InlinePickerStyle: PickerStyle { public init() {} }
public struct RadioGroupPickerStyle: PickerStyle { public init() {} }
public struct PalettePickerStyle: PickerStyle { public init() {} }
public struct DefaultPickerStyle: PickerStyle { public init() {} }
extension PickerStyle where Self == SegmentedPickerStyle { public static var segmented: SegmentedPickerStyle { .init() } }
extension PickerStyle where Self == MenuPickerStyle { public static var menu: MenuPickerStyle { .init() } }
extension PickerStyle where Self == InlinePickerStyle { public static var inline: InlinePickerStyle { .init() } }
extension PickerStyle where Self == RadioGroupPickerStyle { public static var radioGroup: RadioGroupPickerStyle { .init() } }
extension PickerStyle where Self == PalettePickerStyle { public static var palette: PalettePickerStyle { .init() } }
extension PickerStyle where Self == DefaultPickerStyle { public static var automatic: DefaultPickerStyle { .init() } }
public protocol MenuStyle {}
public struct BorderlessButtonMenuStyle: MenuStyle { public init() {} }
public struct ButtonMenuStyle: MenuStyle { public init() {} }
public struct DefaultMenuStyle: MenuStyle { public init() {} }
extension MenuStyle where Self == BorderlessButtonMenuStyle { public static var borderlessButton: BorderlessButtonMenuStyle { .init() } }
extension MenuStyle where Self == ButtonMenuStyle { public static var button: ButtonMenuStyle { .init() } }
extension MenuStyle where Self == DefaultMenuStyle { public static var automatic: DefaultMenuStyle { .init() } }
public protocol ListStyle {}
public struct SidebarListStyle: ListStyle { public init() {} }
public struct PlainListStyle: ListStyle { public init() {} }
public struct InsetListStyle: ListStyle { public init() {}; public init(alternatesRowBackgrounds: Bool) {} }
public struct BorderedListStyle: ListStyle { public init() {} }
public struct DefaultListStyle: ListStyle { public init() {} }
extension ListStyle where Self == SidebarListStyle { public static var sidebar: SidebarListStyle { .init() } }
extension ListStyle where Self == PlainListStyle { public static var plain: PlainListStyle { .init() } }
extension ListStyle where Self == InsetListStyle { public static var inset: InsetListStyle { .init() }; public static func inset(alternatesRowBackgrounds: Bool) -> InsetListStyle { .init() } }
extension ListStyle where Self == BorderedListStyle { public static var bordered: BorderedListStyle { .init() } }
extension ListStyle where Self == DefaultListStyle { public static var automatic: DefaultListStyle { .init() } }
public protocol FormStyle {}
public struct GroupedFormStyle: FormStyle { public init() {} }
public struct ColumnsFormStyle: FormStyle { public init() {} }
public struct AutomaticFormStyle: FormStyle { public init() {} }
extension FormStyle where Self == GroupedFormStyle { public static var grouped: GroupedFormStyle { .init() } }
extension FormStyle where Self == ColumnsFormStyle { public static var columns: ColumnsFormStyle { .init() } }
extension FormStyle where Self == AutomaticFormStyle { public static var automatic: AutomaticFormStyle { .init() } }
public protocol LabelStyle {}
public struct IconOnlyLabelStyle: LabelStyle { public init() {} }
public struct TitleOnlyLabelStyle: LabelStyle { public init() {} }
public struct TitleAndIconLabelStyle: LabelStyle { public init() {} }
public struct DefaultLabelStyle: LabelStyle { public init() {} }
extension LabelStyle where Self == IconOnlyLabelStyle { public static var iconOnly: IconOnlyLabelStyle { .init() } }
extension LabelStyle where Self == TitleOnlyLabelStyle { public static var titleOnly: TitleOnlyLabelStyle { .init() } }
extension LabelStyle where Self == TitleAndIconLabelStyle { public static var titleAndIcon: TitleAndIconLabelStyle { .init() } }
extension LabelStyle where Self == DefaultLabelStyle { public static var automatic: DefaultLabelStyle { .init() } }
public protocol DatePickerStyle {}
public struct FieldDatePickerStyle: DatePickerStyle { public init() {} }
public struct CompactDatePickerStyle: DatePickerStyle { public init() {} }
public struct GraphicalDatePickerStyle: DatePickerStyle { public init() {} }
public struct StepperFieldDatePickerStyle: DatePickerStyle { public init() {} }
public struct DefaultDatePickerStyle: DatePickerStyle { public init() {} }
extension DatePickerStyle where Self == FieldDatePickerStyle { public static var field: FieldDatePickerStyle { .init() } }
extension DatePickerStyle where Self == CompactDatePickerStyle { public static var compact: CompactDatePickerStyle { .init() } }
extension DatePickerStyle where Self == GraphicalDatePickerStyle { public static var graphical: GraphicalDatePickerStyle { .init() } }
extension DatePickerStyle where Self == StepperFieldDatePickerStyle { public static var stepperField: StepperFieldDatePickerStyle { .init() } }
extension DatePickerStyle where Self == DefaultDatePickerStyle { public static var automatic: DefaultDatePickerStyle { .init() } }
public protocol ProgressViewStyle {}
public struct LinearProgressViewStyle: ProgressViewStyle { public init() {} }
public struct CircularProgressViewStyle: ProgressViewStyle { public init() {} }
extension ProgressViewStyle where Self == LinearProgressViewStyle { public static var linear: LinearProgressViewStyle { .init() } }
extension ProgressViewStyle where Self == CircularProgressViewStyle { public static var circular: CircularProgressViewStyle { .init() } }
public protocol NavigationSplitViewStyle {}
public struct BalancedNavigationSplitViewStyle: NavigationSplitViewStyle { public init() {} }
public struct ProminentDetailNavigationSplitViewStyle: NavigationSplitViewStyle { public init() {} }
extension NavigationSplitViewStyle where Self == BalancedNavigationSplitViewStyle { public static var balanced: BalancedNavigationSplitViewStyle { .init() } }
extension NavigationSplitViewStyle where Self == ProminentDetailNavigationSplitViewStyle { public static var prominentDetail: ProminentDetailNavigationSplitViewStyle { .init() } }
public protocol GroupBoxStyle {}
public struct DefaultGroupBoxStyle: GroupBoxStyle { public init() {} }
extension GroupBoxStyle where Self == DefaultGroupBoxStyle { public static var automatic: DefaultGroupBoxStyle { .init() } }
public struct MenuIndicatorVisibility {}
public struct TextSelectability { public static let enabled = TextSelectability(), disabled = TextSelectability() }
public struct SubmitTriggers: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let text = SubmitTriggers(rawValue: 1), search = SubmitTriggers(rawValue: 2) }
public struct AccessibilityTraits: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let isButton = AccessibilityTraits(rawValue: 1), isHeader = AccessibilityTraits(rawValue: 2), isSelected = AccessibilityTraits(rawValue: 4), isLink = AccessibilityTraits(rawValue: 8), isStaticText = AccessibilityTraits(rawValue: 16), isImage = AccessibilityTraits(rawValue: 32), isToggle = AccessibilityTraits(rawValue: 64) }
public struct AccessibilityChildBehavior { public static let ignore = AccessibilityChildBehavior(), combine = AccessibilityChildBehavior(), contain = AccessibilityChildBehavior() }
public struct ContentShapeKinds: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let interaction = ContentShapeKinds(rawValue: 1), dragPreview = ContentShapeKinds(rawValue: 2), contextMenuPreview = ContentShapeKinds(rawValue: 4), hoverEffect = ContentShapeKinds(rawValue: 8), focusEffect = ContentShapeKinds(rawValue: 16), accessibility = ContentShapeKinds(rawValue: 32) }
public struct PresentationDetent: Hashable, Sendable { public static let medium = PresentationDetent(), large = PresentationDetent(); public static func height(_ h: CGFloat) -> PresentationDetent { .init() }; public static func fraction(_ f: CGFloat) -> PresentationDetent { .init() } }
public struct PresentationAdaptation: Sendable { public static let automatic = PresentationAdaptation(), none = PresentationAdaptation(), popover = PresentationAdaptation(), sheet = PresentationAdaptation(), fullScreenCover = PresentationAdaptation() }
public enum PopoverAttachmentAnchor { case rect(Anchor<CGRect>.Source), point(UnitPoint) }
public struct ToolbarPlacement { public static let automatic = ToolbarPlacement(), windowToolbar = ToolbarPlacement() }
public struct ToolbarDefaultItemKind { public static let sidebarToggle = ToolbarDefaultItemKind(), title = ToolbarDefaultItemKind() }
extension ForEach where Content: View {
    public func onMove(perform action: ((IndexSet, Int) -> Void)?) -> ForEach { self }
    public func onDelete(perform action: ((IndexSet) -> Void)?) -> ForEach { self }
    public func onInsert(of types: [UTType], perform action: @escaping (Int, [NSItemProvider]) -> Void) -> ForEach { self }
}

public struct PointerStyle { public static var link: PointerStyle { .init() } }
