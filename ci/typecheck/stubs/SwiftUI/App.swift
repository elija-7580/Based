// MARK: App, Scene, Commands, Toolbar, Representables
@MainActor @preconcurrency public protocol App {
    associatedtype Body: Scene
    @SceneBuilder @MainActor var body: Body { get }
    init()
}
extension App { @MainActor public static func main() {} }
@MainActor @preconcurrency public protocol Scene { associatedtype Body: Scene; @SceneBuilder @MainActor var body: Body { get } }
extension Never: Scene {}
public protocol _PrimitiveScene: Scene where Body == Never {}
extension _PrimitiveScene { public var body: Never { fatalError() } }
public struct _S<T>: _PrimitiveScene {}
public struct TupleScene<T>: _PrimitiveScene {}
@resultBuilder public struct SceneBuilder {
    public static func buildExpression<S: Scene>(_ s: S) -> S { s }
    public static func buildBlock<S: Scene>(_ s: S) -> S { s }
    public static func buildBlock<each S: Scene>(_ s: repeat each S) -> TupleScene<(repeat each S)> { .init() }
    public static func buildOptional<S: Scene>(_ s: S?) -> _S<S> { .init() }
    public static func buildEither<T: Scene, F: Scene>(first: T) -> _S<(T, F)> { .init() }
    public static func buildEither<T: Scene, F: Scene>(second: F) -> _S<(T, F)> { .init() }
    public static func buildLimitedAvailability<S: Scene>(_ s: S) -> _S<S> { .init() }
}
public struct WindowGroup<Content: View>: _PrimitiveScene {
    public init(@ViewBuilder content: () -> Content) {}
    public init(_ titleKey: LocalizedStringKey, @ViewBuilder content: () -> Content) {}
    public init(_ titleKey: LocalizedStringKey, id: String, @ViewBuilder content: () -> Content) {}
    public init(id: String, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, id: String, @ViewBuilder content: () -> Content) {}
    public init<D: Decodable & Encodable & Hashable, C: View>(for type: D.Type, @ViewBuilder content: @escaping (Binding<D?>) -> C) where Content == _V<C> {}
    public init<D: Decodable & Encodable & Hashable, C: View>(id: String, for type: D.Type, @ViewBuilder content: @escaping (Binding<D?>) -> C) where Content == _V<C> {}
}
public struct Window<Content: View>: _PrimitiveScene {
    public init(_ titleKey: LocalizedStringKey, id: String, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ title: S, id: String, @ViewBuilder content: () -> Content) {}
}
public struct Settings<Content: View>: _PrimitiveScene { public init(@ViewBuilder content: () -> Content) {} }
public struct MenuBarExtra<Label: View, Content: View>: _PrimitiveScene {
    public init(_ titleKey: LocalizedStringKey, systemImage: String, @ViewBuilder content: () -> Content) where Label == SwiftUI.Label<Text, Image> {}
    public init(@ViewBuilder content: () -> Content, @ViewBuilder label: () -> Label) {}
}
public protocol WindowStyle {}
public struct HiddenTitleBarWindowStyle: WindowStyle { public init() {} }
public struct TitleBarWindowStyle: WindowStyle { public init() {} }
public struct DefaultWindowStyle: WindowStyle { public init() {} }
extension WindowStyle where Self == HiddenTitleBarWindowStyle { public static var hiddenTitleBar: HiddenTitleBarWindowStyle { .init() } }
extension WindowStyle where Self == TitleBarWindowStyle { public static var titleBar: TitleBarWindowStyle { .init() } }
extension WindowStyle where Self == DefaultWindowStyle { public static var automatic: DefaultWindowStyle { .init() } }
public protocol WindowToolbarStyle {}
public struct UnifiedWindowToolbarStyle: WindowToolbarStyle { public init() {}; public init(showsTitle: Bool) {} }
public struct UnifiedCompactWindowToolbarStyle: WindowToolbarStyle { public init() {}; public init(showsTitle: Bool) {} }
public struct ExpandedWindowToolbarStyle: WindowToolbarStyle { public init() {} }
public struct DefaultWindowToolbarStyle: WindowToolbarStyle { public init() {} }
extension WindowToolbarStyle where Self == UnifiedWindowToolbarStyle { public static var unified: UnifiedWindowToolbarStyle { .init() }; public static func unified(showsTitle: Bool) -> UnifiedWindowToolbarStyle { .init() } }
extension WindowToolbarStyle where Self == UnifiedCompactWindowToolbarStyle { public static var unifiedCompact: UnifiedCompactWindowToolbarStyle { .init() }; public static func unifiedCompact(showsTitle: Bool) -> UnifiedCompactWindowToolbarStyle { .init() } }
extension WindowToolbarStyle where Self == ExpandedWindowToolbarStyle { public static var expanded: ExpandedWindowToolbarStyle { .init() } }
extension WindowToolbarStyle where Self == DefaultWindowToolbarStyle { public static var automatic: DefaultWindowToolbarStyle { .init() } }
public struct WindowResizability: Sendable { public static let automatic = WindowResizability(), contentSize = WindowResizability(), contentMinSize = WindowResizability() }
extension Scene {
    public func commands<C: Commands>(@CommandsBuilder content: () -> C) -> _S<Self> { .init() }
    public func defaultSize(width: CGFloat, height: CGFloat) -> _S<Self> { .init() }
    public func defaultSize(_ s: CGSize) -> _S<Self> { .init() }
    public func windowStyle<S: WindowStyle>(_ s: S) -> _S<Self> { .init() }
    public func windowToolbarStyle<S: WindowToolbarStyle>(_ s: S) -> _S<Self> { .init() }
    public func windowResizability(_ r: WindowResizability) -> _S<Self> { .init() }
    public func handlesExternalEvents(matching conditions: Set<String>) -> _S<Self> { .init() }
    public func defaultPosition(_ p: UnitPoint) -> _S<Self> { .init() }
    public func commandsRemoved() -> _S<Self> { .init() }
    public func restorationBehavior(_ b: Int) -> _S<Self> { .init() }
}

@MainActor @preconcurrency public protocol Commands { associatedtype Body: Commands; @CommandsBuilder var body: Body { get } }
extension Never: Commands {}
public protocol _PrimitiveCommands: Commands where Body == Never {}
extension _PrimitiveCommands { public var body: Never { fatalError() } }
public struct _C<T>: _PrimitiveCommands {}
public struct EmptyCommands: _PrimitiveCommands { public init() {} }
@resultBuilder public struct CommandsBuilder {
    public static func buildExpression<C: Commands>(_ c: C) -> C { c }
    public static func buildBlock() -> EmptyCommands { EmptyCommands() }
    public static func buildBlock<C: Commands>(_ c: C) -> C { c }
    public static func buildBlock<each C: Commands>(_ c: repeat each C) -> _C<(repeat each C)> { .init() }
    public static func buildOptional<C: Commands>(_ c: C?) -> _C<C> { .init() }
    public static func buildEither<T: Commands, F: Commands>(first: T) -> _C<(T, F)> { .init() }
    public static func buildEither<T: Commands, F: Commands>(second: F) -> _C<(T, F)> { .init() }
    public static func buildLimitedAvailability<C: Commands>(_ c: C) -> _C<C> { .init() }
}
public struct CommandGroupPlacement: Sendable {
    public static let appInfo = CommandGroupPlacement(), appSettings = CommandGroupPlacement(), systemServices = CommandGroupPlacement(), appVisibility = CommandGroupPlacement(), appTermination = CommandGroupPlacement(), newItem = CommandGroupPlacement(), saveItem = CommandGroupPlacement(), importExport = CommandGroupPlacement(), printItem = CommandGroupPlacement(), undoRedo = CommandGroupPlacement(), pasteboard = CommandGroupPlacement(), textEditing = CommandGroupPlacement(), textFormatting = CommandGroupPlacement(), toolbar = CommandGroupPlacement(), sidebar = CommandGroupPlacement(), windowSize = CommandGroupPlacement(), windowList = CommandGroupPlacement(), singleWindowList = CommandGroupPlacement(), windowArrangement = CommandGroupPlacement(), help = CommandGroupPlacement()
}
public struct CommandGroup<Content: View>: _PrimitiveCommands {
    public init(before group: CommandGroupPlacement, @ViewBuilder addition: () -> Content) {}
    public init(after group: CommandGroupPlacement, @ViewBuilder addition: () -> Content) {}
    public init(replacing group: CommandGroupPlacement, @ViewBuilder addition: () -> Content) {}
}
public struct CommandMenu<Content: View>: _PrimitiveCommands {
    public init(_ nameKey: LocalizedStringKey, @ViewBuilder content: () -> Content) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ name: S, @ViewBuilder content: () -> Content) {}
}
public struct SidebarCommands: _PrimitiveCommands { public init() {} }
public struct ToolbarCommands: _PrimitiveCommands { public init() {} }
public struct TextEditingCommands: _PrimitiveCommands { public init() {} }
public struct TextFormattingCommands: _PrimitiveCommands { public init() {} }
public struct InspectorCommands: _PrimitiveCommands { public init() {} }
public struct ImportFromDevicesCommands: _PrimitiveCommands { public init() {} }

@MainActor @preconcurrency public protocol ToolbarContent { associatedtype Body: ToolbarContent; @ToolbarContentBuilder var body: Body { get } }
extension Never: ToolbarContent {}
public protocol _PrimitiveToolbarContent: ToolbarContent where Body == Never {}
extension _PrimitiveToolbarContent { public var body: Never { fatalError() } }
public protocol CustomizableToolbarContent: ToolbarContent {}
public struct _T<T>: _PrimitiveToolbarContent, CustomizableToolbarContent {}
@resultBuilder public struct ToolbarContentBuilder {
    public static func buildExpression<C: ToolbarContent>(_ c: C) -> C { c }
    public static func buildBlock<C: ToolbarContent>(_ c: C) -> C { c }
    public static func buildBlock<each C: ToolbarContent>(_ c: repeat each C) -> _T<(repeat each C)> { .init() }
    public static func buildIf<C: ToolbarContent>(_ c: C?) -> _T<C> { .init() }
    public static func buildEither<T: ToolbarContent, F: ToolbarContent>(first: T) -> _T<(T, F)> { .init() }
    public static func buildEither<T: ToolbarContent, F: ToolbarContent>(second: F) -> _T<(T, F)> { .init() }
    public static func buildLimitedAvailability<C: ToolbarContent>(_ c: C) -> _T<C> { .init() }
}
public struct ToolbarItemPlacement: Sendable {
    public static let automatic = ToolbarItemPlacement(), principal = ToolbarItemPlacement(), navigation = ToolbarItemPlacement(), primaryAction = ToolbarItemPlacement(), secondaryAction = ToolbarItemPlacement(), status = ToolbarItemPlacement(), confirmationAction = ToolbarItemPlacement(), cancellationAction = ToolbarItemPlacement(), destructiveAction = ToolbarItemPlacement(), keyboard = ToolbarItemPlacement()
    #if STUB_IOS
    public static let topBarLeading = ToolbarItemPlacement(), topBarTrailing = ToolbarItemPlacement(), bottomBar = ToolbarItemPlacement(), navigationBarLeading = ToolbarItemPlacement(), navigationBarTrailing = ToolbarItemPlacement()
    #endif
}
public struct ToolbarItem<ID, Content: View>: _PrimitiveToolbarContent, CustomizableToolbarContent {
    public init(placement: ToolbarItemPlacement = .automatic, @ViewBuilder content: () -> Content) where ID == () {}
    public init(id: String, placement: ToolbarItemPlacement = .automatic, @ViewBuilder content: () -> Content) where ID == String {}
}
public struct ToolbarItemGroup<Content: View>: _PrimitiveToolbarContent, CustomizableToolbarContent {
    public init(placement: ToolbarItemPlacement = .automatic, @ViewBuilder content: () -> Content) {}
}
public struct ToolbarSpacer: _PrimitiveToolbarContent { public init() {} }

#if STUB_IOS
// Representables (iOS)
@MainActor @preconcurrency public protocol UIViewRepresentable: View where Body == Never {
    associatedtype UIViewType: UIView
    associatedtype Coordinator = Void
    func makeUIView(context: Context) -> UIViewType
    func updateUIView(_ uiView: UIViewType, context: Context)
    static func dismantleUIView(_ uiView: UIViewType, coordinator: Coordinator)
    func makeCoordinator() -> Coordinator
    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIViewType, context: Context) -> CGSize?
    typealias Context = UIViewRepresentableContext<Self>
}
extension UIViewRepresentable {
    public static func dismantleUIView(_ uiView: UIViewType, coordinator: Coordinator) {}
    public func sizeThatFits(_ proposal: ProposedViewSize, uiView: UIViewType, context: Context) -> CGSize? { nil }
    public var body: Never { fatalError() }
}
extension UIViewRepresentable where Coordinator == Void { public func makeCoordinator() -> Coordinator { () } }
@MainActor public struct UIViewRepresentableContext<Representable: UIViewRepresentable> {
    public var coordinator: Representable.Coordinator { fatalError() }
    public var environment: EnvironmentValues { fatalError() }
    public var transaction: Transaction { fatalError() }
}
@MainActor @preconcurrency public protocol UIViewControllerRepresentable: View where Body == Never {
    associatedtype UIViewControllerType: UIViewController
    associatedtype Coordinator = Void
    func makeUIViewController(context: Context) -> UIViewControllerType
    func updateUIViewController(_ c: UIViewControllerType, context: Context)
    func makeCoordinator() -> Coordinator
    typealias Context = UIViewControllerRepresentableContext<Self>
}
extension UIViewControllerRepresentable { public var body: Never { fatalError() } }
extension UIViewControllerRepresentable where Coordinator == Void { public func makeCoordinator() -> Coordinator { () } }
@MainActor public struct UIViewControllerRepresentableContext<R: UIViewControllerRepresentable> { public var coordinator: R.Coordinator { fatalError() }; public var environment: EnvironmentValues { fatalError() } }
@MainActor open class UIHostingController<Content: View>: UIViewController { public init(rootView: Content) {}; open var rootView: Content { fatalError() } }
#else
// Representables
@MainActor @preconcurrency public protocol NSViewRepresentable: View where Body == Never {
    associatedtype NSViewType: NSView
    associatedtype Coordinator = Void
    func makeNSView(context: Context) -> NSViewType
    func updateNSView(_ nsView: NSViewType, context: Context)
    static func dismantleNSView(_ nsView: NSViewType, coordinator: Coordinator)
    func makeCoordinator() -> Coordinator
    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSViewType, context: Context) -> CGSize?
    typealias Context = NSViewRepresentableContext<Self>
}
extension NSViewRepresentable {
    public static func dismantleNSView(_ nsView: NSViewType, coordinator: Coordinator) {}
    public func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSViewType, context: Context) -> CGSize? { nil }
    public var body: Never { fatalError() }
}
extension NSViewRepresentable where Coordinator == Void { public func makeCoordinator() -> Coordinator { () } }
@MainActor public struct NSViewRepresentableContext<Representable: NSViewRepresentable> {
    public var coordinator: Representable.Coordinator { fatalError() }
    public var environment: EnvironmentValues { fatalError() }
    public var transaction: Transaction { fatalError() }
}
@MainActor @preconcurrency public protocol NSViewControllerRepresentable: View where Body == Never {
    associatedtype NSViewControllerType: NSViewController
    associatedtype Coordinator = Void
    func makeNSViewController(context: Context) -> NSViewControllerType
    func updateNSViewController(_ c: NSViewControllerType, context: Context)
    func makeCoordinator() -> Coordinator
    typealias Context = NSViewControllerRepresentableContext<Self>
}
extension NSViewControllerRepresentable { public var body: Never { fatalError() } }
extension NSViewControllerRepresentable where Coordinator == Void { public func makeCoordinator() -> Coordinator { () } }
@MainActor public struct NSViewControllerRepresentableContext<R: NSViewControllerRepresentable> { public var coordinator: R.Coordinator { fatalError() }; public var environment: EnvironmentValues { fatalError() } }
@MainActor open class NSHostingView<Content: View>: NSView {
    public init(rootView: Content) { super.init(frame: .zero) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    open var rootView: Content { fatalError() }
    open var sizingOptions: NSHostingSizingOptions = []
}
public struct NSHostingSizingOptions: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let minSize = NSHostingSizingOptions(rawValue: 1), intrinsicContentSize = NSHostingSizingOptions(rawValue: 2), maxSize = NSHostingSizingOptions(rawValue: 4), preferredContentSize = NSHostingSizingOptions(rawValue: 8) }
@MainActor open class NSHostingController<Content: View>: NSViewController { public init(rootView: Content) {}; open var rootView: Content { fatalError() } }
#endif

// AttributedString SwiftUI scope
extension AttributeScopes { public var swiftUI: SwiftUIAttributes.Type { SwiftUIAttributes.self }
    public struct SwiftUIAttributes: AttributeScope {
        public let font: FontAttribute; public let foregroundColor: ForegroundColorAttribute; public let backgroundColor: BackgroundColorAttribute; public let strikethroughStyle: StrikethroughStyleAttribute; public let underlineStyle: UnderlineStyleAttribute; public let kern: KernAttribute; public let tracking: TrackingAttribute; public let baselineOffset: BaselineOffsetAttribute
        public let foundation: AttributeScopes.FoundationAttributes
        public enum FontAttribute: AttributedStringKey { public typealias Value = Font; public static let name = "SwiftUI.Font" }
        public enum ForegroundColorAttribute: AttributedStringKey { public typealias Value = Color; public static let name = "SwiftUI.ForegroundColor" }
        public enum BackgroundColorAttribute: AttributedStringKey { public typealias Value = Color; public static let name = "SwiftUI.BackgroundColor" }
        public enum StrikethroughStyleAttribute: AttributedStringKey { public typealias Value = Text.LineStyle; public static let name = "SwiftUI.StrikethroughStyle" }
        public enum UnderlineStyleAttribute: AttributedStringKey { public typealias Value = Text.LineStyle; public static let name = "SwiftUI.UnderlineStyle" }
        public enum KernAttribute: AttributedStringKey { public typealias Value = CGFloat; public static let name = "SwiftUI.Kern" }
        public enum TrackingAttribute: AttributedStringKey { public typealias Value = CGFloat; public static let name = "SwiftUI.Tracking" }
        public enum BaselineOffsetAttribute: AttributedStringKey { public typealias Value = CGFloat; public static let name = "SwiftUI.BaselineOffset" }
    }
}
extension AttributeDynamicLookup { public subscript<T: AttributedStringKey>(dynamicMember keyPath: KeyPath<AttributeScopes.SwiftUIAttributes, T>) -> T { fatalError() } }
