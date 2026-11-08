import UniformTypeIdentifiers

public protocol ViewModifier { associatedtype Body: View; @ViewBuilder @MainActor func body(content: Content) -> Body; typealias Content = _ViewModifier_Content<Self> }
public struct _ViewModifier_Content<M>: _PrimitiveView {}
public struct ModifiedContent<Content, Modifier>: _PrimitiveView { public init(content: Content, modifier: Modifier) {} }
extension ModifiedContent where Content: View, Modifier: ViewModifier {}

extension View {
    public typealias _M = _V<Self>
    public func modifier<M>(_ m: M) -> ModifiedContent<Self, M> { .init(content: self, modifier: m) }
    // layout
    public func padding(_ insets: EdgeInsets) -> _M { .init() }
    public func padding(_ edges: Edge.Set = .all, _ length: CGFloat? = nil) -> _M { .init() }
    public func padding(_ length: CGFloat) -> _M { .init() }
    public func frame(width: CGFloat? = nil, height: CGFloat? = nil, alignment: Alignment = .center) -> _M { .init() }
    public func frame(minWidth: CGFloat? = nil, idealWidth: CGFloat? = nil, maxWidth: CGFloat? = nil, minHeight: CGFloat? = nil, idealHeight: CGFloat? = nil, maxHeight: CGFloat? = nil, alignment: Alignment = .center) -> _M { .init() }
    public func fixedSize() -> _M { .init() }
    public func fixedSize(horizontal: Bool, vertical: Bool) -> _M { .init() }
    public func layoutPriority(_ p: Double) -> _M { .init() }
    public func offset(x: CGFloat = 0, y: CGFloat = 0) -> _M { .init() }
    public func offset(_ s: CGSize) -> _M { .init() }
    public func position(x: CGFloat = 0, y: CGFloat = 0) -> _M { .init() }
    public func position(_ p: CGPoint) -> _M { .init() }
    public func aspectRatio(_ r: CGFloat? = nil, contentMode: ContentMode) -> _M { .init() }
    public func aspectRatio(_ s: CGSize, contentMode: ContentMode) -> _M { .init() }
    public func scaledToFit() -> _M { .init() }
    public func scaledToFill() -> _M { .init() }
    public func alignmentGuide(_ g: HorizontalAlignment, computeValue: @escaping (ViewDimensions) -> CGFloat) -> _M { .init() }
    public func alignmentGuide(_ g: VerticalAlignment, computeValue: @escaping (ViewDimensions) -> CGFloat) -> _M { .init() }
    public func ignoresSafeArea(_ regions: SafeAreaRegions = .all, edges: Edge.Set = .all) -> _M { .init() }
    public func safeAreaInset<V: View>(edge: VerticalEdge, alignment: HorizontalAlignment = .center, spacing: CGFloat? = nil, @ViewBuilder content: () -> V) -> _M { .init() }
    public func safeAreaInset<V: View>(edge: HorizontalEdge, alignment: VerticalAlignment = .center, spacing: CGFloat? = nil, @ViewBuilder content: () -> V) -> _M { .init() }
    public func coordinateSpace<T: Hashable>(name: T) -> _M { .init() }
    public func coordinateSpace(_ name: NamedCoordinateSpace) -> _M { .init() }
    public func zIndex(_ v: Double) -> _M { .init() }
    public func id<ID: Hashable>(_ id: ID) -> _M { .init() }
    public func tag<V: Hashable>(_ tag: V) -> _M { .init() }
    public func tag<V: Hashable>(_ tag: V, includeOptional: Bool) -> _M { .init() }
    public func gridCellColumns(_ n: Int) -> _M { .init() }
    public func gridColumnAlignment(_ a: HorizontalAlignment) -> _M { .init() }
    public func gridCellAnchor(_ a: UnitPoint) -> _M { .init() }
    public func layoutValue<K: LayoutValueKey>(key: K.Type, value: K.Value) -> _M { .init() }
    // text & fonts
    public func font(_ f: Font?) -> _M { .init() }
    public func fontWeight(_ w: Font.Weight?) -> _M { .init() }
    public func fontDesign(_ d: Font.Design?) -> _M { .init() }
    public func fontWidth(_ w: Font.Width?) -> _M { .init() }
    public func bold(_ isActive: Bool = true) -> _M { .init() }
    public func italic(_ isActive: Bool = true) -> _M { .init() }
    public func monospaced(_ isActive: Bool = true) -> _M { .init() }
    public func monospacedDigit() -> _M { .init() }
    public func underline(_ isActive: Bool = true, pattern: Text.LineStyle.Pattern = .solid, color: Color? = nil) -> _M { .init() }
    public func strikethrough(_ isActive: Bool = true, pattern: Text.LineStyle.Pattern = .solid, color: Color? = nil) -> _M { .init() }
    public func lineLimit(_ n: Int?) -> _M { .init() }
    public func lineLimit(_ r: ClosedRange<Int>) -> _M { .init() }
    public func lineLimit(_ r: PartialRangeFrom<Int>) -> _M { .init() }
    public func lineLimit(_ r: PartialRangeThrough<Int>) -> _M { .init() }
    public func lineLimit(_ n: Int, reservesSpace: Bool) -> _M { .init() }
    public func lineSpacing(_ s: CGFloat) -> _M { .init() }
    public func multilineTextAlignment(_ a: TextAlignment) -> _M { .init() }
    public func truncationMode(_ m: Text.TruncationMode) -> _M { .init() }
    public func minimumScaleFactor(_ f: CGFloat) -> _M { .init() }
    public func textCase(_ c: Text.Case?) -> _M { .init() }
    public func textSelection(_ s: TextSelectability) -> _M { .init() }
    public func kerning(_ k: CGFloat) -> _M { .init() }
    public func tracking(_ t: CGFloat) -> _M { .init() }
    public func baselineOffset(_ o: CGFloat) -> _M { .init() }
    public func allowsTightening(_ b: Bool) -> _M { .init() }
    public func autocorrectionDisabled(_ b: Bool = true) -> _M { .init() }
    public func privacySensitive(_ b: Bool = true) -> _M { .init() }
    public func redacted(reason: RedactionReasons) -> _M { .init() }
    public func unredacted() -> _M { .init() }
    // style
    public func foregroundStyle<S: ShapeStyle>(_ s: S) -> _M { .init() }
    public func foregroundStyle<S1: ShapeStyle, S2: ShapeStyle>(_ a: S1, _ b: S2) -> _M { .init() }
    public func foregroundStyle<S1: ShapeStyle, S2: ShapeStyle, S3: ShapeStyle>(_ a: S1, _ b: S2, _ c: S3) -> _M { .init() }
    public func foregroundColor(_ c: Color?) -> _M { .init() }
    public func tint(_ c: Color?) -> _M { .init() }
    public func tint<S: ShapeStyle>(_ s: S?) -> _M { .init() }
    public func accentColor(_ c: Color?) -> _M { .init() }
    public func background<S: ShapeStyle>(_ style: S, ignoresSafeAreaEdges edges: Edge.Set = .all) -> _M { .init() }
    public func background(ignoresSafeAreaEdges edges: Edge.Set = .all) -> _M { .init() }
    public func background<V: View>(alignment: Alignment = .center, @ViewBuilder content: () -> V) -> _M { .init() }
    public func background<S: ShapeStyle, T: Shape>(_ style: S, in shape: T, fillStyle: FillStyle = FillStyle()) -> _M { .init() }
    public func background<T: Shape>(in shape: T, fillStyle: FillStyle = FillStyle()) -> _M { .init() }
    @_disfavoredOverload public func background<V: View>(_ background: V, alignment: Alignment = .center) -> _M { .init() }
    public func backgroundStyle<S: ShapeStyle>(_ s: S) -> _M { .init() }
    public func overlay<V: View>(alignment: Alignment = .center, @ViewBuilder content: () -> V) -> _M { .init() }
    public func overlay<S: ShapeStyle>(_ style: S, ignoresSafeAreaEdges edges: Edge.Set = .all) -> _M { .init() }
    public func overlay<S: ShapeStyle, T: Shape>(_ style: S, in shape: T, fillStyle: FillStyle = FillStyle()) -> _M { .init() }
    @_disfavoredOverload public func overlay<V: View>(_ overlay: V, alignment: Alignment = .center) -> _M { .init() }
    public func border<S: ShapeStyle>(_ content: S, width: CGFloat = 1) -> _M { .init() }
    public func opacity(_ o: Double) -> _M { .init() }
    public func shadow(color: Color = Color(white: 0, opacity: 0.33), radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> _M { .init() }
    public func clipShape<S: Shape>(_ shape: S, style: FillStyle = FillStyle()) -> _M { .init() }
    public func clipped(antialiased: Bool = false) -> _M { .init() }
    public func cornerRadius(_ r: CGFloat, antialiased: Bool = true) -> _M { .init() }
    public func mask<M: View>(alignment: Alignment = .center, @ViewBuilder _ mask: () -> M) -> _M { .init() }
    public func blur(radius: CGFloat, opaque: Bool = false) -> _M { .init() }
    public func brightness(_ a: Double) -> _M { .init() }
    public func saturation(_ a: Double) -> _M { .init() }
    public func grayscale(_ a: Double) -> _M { .init() }
    public func contrast(_ a: Double) -> _M { .init() }
    public func colorMultiply(_ c: Color) -> _M { .init() }
    public func compositingGroup() -> _M { .init() }
    public func drawingGroup(opaque: Bool = false) -> _M { .init() }
    public func scaleEffect(_ s: CGFloat, anchor: UnitPoint = .center) -> _M { .init() }
    public func scaleEffect(x: CGFloat = 1, y: CGFloat = 1, anchor: UnitPoint = .center) -> _M { .init() }
    public func scaleEffect(_ s: CGSize, anchor: UnitPoint = .center) -> _M { .init() }
    public func rotationEffect(_ a: Angle, anchor: UnitPoint = .center) -> _M { .init() }
    public func hidden() -> _M { .init() }
    public func preferredColorScheme(_ c: ColorScheme?) -> _M { .init() }
    public func colorScheme(_ c: ColorScheme) -> _M { .init() }
    public func symbolRenderingMode(_ m: SymbolRenderingMode?) -> _M { .init() }
    public func symbolVariant(_ v: SymbolVariants) -> _M { .init() }
    public func imageScale(_ s: Image.Scale) -> _M { .init() }
    public func controlSize(_ s: ControlSize) -> _M { .init() }
    public func pointerStyle(_ s: PointerStyle?) -> _M { .init() }
    public func buttonStyle<S: ButtonStyle>(_ s: S) -> _M { .init() }
    public func buttonStyle<S: PrimitiveButtonStyle>(_ s: S) -> _M { .init() }
    public func buttonBorderShape(_ s: ButtonBorderShape) -> _M { .init() }
    public func textFieldStyle<S: TextFieldStyle>(_ s: S) -> _M { .init() }
    public func toggleStyle<S: ToggleStyle>(_ s: S) -> _M { .init() }
    public func pickerStyle<S: PickerStyle>(_ s: S) -> _M { .init() }
    public func menuStyle<S: MenuStyle>(_ s: S) -> _M { .init() }
    public func menuIndicator(_ v: Visibility) -> _M { .init() }
    public func listStyle<S: ListStyle>(_ s: S) -> _M { .init() }
    public func formStyle<S: FormStyle>(_ s: S) -> _M { .init() }
    public func labelStyle<S: LabelStyle>(_ s: S) -> _M { .init() }
    public func datePickerStyle<S: DatePickerStyle>(_ s: S) -> _M { .init() }
    public func progressViewStyle<S: ProgressViewStyle>(_ s: S) -> _M { .init() }
    public func groupBoxStyle<S: GroupBoxStyle>(_ s: S) -> _M { .init() }
    public func navigationSplitViewStyle<S: NavigationSplitViewStyle>(_ s: S) -> _M { .init() }
    public func labelsHidden() -> _M { .init() }
    public func scrollContentBackground(_ v: Visibility) -> _M { .init() }
    public func scrollIndicators(_ v: ScrollIndicatorVisibility, axes: Axis.Set = [.vertical, .horizontal]) -> _M { .init() }
    public func scrollDisabled(_ b: Bool) -> _M { .init() }
    public func scrollClipDisabled(_ b: Bool = true) -> _M { .init() }
    public func scrollTargetLayout(isEnabled: Bool = true) -> _M { .init() }
    public func defaultScrollAnchor(_ a: UnitPoint?) -> _M { .init() }
    public func listRowInsets(_ i: EdgeInsets?) -> _M { .init() }
    public func listRowBackground<V: View>(_ v: V?) -> _M { .init() }
    public func listRowSeparator(_ v: Visibility, edges: VerticalEdge.Set = .all) -> _M { .init() }
    public func listSectionSeparator(_ v: Visibility, edges: VerticalEdge.Set = .all) -> _M { .init() }
    public func listItemTint(_ c: Color?) -> _M { .init() }
    public func badge(_ count: Int) -> _M { .init() }
    public func badge(_ label: Text?) -> _M { .init() }
    public func badge(_ key: LocalizedStringKey?) -> _M { .init() }
    @_disfavoredOverload public func badge<S: StringProtocol>(_ label: S?) -> _M { .init() }
    // interaction
    public func disabled(_ b: Bool) -> _M { .init() }
    public func allowsHitTesting(_ b: Bool) -> _M { .init() }
    public func contentShape<S: Shape>(_ shape: S, eoFill: Bool = false) -> _M { .init() }
    public func contentShape<S: Shape>(_ kind: ContentShapeKinds, _ shape: S, eoFill: Bool = false) -> _M { .init() }
    public func help(_ key: LocalizedStringKey) -> _M { .init() }
    public func help(_ text: Text) -> _M { .init() }
    @_disfavoredOverload public func help<S: StringProtocol>(_ text: S) -> _M { .init() }
    public func keyboardShortcut(_ key: KeyEquivalent, modifiers: EventModifiers = .command) -> _M { .init() }
    public func keyboardShortcut(_ shortcut: KeyboardShortcut) -> _M { .init() }
    public func keyboardShortcut(_ shortcut: KeyboardShortcut?) -> _M { .init() }
    public func onTapGesture(count: Int = 1, perform action: @escaping () -> Void) -> _M { .init() }
    public func onTapGesture(count: Int = 1, coordinateSpace: CoordinateSpace = .local, perform action: @escaping (CGPoint) -> Void) -> _M { .init() }
    public func onLongPressGesture(minimumDuration: Double = 0.5, maximumDistance: CGFloat = 10, perform action: @escaping () -> Void, onPressingChanged: ((Bool) -> Void)? = nil) -> _M { .init() }
    public func gesture<G: Gesture>(_ g: G, including mask: GestureMask = .all) -> _M { .init() }
    public func simultaneousGesture<G: Gesture>(_ g: G, including mask: GestureMask = .all) -> _M { .init() }
    public func highPriorityGesture<G: Gesture>(_ g: G, including mask: GestureMask = .all) -> _M { .init() }
    public func onHover(perform action: @escaping (Bool) -> Void) -> _M { .init() }
    public func onContinuousHover(coordinateSpace: CoordinateSpace = .local, perform action: @escaping (HoverPhase) -> Void) -> _M { .init() }
    public func onContinuousHover(coordinateSpace: some CoordinateSpaceProtocol, perform action: @escaping (HoverPhase) -> Void) -> _M { .init() }
    public func onKeyPress(_ key: KeyEquivalent, action: @escaping () -> KeyPress.Result) -> _M { .init() }
    public func onKeyPress(_ key: KeyEquivalent, phases: KeyPress.Phases, action: @escaping (KeyPress) -> KeyPress.Result) -> _M { .init() }
    public func onKeyPress(keys: Set<KeyEquivalent>, phases: KeyPress.Phases = [.down, .repeat], action: @escaping (KeyPress) -> KeyPress.Result) -> _M { .init() }
    public func onKeyPress(characters: CharacterSet, phases: KeyPress.Phases = [.down, .repeat], action: @escaping (KeyPress) -> KeyPress.Result) -> _M { .init() }
    public func onKeyPress(phases: KeyPress.Phases = [.down, .repeat], action: @escaping (KeyPress) -> KeyPress.Result) -> _M { .init() }
    public func focused(_ condition: FocusState<Bool>.Binding) -> _M { .init() }
    public func focused<V: Hashable>(_ binding: FocusState<V>.Binding, equals value: V) -> _M { .init() }
    public func focusable(_ isFocusable: Bool = true) -> _M { .init() }
    public func focusEffectDisabled(_ disabled: Bool = true) -> _M { .init() }
    public func defaultFocus<V: Hashable>(_ binding: FocusState<V>.Binding, _ value: V) -> _M { .init() }
    public func onSubmit(of triggers: SubmitTriggers = .text, _ action: @escaping () -> Void) -> _M { .init() }
    public func onDeleteCommand(perform action: (() -> Void)?) -> _M { .init() }
    public func onMoveCommand(perform action: ((MoveCommandDirection) -> Void)?) -> _M { .init() }
    public func onExitCommand(perform action: (() -> Void)?) -> _M { .init() }
    public func onCopyCommand(perform payloadAction: (() -> [NSItemProvider])?) -> _M { .init() }
    public func onPasteCommand(of types: [UTType], perform action: @escaping ([NSItemProvider]) -> Void) -> _M { .init() }
    public func onOpenURL(perform action: @escaping (URL) -> Void) -> _M { .init() }
    // lifecycle
    public func onAppear(perform action: (() -> Void)? = nil) -> _M { .init() }
    public func onDisappear(perform action: (() -> Void)? = nil) -> _M { .init() }
    public func task(priority: TaskPriority = .userInitiated, _ action: @escaping @Sendable () async -> Void) -> _M { .init() }
    public func task<T: Equatable>(id value: T, priority: TaskPriority = .userInitiated, _ action: @escaping @Sendable () async -> Void) -> _M { .init() }
    public func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping (V, V) -> Void) -> _M { .init() }
    public func onChange<V: Equatable>(of value: V, initial: Bool = false, _ action: @escaping () -> Void) -> _M { .init() }
    @available(*, deprecated) public func onChange<V: Equatable>(of value: V, perform action: @escaping (V) -> Void) -> _M { .init() }
    public func onReceive<P: Publisher>(_ publisher: P, perform action: @escaping (P.Output) -> Void) -> _M where P.Failure == Never { .init() }
    public func onGeometryChange<T: Equatable>(for type: T.Type, of transform: @escaping (GeometryProxy) -> T, action: @escaping (T) -> Void) -> _M { .init() }
    public func onGeometryChange<T: Equatable>(for type: T.Type, of transform: @escaping (GeometryProxy) -> T, action: @escaping (T, T) -> Void) -> _M { .init() }
    public func refreshable(action: @escaping @Sendable () async -> Void) -> _M { .init() }
    public func animation<V: Equatable>(_ animation: Animation?, value: V) -> _M { .init() }
    public func animation<V: View>(_ animation: Animation?, @ViewBuilder body: (_ViewModifier_Content<Self>) -> V) -> _M { .init() }
    @available(*, deprecated) public func animation(_ animation: Animation?) -> _M { .init() }
    public func transition(_ t: AnyTransition) -> _M { .init() }
    public func transaction(_ transform: @escaping (inout Transaction) -> Void) -> _M { .init() }
    // environment & preferences
    public func environment<V>(_ keyPath: WritableKeyPath<EnvironmentValues, V>, _ value: V) -> _M { .init() }
    public func environment<T: AnyObject & Observable>(_ object: T?) -> _M { .init() }
    public func environmentObject<T: ObservableObject>(_ object: T) -> _M { .init() }
    public func preference<K: PreferenceKey>(key: K.Type = K.self, value: K.Value) -> _M { .init() }
    public func onPreferenceChange<K: PreferenceKey>(_ key: K.Type = K.self, perform action: @escaping (K.Value) -> Void) -> _M where K.Value: Equatable { .init() }
    public func anchorPreference<A, K: PreferenceKey>(key: K.Type = K.self, value: Anchor<A>.Source, transform: @escaping (Anchor<A>) -> K.Value) -> _M { .init() }
    public func transformAnchorPreference<A, K: PreferenceKey>(key: K.Type = K.self, value: Anchor<A>.Source, transform: @escaping (inout K.Value, Anchor<A>) -> Void) -> _M { .init() }
    public func overlayPreferenceValue<K: PreferenceKey, V: View>(_ key: K.Type, alignment: Alignment = .center, @ViewBuilder _ transform: @escaping (K.Value) -> V) -> _M { .init() }
    public func backgroundPreferenceValue<K: PreferenceKey, V: View>(_ key: K.Type, alignment: Alignment = .center, @ViewBuilder _ transform: @escaping (K.Value) -> V) -> _M { .init() }
    // presentation
    public func popover<Content: View>(isPresented: Binding<Bool>, attachmentAnchor: PopoverAttachmentAnchor = .rect(.bounds), arrowEdge: Edge? = nil, @ViewBuilder content: @escaping () -> Content) -> _M { .init() }
    public func popover<Item: Identifiable, Content: View>(item: Binding<Item?>, attachmentAnchor: PopoverAttachmentAnchor = .rect(.bounds), arrowEdge: Edge? = nil, @ViewBuilder content: @escaping (Item) -> Content) -> _M { .init() }
    public func sheet<Content: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil, @ViewBuilder content: @escaping () -> Content) -> _M { .init() }
    public func sheet<Item: Identifiable, Content: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil, @ViewBuilder content: @escaping (Item) -> Content) -> _M { .init() }
    public func inspector<V: View>(isPresented: Binding<Bool>, @ViewBuilder content: () -> V) -> _M { .init() }
    public func inspectorColumnWidth(min: CGFloat? = nil, ideal: CGFloat, max: CGFloat? = nil) -> _M { .init() }
    public func alert<A: View>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A) -> _M { .init() }
    @_disfavoredOverload public func alert<S: StringProtocol, A: View>(_ title: S, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A) -> _M { .init() }
    public func alert<A: View>(_ title: Text, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A) -> _M { .init() }
    public func alert<A: View, M: View>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A, @ViewBuilder message: () -> M) -> _M { .init() }
    @_disfavoredOverload public func alert<S: StringProtocol, A: View, M: View>(_ title: S, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A, @ViewBuilder message: () -> M) -> _M { .init() }
    public func alert<A: View, M: View>(_ title: Text, isPresented: Binding<Bool>, @ViewBuilder actions: () -> A, @ViewBuilder message: () -> M) -> _M { .init() }
    public func alert<A: View, T>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, presenting data: T?, @ViewBuilder actions: (T) -> A) -> _M { .init() }
    public func alert<A: View, M: View, T>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, presenting data: T?, @ViewBuilder actions: (T) -> A, @ViewBuilder message: (T) -> M) -> _M { .init() }
    @_disfavoredOverload public func alert<S: StringProtocol, A: View, M: View, T>(_ title: S, isPresented: Binding<Bool>, presenting data: T?, @ViewBuilder actions: (T) -> A, @ViewBuilder message: (T) -> M) -> _M { .init() }
    public func confirmationDialog<A: View>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, @ViewBuilder actions: () -> A) -> _M { .init() }
    @_disfavoredOverload public func confirmationDialog<S: StringProtocol, A: View>(_ title: S, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, @ViewBuilder actions: () -> A) -> _M { .init() }
    public func confirmationDialog<A: View, M: View>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, @ViewBuilder actions: () -> A, @ViewBuilder message: () -> M) -> _M { .init() }
    @_disfavoredOverload public func confirmationDialog<S: StringProtocol, A: View, M: View>(_ title: S, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, @ViewBuilder actions: () -> A, @ViewBuilder message: () -> M) -> _M { .init() }
    public func confirmationDialog<A: View, M: View, T>(_ titleKey: LocalizedStringKey, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, presenting data: T?, @ViewBuilder actions: (T) -> A, @ViewBuilder message: (T) -> M) -> _M { .init() }
    @_disfavoredOverload public func confirmationDialog<S: StringProtocol, A: View, M: View, T>(_ title: S, isPresented: Binding<Bool>, titleVisibility: Visibility = .automatic, presenting data: T?, @ViewBuilder actions: (T) -> A, @ViewBuilder message: (T) -> M) -> _M { .init() }
    public func contextMenu<M: View>(@ViewBuilder menuItems: () -> M) -> _M { .init() }
    public func contextMenu<M: View, P: View>(@ViewBuilder menuItems: () -> M, @ViewBuilder preview: () -> P) -> _M { .init() }
    public func contextMenu<I: Hashable, M: View>(forSelectionType itemType: I.Type = I.self, @ViewBuilder menu: @escaping (Set<I>) -> M, primaryAction: ((Set<I>) -> Void)? = nil) -> _M { .init() }
    public func presentationDetents(_ d: Set<PresentationDetent>) -> _M { .init() }
    public func presentationCompactAdaptation(_ a: PresentationAdaptation) -> _M { .init() }
    public func presentationBackground<S: ShapeStyle>(_ s: S) -> _M { .init() }
    public func presentationCornerRadius(_ r: CGFloat?) -> _M { .init() }
    public func presentationSizing<S>(_ s: S) -> _M { .init() }
    public func interactiveDismissDisabled(_ b: Bool = true) -> _M { .init() }
    public func fileImporter(isPresented: Binding<Bool>, allowedContentTypes: [UTType], allowsMultipleSelection: Bool, onCompletion: @escaping (Result<[URL], Error>) -> Void) -> _M { .init() }
    public func fileImporter(isPresented: Binding<Bool>, allowedContentTypes: [UTType], onCompletion: @escaping (Result<URL, Error>) -> Void) -> _M { .init() }
    public func fileImporter(isPresented: Binding<Bool>, allowedContentTypes: [UTType], allowsMultipleSelection: Bool, onCompletion: @escaping (Result<[URL], Error>) -> Void, onCancellation: @escaping () -> Void) -> _M { .init() }
    public func fileExporter<D: FileDocument>(isPresented: Binding<Bool>, document: D?, contentType: UTType, defaultFilename: String? = nil, onCompletion: @escaping (Result<URL, Error>) -> Void) -> _M { .init() }
    public func fileExporter<D: FileDocument>(isPresented: Binding<Bool>, document: D?, contentType: UTType, defaultFilename: String? = nil, onCompletion: @escaping (Result<URL, Error>) -> Void, onCancellation: @escaping () -> Void) -> _M { .init() }
    public func fileExporter<C: Collection>(isPresented: Binding<Bool>, documents: C, contentType: UTType, onCompletion: @escaping (Result<[URL], Error>) -> Void) -> _M where C.Element: FileDocument { .init() }
    public func fileDialogDefaultDirectory(_ url: URL?) -> _M { .init() }
    // drag & drop
    public func onDrag(_ data: @escaping () -> NSItemProvider) -> _M { .init() }
    public func onDrag<V: View>(_ data: @escaping () -> NSItemProvider, @ViewBuilder preview: () -> V) -> _M { .init() }
    public func onDrop(of supportedContentTypes: [UTType], isTargeted: Binding<Bool>?, perform action: @escaping ([NSItemProvider]) -> Bool) -> _M { .init() }
    public func onDrop(of supportedContentTypes: [UTType], isTargeted: Binding<Bool>?, perform action: @escaping ([NSItemProvider], CGPoint) -> Bool) -> _M { .init() }
    public func onDrop(of supportedContentTypes: [UTType], delegate: DropDelegate) -> _M { .init() }
    @available(*, deprecated) public func onDrop(of supportedTypes: [String], isTargeted: Binding<Bool>?, perform action: @escaping ([NSItemProvider]) -> Bool) -> _M { .init() }
    @available(*, deprecated) public func onDrop(of supportedTypes: [String], delegate: DropDelegate) -> _M { .init() }
    public func draggable<T: Transferable>(_ payload: @autoclosure @escaping () -> T) -> _M { .init() }
    public func draggable<T: Transferable, V: View>(_ payload: @autoclosure @escaping () -> T, @ViewBuilder preview: () -> V) -> _M { .init() }
    public func dropDestination<T: Transferable>(for payloadType: T.Type = T.self, action: @escaping ([T], CGPoint) -> Bool, isTargeted: @escaping (Bool) -> Void = { _ in }) -> _M { .init() }
    // navigation & toolbar
    public func navigationTitle(_ key: LocalizedStringKey) -> _M { .init() }
    public func navigationTitle(_ text: Text) -> _M { .init() }
    @_disfavoredOverload public func navigationTitle<S: StringProtocol>(_ title: S) -> _M { .init() }
    public func navigationTitle(_ title: Binding<String>) -> _M { .init() }
    public func navigationSubtitle(_ key: LocalizedStringKey) -> _M { .init() }
    public func navigationSubtitle(_ text: Text) -> _M { .init() }
    @_disfavoredOverload public func navigationSubtitle<S: StringProtocol>(_ subtitle: S) -> _M { .init() }
    public func navigationSplitViewColumnWidth(_ width: CGFloat) -> _M { .init() }
    public func navigationSplitViewColumnWidth(min: CGFloat? = nil, ideal: CGFloat, max: CGFloat? = nil) -> _M { .init() }
    public func navigationDestination<D: Hashable, C: View>(for data: D.Type, @ViewBuilder destination: @escaping (D) -> C) -> _M { .init() }
    public func navigationDestination<V: View>(isPresented: Binding<Bool>, @ViewBuilder destination: () -> V) -> _M { .init() }
    public func navigationDestination<D: Hashable, C: View>(item: Binding<D?>, @ViewBuilder destination: @escaping (D) -> C) -> _M { .init() }
    public func toolbar<Content: View>(@ViewBuilder content: () -> Content) -> _M { .init() }
    public func toolbar<Content: ToolbarContent>(@ToolbarContentBuilder content: () -> Content) -> _M { .init() }
    public func toolbar(_ visibility: Visibility, for bars: ToolbarPlacement...) -> _M { .init() }
    public func toolbar(removing defaultItemKind: ToolbarDefaultItemKind?) -> _M { .init() }
    public func toolbarBackground(_ visibility: Visibility, for bars: ToolbarPlacement...) -> _M { .init() }
    public func toolbarBackground<S: ShapeStyle>(_ style: S, for bars: ToolbarPlacement...) -> _M { .init() }
    public func searchable(text: Binding<String>, placement: SearchFieldPlacement = .automatic, prompt: Text? = nil) -> _M { .init() }
    public func searchable(text: Binding<String>, placement: SearchFieldPlacement = .automatic, prompt: LocalizedStringKey) -> _M { .init() }
    // accessibility
    public func accessibilityIdentifier(_ id: String) -> _M { .init() }
    public func accessibilityLabel(_ label: Text) -> _M { .init() }
    public func accessibilityLabel(_ key: LocalizedStringKey) -> _M { .init() }
    @_disfavoredOverload public func accessibilityLabel<S: StringProtocol>(_ label: S) -> _M { .init() }
    public func accessibilityValue(_ v: Text) -> _M { .init() }
    @_disfavoredOverload public func accessibilityValue<S: StringProtocol>(_ v: S) -> _M { .init() }
    public func accessibilityHint(_ h: Text) -> _M { .init() }
    @_disfavoredOverload public func accessibilityHint<S: StringProtocol>(_ h: S) -> _M { .init() }
    public func accessibilityHidden(_ b: Bool) -> _M { .init() }
    public func accessibilityElement(children: AccessibilityChildBehavior = .ignore) -> _M { .init() }
    public func accessibilityAddTraits(_ t: AccessibilityTraits) -> _M { .init() }
    public func accessibilityRemoveTraits(_ t: AccessibilityTraits) -> _M { .init() }
    public func accessibilityAction(named name: LocalizedStringKey, _ handler: @escaping () -> Void) -> _M { .init() }
    public func accessibilitySortPriority(_ p: Double) -> _M { .init() }
}
public struct SearchFieldPlacement { public static let automatic = SearchFieldPlacement(), toolbar = SearchFieldPlacement(), sidebar = SearchFieldPlacement() }
public struct RedactionReasons: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let placeholder = RedactionReasons(rawValue: 1), privacy = RedactionReasons(rawValue: 2) }
public struct ButtonBorderShape: Sendable { public static let automatic = ButtonBorderShape(), capsule = ButtonBorderShape(), roundedRectangle = ButtonBorderShape(), circle = ButtonBorderShape(); public static func roundedRectangle(radius: CGFloat) -> ButtonBorderShape { .init() } }
extension VerticalEdge { public struct Set: OptionSet, Sendable { public let rawValue: Int8; public init(rawValue: Int8) { self.rawValue = rawValue }; public static let top = Set(rawValue: 1), bottom = Set(rawValue: 2), all = Set(rawValue: 3) } }
