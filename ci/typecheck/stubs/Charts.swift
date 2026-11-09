import SwiftUI
public protocol Plottable {}
extension String: Plottable {}; extension Double: Plottable {}; extension Int: Plottable {}; extension Float: Plottable {}; extension Date: Plottable {}; extension CGFloat: Plottable {}
public struct PlottableValue<Value: Plottable> {
    public static func value(_ label: LocalizedStringKey, _ value: Value) -> PlottableValue<Value> { .init() }
    @_disfavoredOverload public static func value<S: StringProtocol>(_ label: S, _ value: Value) -> PlottableValue<Value> { .init() }
    public static func value(_ label: LocalizedStringKey, _ value: Value, unit: Calendar.Component) -> PlottableValue<Value> where Value == Date { .init() }
}
public protocol ChartContent { associatedtype Body: ChartContent; @ChartContentBuilder var body: Body { get } }
extension Never: ChartContent {}
public protocol _PrimitiveChartContent: ChartContent where Body == Never {}
extension _PrimitiveChartContent { public var body: Never { fatalError() } }
public struct _CC<T>: _PrimitiveChartContent {}
extension Optional: ChartContent where Wrapped: ChartContent { public var body: Never { fatalError() } }
@resultBuilder public struct ChartContentBuilder {
    public static func buildExpression<C: ChartContent>(_ c: C) -> C { c }
    public static func buildBlock() -> _CC<Void> { .init() }
    public static func buildBlock<C: ChartContent>(_ c: C) -> C { c }
    public static func buildBlock<each C: ChartContent>(_ c: repeat each C) -> _CC<(repeat each C)> { .init() }
    public static func buildIf<C: ChartContent>(_ c: C?) -> C? { c }
    public static func buildEither<T: ChartContent, F: ChartContent>(first: T) -> _CC<(T, F)> { .init() }
    public static func buildEither<T: ChartContent, F: ChartContent>(second: F) -> _CC<(T, F)> { .init() }
}
extension ForEach: ChartContent, _PrimitiveChartContent where Content: ChartContent {}
extension ForEach where Content: ChartContent {
    public init(_ data: Data, @ChartContentBuilder content: @escaping (Data.Element) -> Content) where ID == Data.Element.ID, Data.Element: Identifiable { fatalError() }
    public init(_ data: Data, id: KeyPath<Data.Element, ID>, @ChartContentBuilder content: @escaping (Data.Element) -> Content) { fatalError() }
}
public struct MarkDimension: Sendable { public static let automatic = MarkDimension(); public static func ratio(_ r: Double) -> MarkDimension { .init() }; public static func fixed(_ v: CGFloat) -> MarkDimension { .init() }; public static func inset(_ v: CGFloat) -> MarkDimension { .init() } }
public struct InterpolationMethod: Sendable { public static let linear = InterpolationMethod(), catmullRom = InterpolationMethod(), cardinal = InterpolationMethod(), monotone = InterpolationMethod(), stepStart = InterpolationMethod(), stepCenter = InterpolationMethod(), stepEnd = InterpolationMethod() }
public struct AnnotationPosition: Sendable { public static let automatic = AnnotationPosition(), top = AnnotationPosition(), bottom = AnnotationPosition(), leading = AnnotationPosition(), trailing = AnnotationPosition(), overlay = AnnotationPosition(), topLeading = AnnotationPosition(), topTrailing = AnnotationPosition() }
public struct BarMark: _PrimitiveChartContent {
    public init<X: Plottable, Y: Plottable>(x: PlottableValue<X>, y: PlottableValue<Y>, width: MarkDimension = .automatic, height: MarkDimension = .automatic, stacking: MarkStackingMethod = .standard) {}
}
public struct MarkStackingMethod: Sendable { public static let standard = MarkStackingMethod(), normalized = MarkStackingMethod(), center = MarkStackingMethod(), unstacked = MarkStackingMethod() }
public struct LineMark: _PrimitiveChartContent { public init<X: Plottable, Y: Plottable>(x: PlottableValue<X>, y: PlottableValue<Y>) {}; public init<X: Plottable, Y: Plottable, S: Plottable>(x: PlottableValue<X>, y: PlottableValue<Y>, series: PlottableValue<S>) {} }
public struct AreaMark: _PrimitiveChartContent { public init<X: Plottable, Y: Plottable>(x: PlottableValue<X>, y: PlottableValue<Y>, stacking: MarkStackingMethod = .standard) {} }
public struct PointMark: _PrimitiveChartContent { public init<X: Plottable, Y: Plottable>(x: PlottableValue<X>, y: PlottableValue<Y>) {} }
public struct RuleMark: _PrimitiveChartContent { public init<Y: Plottable>(y: PlottableValue<Y>) {}; public init<X: Plottable>(x: PlottableValue<X>) {} }
public struct SectorMark: _PrimitiveChartContent { public init<V: Plottable>(angle: PlottableValue<V>, innerRadius: MarkDimension = .automatic, outerRadius: MarkDimension = .automatic, angularInset: CGFloat? = nil) {} }
public struct BasicChartSymbolShape: Sendable { public static let circle = BasicChartSymbolShape(), square = BasicChartSymbolShape() }
extension ChartContent {
    public func foregroundStyle<S: ShapeStyle>(_ s: S) -> _CC<Self> { .init() }
    public func foregroundStyle<D: Plottable>(by value: PlottableValue<D>) -> _CC<Self> { .init() }
    public func position<D: Plottable>(by value: PlottableValue<D>, axis: Axis? = nil) -> _CC<Self> { .init() }
    public func annotation<C: View>(position: AnnotationPosition = .automatic, alignment: Alignment = .center, spacing: CGFloat? = nil, @ViewBuilder content: () -> C) -> _CC<Self> { .init() }
    public func opacity(_ o: Double) -> _CC<Self> { .init() }
    public func interpolationMethod(_ m: InterpolationMethod) -> _CC<Self> { .init() }
    public func lineStyle(_ s: StrokeStyle) -> _CC<Self> { .init() }
    public func symbolSize(_ s: CGFloat) -> _CC<Self> { .init() }
    public func symbol(_ s: BasicChartSymbolShape) -> _CC<Self> { .init() }
    public func cornerRadius(_ r: CGFloat, style: RoundedCornerStyle = .continuous) -> _CC<Self> { .init() }
    public func accessibilityLabel(_ t: Text) -> _CC<Self> { .init() }
}
public struct Chart<Content: View>: _PrimitiveView {
    public init<C: ChartContent>(@ChartContentBuilder content: () -> C) where Content == _V<C> {}
    public init<Data: RandomAccessCollection, C: ChartContent>(_ data: Data, @ChartContentBuilder content: @escaping (Data.Element) -> C) where Content == _V<ForEach<Data, Data.Element.ID, C>>, Data.Element: Identifiable {}
    public init<Data: RandomAccessCollection, ID: Hashable, C: ChartContent>(_ data: Data, id: KeyPath<Data.Element, ID>, @ChartContentBuilder content: @escaping (Data.Element) -> C) where Content == _V<ForEach<Data, ID, C>> {}
}
public protocol ScaleDomain {}
extension Array: ScaleDomain where Element: Plottable {}
extension ClosedRange: ScaleDomain where Bound: Plottable {}
public struct ChartProxy {
    public func value<P: Plottable>(atX x: CGFloat, as: P.Type = P.self) -> P? { nil }
    public func value<P: Plottable>(atY y: CGFloat, as: P.Type = P.self) -> P? { nil }
    public func position<P: Plottable>(forX v: P) -> CGFloat? { nil }
    public func position<P: Plottable>(forY v: P) -> CGFloat? { nil }
    public var plotAreaFrame: Anchor<CGRect> { fatalError() }
    public var plotFrame: Anchor<CGRect>? { nil }
    public var plotSize: CGSize { .zero }
}
public struct AxisMarks: _PrimitiveChartContent { public init() {}; public init(values: [Double]) {} }
extension View {
    public func chartXScale<D: ScaleDomain>(domain: D) -> _V<Self> { .init() }
    public func chartYScale<D: ScaleDomain>(domain: D) -> _V<Self> { .init() }
    public func chartLegend(_ v: Visibility) -> _V<Self> { .init() }
    public func chartLegend(position: AnnotationPosition, alignment: Alignment? = nil, spacing: CGFloat? = nil) -> _V<Self> { .init() }
    public func chartOverlay<V: View>(alignment: Alignment = .center, @ViewBuilder content: @escaping (ChartProxy) -> V) -> _V<Self> { .init() }
    public func chartBackground<V: View>(alignment: Alignment = .center, @ViewBuilder content: @escaping (ChartProxy) -> V) -> _V<Self> { .init() }
    public func chartXAxis(_ v: Visibility) -> _V<Self> { .init() }
    public func chartYAxis(_ v: Visibility) -> _V<Self> { .init() }
    public func chartForegroundStyleScale<D: Plottable, S: ShapeStyle>(_ mapping: KeyValuePairs<D, S>) -> _V<Self> { .init() }
}
