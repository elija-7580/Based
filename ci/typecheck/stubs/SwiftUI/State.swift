import UniformTypeIdentifiers

// MARK: Property wrappers
@propertyWrapper public struct State<Value>: DynamicProperty {
    public init(wrappedValue: Value) { fatalError() }
    public init(initialValue: Value) { fatalError() }
    public var wrappedValue: Value { get { fatalError() } nonmutating set {} }
    public var projectedValue: Binding<Value> { fatalError() }
}
extension State where Value: ExpressibleByNilLiteral { public init() { fatalError() } }

@propertyWrapper @dynamicMemberLookup public struct Binding<Value> {
    public init(get: @escaping () -> Value, set: @escaping (Value) -> Void) { fatalError() }
    public init(get: @escaping () -> Value, set: @escaping (Value, Transaction) -> Void) { fatalError() }
    public init(projectedValue: Binding<Value>) { self = projectedValue }
    public static func constant(_ value: Value) -> Binding<Value> { fatalError() }
    public var wrappedValue: Value { get { fatalError() } nonmutating set {} }
    public var projectedValue: Binding<Value> { self }
    public subscript<Subject>(dynamicMember keyPath: WritableKeyPath<Value, Subject>) -> Binding<Subject> { fatalError() }
    public init<V>(_ base: Binding<V>) where Value == V? { fatalError() }
    public init?(_ base: Binding<Value?>) { fatalError() }
    public init<V: Hashable>(_ base: Binding<V>) where Value == AnyHashable { fatalError() }
    public func animation(_ animation: Animation? = .default) -> Binding<Value> { self }
    public func transaction(_ t: Transaction) -> Binding<Value> { self }
}
extension Binding: Identifiable where Value: Identifiable { public var id: Value.ID { fatalError() } }
extension Binding: Sequence where Value: MutableCollection {
    public typealias Element = Binding<Value.Element>
    public typealias Iterator = IndexingIterator<Binding<Value>>
    public typealias SubSequence = Slice<Binding<Value>>
}
extension Binding: Collection where Value: MutableCollection {
    public typealias Index = Value.Index
    public typealias Indices = Value.Indices
    public var startIndex: Index { fatalError() }
    public var endIndex: Index { fatalError() }
    public var indices: Value.Indices { fatalError() }
    public func index(after i: Index) -> Index { fatalError() }
    public subscript(position: Index) -> Binding<Value.Element> { fatalError() }
}
extension Binding: BidirectionalCollection where Value: BidirectionalCollection, Value: MutableCollection { public func index(before i: Index) -> Index { fatalError() } }
extension Binding: RandomAccessCollection where Value: MutableCollection, Value: RandomAccessCollection {}

@propertyWrapper @dynamicMemberLookup public struct Bindable<Value> {
    public init(wrappedValue: Value) where Value: AnyObject & Observable { fatalError() }
    public init(_ wrappedValue: Value) where Value: AnyObject & Observable { fatalError() }
    public init(projectedValue: Bindable<Value>) { fatalError() }
    public var wrappedValue: Value
    public var projectedValue: Bindable<Value> { self }
    public subscript<Subject>(dynamicMember keyPath: ReferenceWritableKeyPath<Value, Subject>) -> Binding<Subject> where Value: AnyObject { fatalError() }
}

@propertyWrapper public struct AppStorage<Value>: DynamicProperty {
    public init(__stub: ()) {}
    public var wrappedValue: Value { get { fatalError() } nonmutating set {} }
    public var projectedValue: Binding<Value> { fatalError() }
}
extension AppStorage {
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == Bool { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == Int { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == Double { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == String { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == URL { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == Data { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value == Date { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value: RawRepresentable, Value.RawValue == Int { fatalError() }
    public init(wrappedValue: Value, _ key: String, store: UserDefaults? = nil) where Value: RawRepresentable, Value.RawValue == String { fatalError() }
}
extension AppStorage where Value: ExpressibleByNilLiteral {
    public init(_ key: String, store: UserDefaults? = nil) where Value == Bool? { fatalError() }
    public init(_ key: String, store: UserDefaults? = nil) where Value == Int? { fatalError() }
    public init(_ key: String, store: UserDefaults? = nil) where Value == Double? { fatalError() }
    public init(_ key: String, store: UserDefaults? = nil) where Value == String? { fatalError() }
    public init(_ key: String, store: UserDefaults? = nil) where Value == URL? { fatalError() }
    public init(_ key: String, store: UserDefaults? = nil) where Value == Data? { fatalError() }
}
@propertyWrapper public struct SceneStorage<Value>: DynamicProperty {
    public init(wrappedValue: Value, _ key: String) where Value == String { fatalError() }
    public init(wrappedValue: Value, _ key: String) where Value == Bool { fatalError() }
    public init(wrappedValue: Value, _ key: String) where Value == Int { fatalError() }
    public var wrappedValue: Value { get { fatalError() } nonmutating set {} }
    public var projectedValue: Binding<Value> { fatalError() }
}
@propertyWrapper public struct FocusState<Value: Hashable>: DynamicProperty {
    @propertyWrapper public struct Binding { public init(__stub: ()) {}; public var wrappedValue: Value { get { fatalError() } nonmutating set {} }; public var projectedValue: FocusState<Value>.Binding { self } }
    public init() where Value == Bool { fatalError() }
    public init<T: Hashable>() where Value == T? { fatalError() }
    public var wrappedValue: Value { get { fatalError() } nonmutating set {} }
    public var projectedValue: FocusState<Value>.Binding { fatalError() }
}
@propertyWrapper public struct GestureState<Value>: DynamicProperty {
    public init(wrappedValue: Value) { fatalError() }
    public init(initialValue: Value) { fatalError() }
    public var wrappedValue: Value { fatalError() }
    public var projectedValue: GestureState<Value> { self }
}
@propertyWrapper public struct ObservedObject<ObjectType: ObservableObject>: DynamicProperty {
    public init(wrappedValue: ObjectType) { fatalError() }
    public var wrappedValue: ObjectType
    public var projectedValue: Wrapper { fatalError() }
    @dynamicMemberLookup public struct Wrapper { public subscript<Subject>(dynamicMember keyPath: ReferenceWritableKeyPath<ObjectType, Subject>) -> Binding<Subject> { fatalError() } }
}
@propertyWrapper public struct StateObject<ObjectType: ObservableObject>: DynamicProperty {
    public init(wrappedValue thunk: @autoclosure @escaping () -> ObjectType) { fatalError() }
    public var wrappedValue: ObjectType { fatalError() }
    public var projectedValue: ObservedObject<ObjectType>.Wrapper { fatalError() }
}
@propertyWrapper public struct EnvironmentObject<ObjectType: ObservableObject>: DynamicProperty {
    public init() { fatalError() }
    public var wrappedValue: ObjectType { fatalError() }
    public var projectedValue: ObservedObject<ObjectType>.Wrapper { fatalError() }
}

// MARK: Environment
public protocol EnvironmentKey { associatedtype Value; static var defaultValue: Value { get } }
@propertyWrapper public struct Environment<Value>: DynamicProperty {
    public init(_ keyPath: KeyPath<EnvironmentValues, Value>) { fatalError() }
    public init(_ objectType: Value.Type) where Value: AnyObject & Observable { fatalError() }
    public init<T: AnyObject & Observable>(_ objectType: T.Type) where Value == T? { fatalError() }
    public var wrappedValue: Value { fatalError() }
}
public struct OpenURLAction { public struct Result { public static let handled = Result(), discarded = Result(), systemAction = Result() }; public init(handler: @escaping (URL) -> Result) {}; public func callAsFunction(_ url: URL) {}; public func callAsFunction(_ url: URL, completion: @escaping (Bool) -> Void) {} }
public struct DismissAction { public func callAsFunction() {} }
public struct OpenWindowAction { public func callAsFunction(id: String) {}; public func callAsFunction<D: Decodable & Encodable & Hashable>(value: D) {}; public func callAsFunction<D: Decodable & Encodable & Hashable>(id: String, value: D) {} }
public struct DismissWindowAction { public func callAsFunction() {}; public func callAsFunction(id: String) {} }
public struct OpenSettingsAction { public func callAsFunction() {} }
public struct RefreshAction { public func callAsFunction() async {} }
public struct EnvironmentValues {
    public init() {}
    public subscript<K: EnvironmentKey>(key: K.Type) -> K.Value { get { fatalError() } set {} }
    public var colorScheme: ColorScheme = .light
    public var colorSchemeContrast: ColorSchemeContrast { .standard }
    public var openURL: OpenURLAction { get { fatalError() } set {} }
    public var dismiss: DismissAction { fatalError() }
    public var openWindow: OpenWindowAction { fatalError() }
    public var dismissWindow: DismissWindowAction { fatalError() }
    public var openSettings: OpenSettingsAction { fatalError() }
    public var refresh: RefreshAction? { nil }
    public var isEnabled: Bool = true
    public var isPresented: Bool { false }
    public var isFocused: Bool { false }
    public var isSearching: Bool { false }
    public var scenePhase: ScenePhase = .active
    public var locale: Locale = .current
    public var calendar: Calendar = .current
    public var timeZone: TimeZone = .current
    public var undoManager: UndoManager? { nil }
    public var controlActiveState: ControlActiveState = .key
    public var displayScale: CGFloat = 2
    public var layoutDirection: LayoutDirection = .leftToRight
    public var accessibilityReduceMotion: Bool { false }
    public var dynamicTypeSize: DynamicTypeSize = .large
    public var font: Font? = nil
    public var lineLimit: Int? = nil
    public var supportsMultipleWindows: Bool { true }
    public var controlSize: ControlSize = .regular
}

// MARK: Preferences & layout
public protocol PreferenceKey { associatedtype Value; static var defaultValue: Value { get }; static func reduce(value: inout Value, nextValue: () -> Value) }
public protocol Animatable {}
public protocol Layout: Animatable {
    associatedtype Cache = Void
    typealias Subviews = LayoutSubviews
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache)
    func makeCache(subviews: Subviews) -> Cache
    func updateCache(_ cache: inout Cache, subviews: Subviews)
    func spacing(subviews: Subviews, cache: inout Cache) -> ViewSpacing
}
extension Layout where Cache == () { public func makeCache(subviews: Subviews) -> Cache { () } }
extension Layout {
    public func updateCache(_ cache: inout Cache, subviews: Subviews) {}
    public func spacing(subviews: Subviews, cache: inout Cache) -> ViewSpacing { ViewSpacing() }
    public func callAsFunction<V: View>(@ViewBuilder _ content: () -> V) -> _V<V> { .init() }
}
public struct ViewSpacing: Sendable { public init() {}; public func distance(to next: ViewSpacing, along axis: Axis) -> CGFloat { 0 } }
public struct LayoutSubview: Equatable {
    public func sizeThatFits(_ proposal: ProposedViewSize) -> CGSize { .zero }
    public func dimensions(in proposal: ProposedViewSize) -> ViewDimensions { ViewDimensions() }
    public func place(at position: CGPoint, anchor: UnitPoint = .topLeading, proposal: ProposedViewSize) {}
    public var priority: Double { 0 }
    public var spacing: ViewSpacing { ViewSpacing() }
    public subscript<K: LayoutValueKey>(key: K.Type) -> K.Value { fatalError() }
}
public protocol LayoutValueKey { associatedtype Value; static var defaultValue: Value { get } }
public struct LayoutSubviews: RandomAccessCollection, Equatable {
    public var startIndex: Int { 0 }
    public var endIndex: Int { 0 }
    public subscript(i: Int) -> LayoutSubview { fatalError() }
    public subscript(r: Range<Int>) -> LayoutSubviews { self }
}
public struct AnyLayout: Layout { public init<L: Layout>(_ l: L) {}; public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { .zero }; public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {} }
public struct HStackLayout: Layout { public init(alignment: VerticalAlignment = .center, spacing: CGFloat? = nil) {}; public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { .zero }; public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {} }
public struct VStackLayout: Layout { public init(alignment: HorizontalAlignment = .center, spacing: CGFloat? = nil) {}; public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { .zero }; public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {} }
public struct ZStackLayout: Layout { public init(alignment: Alignment = .center) {}; public func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { .zero }; public func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {} }

// MARK: Gestures
public struct GestureMask: OptionSet, Sendable { public let rawValue: UInt32; public init(rawValue: UInt32) { self.rawValue = rawValue }; public static let none = GestureMask([]), gesture = GestureMask(rawValue: 1), subviews = GestureMask(rawValue: 2), all = GestureMask(rawValue: 3) }
public protocol Gesture<Value> { associatedtype Value; associatedtype Body: Gesture }
public struct _G<T, V>: Gesture { public typealias Value = V; public typealias Body = Never }
extension Never: Gesture { public typealias Value = Never }
extension Gesture {
    public func onChanged(_ action: @escaping (Value) -> Void) -> _G<Self, Value> where Value: Equatable { .init() }
    public func onEnded(_ action: @escaping (Value) -> Void) -> _G<Self, Value> { .init() }
    public func updating<State>(_ state: GestureState<State>, body: @escaping (Value, inout State, inout Transaction) -> Void) -> _G<Self, Value> { .init() }
    public func simultaneously<O: Gesture>(with other: O) -> _G<Self, (Value?, O.Value?)> { .init() }
    public func exclusively<O: Gesture>(before other: O) -> _G<Self, Value> { .init() }
    public func sequenced<O: Gesture>(before other: O) -> _G<Self, Value> { .init() }
    public func modifiers(_ m: EventModifiers) -> _G<Self, Value> { .init() }
    public func map<T>(_ body: @escaping (Value) -> T) -> _G<Self, T> { .init() }
}
public struct DragGesture: Gesture {
    public struct Value: Equatable, Sendable { public var time: Date; public var location: CGPoint; public var startLocation: CGPoint; public var translation: CGSize; public var velocity: CGSize; public var predictedEndLocation: CGPoint; public var predictedEndTranslation: CGSize }
    public typealias Body = Never
    public init(minimumDistance: CGFloat = 10, coordinateSpace: CoordinateSpace = .local) {}
    public init(minimumDistance: CGFloat = 10, coordinateSpace: some CoordinateSpaceProtocol) {}
}
public struct TapGesture: Gesture { public typealias Value = Void; public typealias Body = Never; public init(count: Int = 1) {} }
public struct SpatialTapGesture: Gesture { public struct Value: Equatable { public var location: CGPoint }; public typealias Body = Never; public init(count: Int = 1, coordinateSpace: CoordinateSpace = .local) {} }
public struct LongPressGesture: Gesture { public typealias Value = Bool; public typealias Body = Never; public init(minimumDuration: Double = 0.5, maximumDistance: CGFloat = 10) {} }
public struct MagnifyGesture: Gesture { public struct Value: Equatable { public var magnification: CGFloat }; public typealias Body = Never; public init(minimumScaleDelta: CGFloat = 0.01) {} }

public struct EventModifiers: OptionSet, Hashable, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let capsLock = EventModifiers(rawValue: 1), shift = EventModifiers(rawValue: 2), control = EventModifiers(rawValue: 4), option = EventModifiers(rawValue: 8), command = EventModifiers(rawValue: 16), numericPad = EventModifiers(rawValue: 32), function = EventModifiers(rawValue: 64), all = EventModifiers(rawValue: 127) }
public struct KeyEquivalent: Hashable, Sendable, ExpressibleByExtendedGraphemeClusterLiteral {
    public var character: Character
    public init(_ character: Character) { self.character = character }
    public init(extendedGraphemeClusterLiteral c: Character) { character = c }
    public static let `return` = KeyEquivalent("\r"), escape = KeyEquivalent("\u{1B}"), delete = KeyEquivalent("\u{7F}"), deleteForward = KeyEquivalent("\u{F728}"), tab = KeyEquivalent("\t"), space = KeyEquivalent(" "), upArrow = KeyEquivalent("\u{F700}"), downArrow = KeyEquivalent("\u{F701}"), leftArrow = KeyEquivalent("\u{F702}"), rightArrow = KeyEquivalent("\u{F703}"), home = KeyEquivalent("\u{F729}"), end = KeyEquivalent("\u{F72B}"), pageUp = KeyEquivalent("\u{F72C}"), pageDown = KeyEquivalent("\u{F72D}"), clear = KeyEquivalent("\u{F739}")
}
public struct KeyboardShortcut: Hashable, Sendable {
    public init(_ key: KeyEquivalent, modifiers: EventModifiers = .command) {}
    public static let defaultAction = KeyboardShortcut("\r", modifiers: []), cancelAction = KeyboardShortcut("\u{1B}", modifiers: [])
    public var key: KeyEquivalent { "a" }
    public var modifiers: EventModifiers { [] }
}
public struct KeyPress: Sendable {
    public enum Result: Sendable { case handled, ignored }
    public struct Phases: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let down = Phases(rawValue: 1), `repeat` = Phases(rawValue: 2), up = Phases(rawValue: 4), all = Phases(rawValue: 7) }
    public var key: KeyEquivalent { "a" }
    public var characters: String { "" }
    public var modifiers: EventModifiers { [] }
    public var phase: Phases { .down }
}
public enum HoverPhase: Equatable { case active(CGPoint), ended }
public enum MoveCommandDirection: Sendable { case up, down, left, right }

// MARK: Drag & drop
public struct DropInfo {
    public var location: CGPoint { .zero }
    public func hasItemsConforming(to types: [UTType]) -> Bool { false }
    public func hasItemsConforming(to types: [String]) -> Bool { false }
    public func itemProviders(for types: [UTType]) -> [NSItemProvider] { [] }
    public func itemProviders(for types: [String]) -> [NSItemProvider] { [] }
}
public enum DropOperation: Sendable { case cancel, forbidden, copy, move }
public struct DropProposal: Sendable { public init(operation: DropOperation) {}; public var operation: DropOperation { .move } }
@MainActor public protocol DropDelegate {
    func validateDrop(info: DropInfo) -> Bool
    func performDrop(info: DropInfo) -> Bool
    func dropEntered(info: DropInfo)
    func dropUpdated(info: DropInfo) -> DropProposal?
    func dropExited(info: DropInfo)
}
extension DropDelegate {
    public func validateDrop(info: DropInfo) -> Bool { true }
    public func dropEntered(info: DropInfo) {}
    public func dropUpdated(info: DropInfo) -> DropProposal? { nil }
    public func dropExited(info: DropInfo) {}
}
public protocol Transferable {}
extension String: Transferable {}
extension URL: Transferable {}
extension Data: Transferable {}
extension AttributedString: Transferable {}
extension Image: Transferable {}

// MARK: Files
public protocol FileDocument {
    static var readableContentTypes: [UTType] { get }
    static var writableContentTypes: [UTType] { get }
    init(configuration: ReadConfiguration) throws
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper
    typealias ReadConfiguration = FileDocumentReadConfiguration
    typealias WriteConfiguration = FileDocumentWriteConfiguration
}
extension FileDocument { public static var writableContentTypes: [UTType] { readableContentTypes } }
public struct FileDocumentReadConfiguration { public var contentType: UTType { fatalError() }; public var file: FileWrapper { fatalError() } }
public struct FileDocumentWriteConfiguration { public var contentType: UTType { fatalError() }; public var existingFile: FileWrapper? { nil } }
open class FileWrapper: NSObject, @unchecked Sendable {
    public init(regularFileWithContents: Data) {}
    public init(directoryWithFileWrappers: [String: FileWrapper]) {}
    public init(url: URL, options: ReadingOptions = []) throws {}
    public struct ReadingOptions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let immediate = ReadingOptions(rawValue: 1) }
    public struct WritingOptions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let atomic = WritingOptions(rawValue: 1) }
    open var regularFileContents: Data? { nil }
    open var fileWrappers: [String: FileWrapper]? { nil }
    open var filename: String?
    open var preferredFilename: String?
    open var isDirectory: Bool { false }
    open var isRegularFile: Bool { true }
    @discardableResult open func addFileWrapper(_ w: FileWrapper) -> String { "" }
    @discardableResult open func addRegularFile(withContents: Data, preferredFilename: String) -> String { "" }
    open func write(to url: URL, options: WritingOptions = [], originalContentsURL: URL?) throws {}
}
