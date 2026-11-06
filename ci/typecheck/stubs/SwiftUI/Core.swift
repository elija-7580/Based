// Type-check stub of SwiftUI (subset used by Based). Signatures follow Apple's API; bodies are dummies.
@_exported import Foundation
@_exported import Observation
@_exported import AppKit
@_exported import Combine
import UniformTypeIdentifiers

// MARK: View & builders
@MainActor @preconcurrency public protocol View {
    associatedtype Body: View
    @ViewBuilder @MainActor @preconcurrency var body: Body { get }
}
extension Never: View { public typealias Body = Never; public var body: Never { fatalError() } }
public protocol _PrimitiveView: View where Body == Never {}
extension _PrimitiveView { public var body: Never { fatalError() } }
public struct _V<T>: _PrimitiveView { public init() {} }
public struct EmptyView: _PrimitiveView { public init() {} }
public struct TupleView<T>: _PrimitiveView { public var value: T; public init(_ value: T) { self.value = value } }
public struct _ConditionalContent<TrueContent, FalseContent>: _PrimitiveView {}
extension Optional: View where Wrapped: View { public typealias Body = Never; public var body: Never { fatalError() } }
public struct AnyView: _PrimitiveView { public init<V: View>(_ view: V) {}; public init<V: View>(erasing view: V) {} }

@resultBuilder public struct ViewBuilder {
    public static func buildExpression<Content: View>(_ content: Content) -> Content { content }
    public static func buildBlock() -> EmptyView { EmptyView() }
    public static func buildBlock<Content: View>(_ content: Content) -> Content { content }
    public static func buildBlock<each Content: View>(_ content: repeat each Content) -> TupleView<(repeat each Content)> { TupleView((repeat each content)) }
    public static func buildIf<Content: View>(_ content: Content?) -> Content? { content }
    public static func buildEither<T: View, F: View>(first: T) -> _ConditionalContent<T, F> { .init() }
    public static func buildEither<T: View, F: View>(second: F) -> _ConditionalContent<T, F> { .init() }
    public static func buildLimitedAvailability<Content: View>(_ content: Content) -> AnyView { AnyView(content) }
}

public protocol DynamicProperty {}
public struct Transaction { public init() {}; public init(animation: Animation?) {}; public var animation: Animation?; public var disablesAnimations = false }

// MARK: Geometry primitives
public enum Edge: Int8, CaseIterable, Sendable {
    case top, leading, bottom, trailing
    public struct Set: OptionSet, Sendable { public let rawValue: Int8; public init(rawValue: Int8) { self.rawValue = rawValue }; public init(_ e: Edge) { rawValue = 1 << e.rawValue }
        public static let top = Set(.top), leading = Set(.leading), bottom = Set(.bottom), trailing = Set(.trailing), all = Set(rawValue: 15), horizontal = Set(rawValue: 10), vertical = Set(rawValue: 5) }
}
public enum HorizontalEdge: Int8, Sendable { case leading, trailing }
public enum VerticalEdge: Int8, Sendable { case top, bottom }
public struct EdgeInsets: Equatable, Sendable { public var top, leading, bottom, trailing: CGFloat; public init(top: CGFloat = 0, leading: CGFloat = 0, bottom: CGFloat = 0, trailing: CGFloat = 0) { self.top = top; self.leading = leading; self.bottom = bottom; self.trailing = trailing }; public init() { self.init(top: 0) } }
public struct HorizontalAlignment: Equatable, Sendable { public static let leading = HorizontalAlignment(), center = HorizontalAlignment(), trailing = HorizontalAlignment(), listRowSeparatorLeading = HorizontalAlignment(), listRowSeparatorTrailing = HorizontalAlignment() }
public struct VerticalAlignment: Equatable, Sendable { public static let top = VerticalAlignment(), center = VerticalAlignment(), bottom = VerticalAlignment(), firstTextBaseline = VerticalAlignment(), lastTextBaseline = VerticalAlignment() }
public struct Alignment: Equatable, Sendable {
    public var horizontal: HorizontalAlignment; public var vertical: VerticalAlignment
    public init(horizontal: HorizontalAlignment, vertical: VerticalAlignment) { self.horizontal = horizontal; self.vertical = vertical }
    public static let center = Alignment(horizontal: .center, vertical: .center), leading = center, trailing = center, top = center, bottom = center, topLeading = center, topTrailing = center, bottomLeading = center, bottomTrailing = center, leadingFirstTextBaseline = center, centerFirstTextBaseline = center, trailingFirstTextBaseline = center, leadingLastTextBaseline = center
}
public struct UnitPoint: Hashable, Sendable { public var x: CGFloat; public var y: CGFloat; public init(x: CGFloat = 0, y: CGFloat = 0) { self.x = x; self.y = y }
    public static let zero = UnitPoint(), center = UnitPoint(x: 0.5, y: 0.5), leading = UnitPoint(), trailing = UnitPoint(), top = UnitPoint(), bottom = UnitPoint(), topLeading = UnitPoint(), topTrailing = UnitPoint(), bottomLeading = UnitPoint(), bottomTrailing = UnitPoint() }
public enum Axis: Int8, CaseIterable, Sendable { case horizontal, vertical
    public struct Set: OptionSet, Sendable { public let rawValue: Int8; public init(rawValue: Int8) { self.rawValue = rawValue }; public static let horizontal = Set(rawValue: 1), vertical = Set(rawValue: 2) } }
public struct Angle: Hashable, Comparable, Sendable { public var radians: Double; public var degrees: Double { radians * 180 / .pi }; public init(radians: Double) { self.radians = radians }; public init(degrees: Double) { radians = degrees * .pi / 180 }; public static func degrees(_ d: Double) -> Angle { Angle(degrees: d) }; public static func radians(_ r: Double) -> Angle { Angle(radians: r) }; public static let zero = Angle(radians: 0); public static func < (a: Angle, b: Angle) -> Bool { a.radians < b.radians } }
public enum ContentMode: Hashable, CaseIterable, Sendable { case fit, fill }
public enum ColorScheme: Hashable, CaseIterable, Sendable { case light, dark }
public enum ColorSchemeContrast: Hashable, Sendable { case standard, increased }
public enum Visibility: Hashable, CaseIterable, Sendable { case automatic, visible, hidden }
public enum TextAlignment: Hashable, CaseIterable, Sendable { case leading, center, trailing }
public enum ControlSize: Hashable, CaseIterable, Sendable { case mini, small, regular, large, extraLarge }
public enum RoundedCornerStyle: Hashable, Sendable { case circular, continuous }
public enum ScenePhase: Hashable, Sendable { case background, inactive, active }
public enum LayoutDirection: Hashable, Sendable { case leftToRight, rightToLeft }
public enum ControlActiveState: Hashable, Sendable { case key, active, inactive }
public enum DynamicTypeSize: Hashable, Comparable, Sendable { case xSmall, small, medium, large, xLarge, xxLarge, xxxLarge, accessibility1 }
public enum UserInterfaceSizeClass: Hashable, Sendable { case compact, regular }
public struct ScrollIndicatorVisibility: Equatable, Sendable { public static let automatic = ScrollIndicatorVisibility(), visible = ScrollIndicatorVisibility(), hidden = ScrollIndicatorVisibility(), never = ScrollIndicatorVisibility() }
public struct SafeAreaRegions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let all = SafeAreaRegions(rawValue: 7), container = SafeAreaRegions(rawValue: 1), keyboard = SafeAreaRegions(rawValue: 2) }
public struct PinnedScrollableViews: OptionSet, Sendable { public let rawValue: UInt32; public init(rawValue: UInt32) { self.rawValue = rawValue }; public static let sectionHeaders = PinnedScrollableViews(rawValue: 1), sectionFooters = PinnedScrollableViews(rawValue: 2) }
public struct ProposedViewSize: Equatable, Sendable {
    public var width: CGFloat?; public var height: CGFloat?
    public init(width: CGFloat?, height: CGFloat?) { self.width = width; self.height = height }
    public init(_ size: CGSize) { width = size.width; height = size.height }
    public static let zero = ProposedViewSize(width: 0, height: 0), unspecified = ProposedViewSize(width: nil, height: nil), infinity = ProposedViewSize(width: .infinity, height: .infinity)
    public func replacingUnspecifiedDimensions(by size: CGSize = CGSize(width: 10, height: 10)) -> CGSize { size }
}
public struct ViewDimensions { public var width: CGFloat { 0 }; public var height: CGFloat { 0 }; public subscript(g: HorizontalAlignment) -> CGFloat { 0 }; public subscript(g: VerticalAlignment) -> CGFloat { 0 } }

public enum CoordinateSpace: Hashable, Sendable { case global, local, named(AnyHashable) }
public protocol CoordinateSpaceProtocol { var coordinateSpace: CoordinateSpace { get } }
public struct NamedCoordinateSpace: CoordinateSpaceProtocol, Equatable { public var coordinateSpace: CoordinateSpace { .global } }
public struct GlobalCoordinateSpace: CoordinateSpaceProtocol { public var coordinateSpace: CoordinateSpace { .global } }
public struct LocalCoordinateSpace: CoordinateSpaceProtocol { public var coordinateSpace: CoordinateSpace { .local } }
extension CoordinateSpaceProtocol where Self == NamedCoordinateSpace { public static func named(_ n: some Hashable) -> NamedCoordinateSpace { .init() } }
extension CoordinateSpaceProtocol where Self == GlobalCoordinateSpace { public static var global: GlobalCoordinateSpace { .init() } }
extension CoordinateSpaceProtocol where Self == LocalCoordinateSpace { public static var local: LocalCoordinateSpace { .init() } }

public struct Anchor<Value> { public struct Source { public static var bounds: Source { Source() }; public static func rect(_ r: CGRect) -> Source { Source() }; public static var top: Source { Source() }; public static var bottom: Source { Source() }; public static var center: Source { Source() }; public static var leading: Source { Source() }; public static var trailing: Source { Source() }; public static var topLeading: Source { Source() }; public static var bottomLeading: Source { Source() } } }
public struct GeometryProxy {
    public var size: CGSize { .zero }
    public var safeAreaInsets: EdgeInsets { EdgeInsets() }
    public func frame(in s: CoordinateSpace) -> CGRect { .zero }
    public func frame(in s: some CoordinateSpaceProtocol) -> CGRect { .zero }
    public func bounds(of s: NamedCoordinateSpace) -> CGRect? { nil }
    public subscript<T>(anchor: Anchor<T>) -> T { fatalError() }
}
public struct GeometryReader<Content: View>: _PrimitiveView { public init(@ViewBuilder content: @escaping (GeometryProxy) -> Content) {} }

// MARK: Color, Font, ShapeStyle
public protocol ShapeStyle: Sendable {}
extension ShapeStyle {
    public func opacity(_ o: Double) -> some ShapeStyle { self }
    public func shadow(_ s: ShadowStyle) -> some ShapeStyle { self }
    public var secondary: some ShapeStyle { self }
    public var tertiary: some ShapeStyle { self }
}
public struct ShadowStyle: Sendable { public static func drop(color: Color = .black, radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> ShadowStyle { .init() } }
public struct AnyShapeStyle: ShapeStyle { public init<S: ShapeStyle>(_ s: S) {} }
public struct HierarchicalShapeStyle: ShapeStyle { public static let primary = HierarchicalShapeStyle(), secondary = HierarchicalShapeStyle(), tertiary = HierarchicalShapeStyle(), quaternary = HierarchicalShapeStyle(), quinary = HierarchicalShapeStyle() }
extension ShapeStyle where Self == HierarchicalShapeStyle { public static var primary: HierarchicalShapeStyle { .primary }; public static var secondary: HierarchicalShapeStyle { .secondary }; public static var tertiary: HierarchicalShapeStyle { .tertiary }; public static var quaternary: HierarchicalShapeStyle { .quaternary }; public static var quinary: HierarchicalShapeStyle { .quinary } }
public struct ForegroundStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == ForegroundStyle { public static var foreground: ForegroundStyle { .init() } }
public struct BackgroundStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == BackgroundStyle { public static var background: BackgroundStyle { .init() } }
public struct TintShapeStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == TintShapeStyle { public static var tint: TintShapeStyle { .init() } }
public struct SeparatorShapeStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == SeparatorShapeStyle { public static var separator: SeparatorShapeStyle { .init() } }
public struct SelectionShapeStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == SelectionShapeStyle { public static var selection: SelectionShapeStyle { .init() } }
public struct FillShapeStyle: ShapeStyle { public init() {} }
extension ShapeStyle where Self == FillShapeStyle { public static var fill: FillShapeStyle { .init() } }
public struct Material: ShapeStyle { public static let regular = Material(), thin = Material(), thick = Material(), ultraThin = Material(), ultraThick = Material(), bar = Material() }
extension ShapeStyle where Self == Material { public static var regularMaterial: Material { .regular }; public static var thinMaterial: Material { .thin }; public static var thickMaterial: Material { .thick }; public static var ultraThinMaterial: Material { .ultraThin }; public static var ultraThickMaterial: Material { .ultraThick }; public static var bar: Material { .bar } }
public struct Gradient: Hashable, Sendable { public struct Stop: Hashable, Sendable { public var color: Color; public var location: CGFloat; public init(color: Color, location: CGFloat) { self.color = color; self.location = location } }; public var stops: [Stop]; public init(colors: [Color]) { stops = [] }; public init(stops: [Stop]) { self.stops = stops } }
public struct LinearGradient: ShapeStyle, _PrimitiveView { public init(gradient: Gradient, startPoint: UnitPoint, endPoint: UnitPoint) {}; public init(colors: [Color], startPoint: UnitPoint, endPoint: UnitPoint) {}; public init(stops: [Gradient.Stop], startPoint: UnitPoint, endPoint: UnitPoint) {} }
extension ShapeStyle where Self == LinearGradient { public static func linearGradient(_ g: Gradient, startPoint: UnitPoint, endPoint: UnitPoint) -> LinearGradient { .init(gradient: g, startPoint: startPoint, endPoint: endPoint) }; public static func linearGradient(colors: [Color], startPoint: UnitPoint, endPoint: UnitPoint) -> LinearGradient { .init(colors: colors, startPoint: startPoint, endPoint: endPoint) } }
public struct RadialGradient: ShapeStyle, _PrimitiveView { public init(gradient: Gradient, center: UnitPoint, startRadius: CGFloat, endRadius: CGFloat) {}; public init(colors: [Color], center: UnitPoint, startRadius: CGFloat, endRadius: CGFloat) {} }
public struct AngularGradient: ShapeStyle, _PrimitiveView { public init(gradient: Gradient, center: UnitPoint, angle: Angle = .zero) {}; public init(colors: [Color], center: UnitPoint) {} }

public struct Color: Hashable, CustomStringConvertible, Sendable, ShapeStyle, _PrimitiveView {
    public enum RGBColorSpace: Sendable { case sRGB, sRGBLinear, displayP3 }
    public init(_ name: String, bundle: Bundle? = nil) {}
    public init(red: Double, green: Double, blue: Double, opacity: Double = 1) {}
    public init(_ colorSpace: RGBColorSpace, red: Double, green: Double, blue: Double, opacity: Double = 1) {}
    public init(white: Double, opacity: Double = 1) {}
    public init(_ colorSpace: RGBColorSpace, white: Double, opacity: Double = 1) {}
    public init(hue: Double, saturation: Double, brightness: Double, opacity: Double = 1) {}
    public init(nsColor: NSColor) {}
    public init(_ nsColor: NSColor) {}
    public init(cgColor: CGColor) {}
    public var description: String { "" }
    public func opacity(_ o: Double) -> Color { self }
    public func mix(with c: Color, by f: Double) -> Color { self }
    public var cgColor: CGColor? { nil }
    public static let black = Color(white: 0), white = Color(white: 1), gray = Color(white: 0.5), red = Color(white: 0), green = Color(white: 0), blue = Color(white: 0), orange = Color(white: 0), yellow = Color(white: 0), pink = Color(white: 0), purple = Color(white: 0), primary = Color(white: 0), secondary = Color(white: 0), clear = Color(white: 0), accentColor = Color(white: 0), mint = Color(white: 0), teal = Color(white: 0), cyan = Color(white: 0), indigo = Color(white: 0), brown = Color(white: 0)
}
extension ShapeStyle where Self == Color {
    public static var black: Color { .black }; public static var white: Color { .white }; public static var gray: Color { .gray }; public static var red: Color { .red }; public static var green: Color { .green }; public static var blue: Color { .blue }; public static var orange: Color { .orange }; public static var yellow: Color { .yellow }; public static var pink: Color { .pink }; public static var purple: Color { .purple }; public static var clear: Color { .clear }; public static var mint: Color { .mint }; public static var teal: Color { .teal }; public static var cyan: Color { .cyan }; public static var indigo: Color { .indigo }; public static var brown: Color { .brown }; public static var accentColor: Color { .accentColor }
}
extension NSColor { public convenience init(_ color: Color) { self.init() } }

public struct Font: Hashable, Sendable {
    public struct Weight: Hashable, Sendable { public static let ultraLight = Weight(), thin = Weight(), light = Weight(), regular = Weight(), medium = Weight(), semibold = Weight(), bold = Weight(), heavy = Weight(), black = Weight() }
    public struct Width: Hashable, Sendable { public static let compressed = Width(), condensed = Width(), standard = Width(), expanded = Width(); public init(_ v: CGFloat) {}; init() {} }
    public enum Design: Hashable, Sendable { case `default`, serif, rounded, monospaced }
    public enum TextStyle: Hashable, CaseIterable, Sendable { case largeTitle, extraLargeTitle, extraLargeTitle2, title, title2, title3, headline, subheadline, body, callout, footnote, caption, caption2 }
    public enum Leading: Hashable, Sendable { case standard, tight, loose }
    public init(_ font: NSFont) {}
    public static let largeTitle = Font(NSFont()), title = largeTitle, title2 = largeTitle, title3 = largeTitle, headline = largeTitle, subheadline = largeTitle, body = largeTitle, callout = largeTitle, footnote = largeTitle, caption = largeTitle, caption2 = largeTitle
    public static func system(size: CGFloat, weight: Weight? = nil, design: Design? = nil) -> Font { .body }
    public static func system(_ style: TextStyle, design: Design? = nil, weight: Weight? = nil) -> Font { .body }
    public static func custom(_ name: String, size: CGFloat) -> Font { .body }
    public static func custom(_ name: String, size: CGFloat, relativeTo: TextStyle) -> Font { .body }
    public static func custom(_ name: String, fixedSize: CGFloat) -> Font { .body }
    public func weight(_ w: Weight) -> Font { self }
    public func width(_ w: Width) -> Font { self }
    public func bold() -> Font { self }
    public func italic() -> Font { self }
    public func monospaced() -> Font { self }
    public func monospacedDigit() -> Font { self }
    public func smallCaps() -> Font { self }
    public func leading(_ l: Leading) -> Font { self }
}

// MARK: Text
public struct LocalizedStringKey: Equatable, Sendable, ExpressibleByStringInterpolation {
    public init(_ value: String) {}
    public init(stringLiteral value: String) {}
    public init(stringInterpolation: StringInterpolation) {}
    public struct StringInterpolation: StringInterpolationProtocol {
        public init(literalCapacity: Int, interpolationCount: Int) {}
        public mutating func appendLiteral(_ literal: String) {}
        public mutating func appendInterpolation(_ string: String) {}
        public mutating func appendInterpolation<Subject: ReferenceConvertible>(_ subject: Subject, formatter: Formatter? = nil) {}
        public mutating func appendInterpolation<Subject: NSObject>(_ subject: Subject, formatter: Formatter? = nil) {}
        public mutating func appendInterpolation<F: FormatStyle>(_ input: F.FormatInput, format: F) where F.FormatInput: Equatable, F.FormatOutput == String {}
        public mutating func appendInterpolation<T: _FormatSpecifiable>(_ value: T) {}
        public mutating func appendInterpolation<T: _FormatSpecifiable>(_ value: T, specifier: String) {}
        public mutating func appendInterpolation(_ text: Text) {}
        public mutating func appendInterpolation(_ image: Image) {}
        public mutating func appendInterpolation(_ date: Date, style: Text.DateStyle) {}
        public mutating func appendInterpolation(_ attributed: AttributedString) {}
    }
}
public protocol _FormatSpecifiable: Equatable {}
extension Int: _FormatSpecifiable {}; extension Int8: _FormatSpecifiable {}; extension Int16: _FormatSpecifiable {}; extension Int32: _FormatSpecifiable {}; extension Int64: _FormatSpecifiable {}
extension UInt: _FormatSpecifiable {}; extension UInt8: _FormatSpecifiable {}; extension UInt16: _FormatSpecifiable {}; extension UInt32: _FormatSpecifiable {}; extension UInt64: _FormatSpecifiable {}
extension Float: _FormatSpecifiable {}; extension Double: _FormatSpecifiable {}; extension CGFloat: _FormatSpecifiable {}

public struct Text: Equatable, Sendable, _PrimitiveView {
    public struct DateStyle: Sendable { public static let time = DateStyle(), date = DateStyle(), relative = DateStyle(), offset = DateStyle(), timer = DateStyle() }
    public enum Case: Sendable { case uppercase, lowercase }
    public enum TruncationMode: Sendable { case head, tail, middle }
    public enum Scale: Sendable { case `default`, secondary }
    public struct LineStyle: Hashable, Sendable { public enum Pattern: Hashable, Sendable { case solid, dot, dash, dashDot, dashDotDot }; public init(pattern: Pattern = .solid, color: Color? = nil) {}; public static let single = LineStyle() }
    public init(_ key: LocalizedStringKey, tableName: String? = nil, bundle: Bundle? = nil, comment: StaticString? = nil) {}
    @_disfavoredOverload public init<S: StringProtocol>(_ content: S) {}
    public init(verbatim content: String) {}
    public init(_ attributed: AttributedString) {}
    public init(_ date: Date, style: DateStyle) {}
    public init(_ range: ClosedRange<Date>) {}
    public init(_ interval: DateInterval) {}
    public init<F: FormatStyle>(_ input: F.FormatInput, format: F) where F.FormatInput: Equatable, F.FormatOutput == String {}
    public init<Subject: ReferenceConvertible>(_ subject: Subject, formatter: Formatter) {}
    public init(_ image: Image) {}
    public init(timerInterval: ClosedRange<Date>, pauseTime: Date? = nil, countsDown: Bool = true, showsHours: Bool = true) {}
    public static func + (a: Text, b: Text) -> Text { a }
    public func font(_ f: Font?) -> Text { self }
    public func fontWeight(_ w: Font.Weight?) -> Text { self }
    public func fontDesign(_ d: Font.Design?) -> Text { self }
    public func fontWidth(_ w: Font.Width?) -> Text { self }
    public func bold() -> Text { self }
    public func bold(_ isActive: Bool) -> Text { self }
    public func italic() -> Text { self }
    public func italic(_ isActive: Bool) -> Text { self }
    public func monospaced(_ isActive: Bool = true) -> Text { self }
    public func monospacedDigit() -> Text { self }
    public func strikethrough(_ isActive: Bool = true, color: Color? = nil) -> Text { self }
    public func strikethrough(_ isActive: Bool = true, pattern: LineStyle.Pattern, color: Color? = nil) -> Text { self }
    public func underline(_ isActive: Bool = true, color: Color? = nil) -> Text { self }
    public func underline(_ isActive: Bool = true, pattern: LineStyle.Pattern, color: Color? = nil) -> Text { self }
    public func foregroundColor(_ c: Color?) -> Text { self }
    public func foregroundStyle<S: ShapeStyle>(_ s: S) -> Text { self }
    public func kerning(_ k: CGFloat) -> Text { self }
    public func tracking(_ t: CGFloat) -> Text { self }
    public func baselineOffset(_ o: CGFloat) -> Text { self }
    public func textScale(_ s: Scale, isEnabled: Bool = true) -> Text { self }
}

// MARK: Image
public struct Image: Equatable, Sendable, _PrimitiveView {
    public enum Scale: Sendable { case small, medium, large }
    public enum TemplateRenderingMode: Sendable { case template, original }
    public enum Interpolation: Sendable { case none, low, medium, high }
    public enum ResizingMode: Sendable { case tile, stretch }
    public init(systemName: String) {}
    public init(systemName: String, variableValue: Double?) {}
    public init(_ name: String, bundle: Bundle? = nil) {}
    public init(decorative name: String, bundle: Bundle? = nil) {}
    public init(nsImage: NSImage) {}
    public init(_ cgImage: CGImage, scale: CGFloat, label: Text) {}
    public func resizable(capInsets: EdgeInsets = EdgeInsets(), resizingMode: ResizingMode = .stretch) -> Image { self }
    public func renderingMode(_ m: TemplateRenderingMode?) -> Image { self }
    public func interpolation(_ i: Interpolation) -> Image { self }
    public func antialiased(_ b: Bool) -> Image { self }
    public func symbolRenderingMode(_ m: SymbolRenderingMode?) -> Image { self }
}
public struct SymbolRenderingMode: Sendable { public static let monochrome = SymbolRenderingMode(), multicolor = SymbolRenderingMode(), hierarchical = SymbolRenderingMode(), palette = SymbolRenderingMode() }
public struct SymbolVariants: Sendable { public static let none = SymbolVariants(), fill = SymbolVariants(), circle = SymbolVariants(), square = SymbolVariants(), slash = SymbolVariants() }

// MARK: Shapes
public struct Path: Shape, Equatable {
    public init() {}
    public init(_ rect: CGRect) {}
    public init(roundedRect: CGRect, cornerRadius: CGFloat, style: RoundedCornerStyle = .continuous) {}
    public init(ellipseIn: CGRect) {}
    public init(_ build: (inout Path) -> Void) {}
    public func path(in rect: CGRect) -> Path { self }
    public mutating func move(to p: CGPoint) {}
    public mutating func addLine(to p: CGPoint) {}
    public mutating func addLines(_ p: [CGPoint]) {}
    public mutating func addRect(_ r: CGRect) {}
    public mutating func addRoundedRect(in r: CGRect, cornerSize: CGSize, style: RoundedCornerStyle = .continuous) {}
    public mutating func addEllipse(in r: CGRect) {}
    public mutating func addQuadCurve(to p: CGPoint, control: CGPoint) {}
    public mutating func addCurve(to p: CGPoint, control1: CGPoint, control2: CGPoint) {}
    public mutating func addArc(center: CGPoint, radius: CGFloat, startAngle: Angle, endAngle: Angle, clockwise: Bool) {}
    public mutating func closeSubpath() {}
    public var boundingRect: CGRect { .zero }
}
public struct FillStyle: Equatable, Sendable { public init(eoFill: Bool = false, antialiased: Bool = true) {} }
public struct StrokeStyle: Equatable, Sendable {
    public enum LineCap: Sendable { case butt, round, square }
    public enum LineJoin: Sendable { case miter, round, bevel }
    public init(lineWidth: CGFloat = 1, lineCap: LineCap = .butt, lineJoin: LineJoin = .miter, miterLimit: CGFloat = 10, dash: [CGFloat] = [], dashPhase: CGFloat = 0) {}
}
public protocol Shape: _PrimitiveView, Sendable { func path(in rect: CGRect) -> Path }
public protocol InsettableShape: Shape { associatedtype InsetShape: InsettableShape; func inset(by amount: CGFloat) -> InsetShape }
extension Shape {
    public func fill<S: ShapeStyle>(_ content: S = ForegroundStyle(), style: FillStyle = FillStyle()) -> _V<Self> { .init() }
    public func fill(style: FillStyle = FillStyle()) -> _V<Self> { .init() }
    public func stroke<S: ShapeStyle>(_ content: S, lineWidth: CGFloat = 1) -> _V<Self> { .init() }
    public func stroke<S: ShapeStyle>(_ content: S, style: StrokeStyle, antialiased: Bool = true) -> _V<Self> { .init() }
    public func stroke(lineWidth: CGFloat = 1) -> _V<Self> { .init() }
    public func stroke(style: StrokeStyle) -> _V<Self> { .init() }
    public func trim(from: CGFloat = 0, to: CGFloat = 1) -> some Shape { self }
    public func rotation(_ a: Angle, anchor: UnitPoint = .center) -> some Shape { self }
    public func offset(x: CGFloat = 0, y: CGFloat = 0) -> some Shape { self }
    public func size(width: CGFloat, height: CGFloat) -> some Shape { self }
}
extension InsettableShape {
    public func strokeBorder<S: ShapeStyle>(_ content: S, lineWidth: CGFloat = 1, antialiased: Bool = true) -> _V<Self> { .init() }
    public func strokeBorder<S: ShapeStyle>(_ content: S, style: StrokeStyle, antialiased: Bool = true) -> _V<Self> { .init() }
    public func strokeBorder(lineWidth: CGFloat = 1, antialiased: Bool = true) -> _V<Self> { .init() }
    public func strokeBorder(style: StrokeStyle, antialiased: Bool = true) -> _V<Self> { .init() }
}
public struct Rectangle: InsettableShape { public init() {}; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> Rectangle { self } }
public struct RoundedRectangle: InsettableShape { public var cornerSize: CGSize; public init(cornerRadius: CGFloat, style: RoundedCornerStyle = .continuous) { cornerSize = .zero }; public init(cornerSize: CGSize, style: RoundedCornerStyle = .continuous) { self.cornerSize = cornerSize }; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> RoundedRectangle { self } }
public struct UnevenRoundedRectangle: InsettableShape { public init(topLeadingRadius: CGFloat = 0, bottomLeadingRadius: CGFloat = 0, bottomTrailingRadius: CGFloat = 0, topTrailingRadius: CGFloat = 0, style: RoundedCornerStyle = .continuous) {}; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> UnevenRoundedRectangle { self } }
public struct Circle: InsettableShape { public init() {}; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> Circle { self } }
public struct Ellipse: InsettableShape { public init() {}; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> Ellipse { self } }
public struct Capsule: InsettableShape { public init(style: RoundedCornerStyle = .continuous) {}; public func path(in r: CGRect) -> Path { Path() }; public func inset(by a: CGFloat) -> Capsule { self } }
public struct AnyShape: Shape { public init<S: Shape>(_ s: S) {}; public func path(in r: CGRect) -> Path { Path() } }
extension Shape where Self == Rectangle { public static var rect: Rectangle { .init() } }
extension Shape where Self == Circle { public static var circle: Circle { .init() } }
extension Shape where Self == Capsule { public static var capsule: Capsule { .init() } }
extension Shape where Self == RoundedRectangle { public static func rect(cornerRadius: CGFloat, style: RoundedCornerStyle = .continuous) -> RoundedRectangle { .init(cornerRadius: cornerRadius, style: style) } }
extension Shape where Self == UnevenRoundedRectangle { public static func rect(topLeadingRadius: CGFloat = 0, bottomLeadingRadius: CGFloat = 0, bottomTrailingRadius: CGFloat = 0, topTrailingRadius: CGFloat = 0, style: RoundedCornerStyle = .continuous) -> UnevenRoundedRectangle { .init() } }

// MARK: Animation & transitions
public struct Animation: Equatable, Sendable {
    public static let `default` = Animation(), easeInOut = Animation(), easeIn = Animation(), easeOut = Animation(), linear = Animation(), spring = Animation(), interactiveSpring = Animation(), smooth = Animation(), snappy = Animation(), bouncy = Animation()
    public static func easeInOut(duration: TimeInterval) -> Animation { .init() }
    public static func easeIn(duration: TimeInterval) -> Animation { .init() }
    public static func easeOut(duration: TimeInterval) -> Animation { .init() }
    public static func linear(duration: TimeInterval) -> Animation { .init() }
    public static func spring(response: Double = 0.5, dampingFraction: Double = 0.825, blendDuration: TimeInterval = 0) -> Animation { .init() }
    public static func spring(duration: TimeInterval = 0.5, bounce: Double = 0, blendDuration: Double = 0) -> Animation { .init() }
    public static func interactiveSpring(response: Double = 0.15, dampingFraction: Double = 0.86, blendDuration: TimeInterval = 0.25) -> Animation { .init() }
    public static func smooth(duration: TimeInterval = 0.5, extraBounce: Double = 0) -> Animation { .init() }
    public static func snappy(duration: TimeInterval = 0.5, extraBounce: Double = 0) -> Animation { .init() }
    public static func bouncy(duration: TimeInterval = 0.5, extraBounce: Double = 0) -> Animation { .init() }
    public func delay(_ d: TimeInterval) -> Animation { self }
    public func speed(_ s: Double) -> Animation { self }
    public func repeatForever(autoreverses: Bool = true) -> Animation { self }
    public func repeatCount(_ n: Int, autoreverses: Bool = true) -> Animation { self }
}
public func withAnimation<Result>(_ animation: Animation? = .default, _ body: () throws -> Result) rethrows -> Result { try body() }
public func withTransaction<Result>(_ t: Transaction, _ body: () throws -> Result) rethrows -> Result { try body() }
public struct AnyTransition: Sendable {
    public static let opacity = AnyTransition(), scale = AnyTransition(), slide = AnyTransition(), identity = AnyTransition()
    public static func move(edge: Edge) -> AnyTransition { .init() }
    public static func push(from edge: Edge) -> AnyTransition { .init() }
    public static func offset(x: CGFloat = 0, y: CGFloat = 0) -> AnyTransition { .init() }
    public static func offset(_ s: CGSize) -> AnyTransition { .init() }
    public static func scale(scale: CGFloat, anchor: UnitPoint = .center) -> AnyTransition { .init() }
    public static func asymmetric(insertion: AnyTransition, removal: AnyTransition) -> AnyTransition { .init() }
    public func combined(with other: AnyTransition) -> AnyTransition { self }
    public func animation(_ a: Animation?) -> AnyTransition { self }
}
