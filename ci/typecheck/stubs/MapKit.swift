import SwiftUI
@_exported import CoreLocation

public struct MKCoordinateSpan: Sendable, Equatable {
    public var latitudeDelta: CLLocationDegrees, longitudeDelta: CLLocationDegrees
    public init() { latitudeDelta = 0; longitudeDelta = 0 }
    public init(latitudeDelta: CLLocationDegrees, longitudeDelta: CLLocationDegrees) { self.latitudeDelta = latitudeDelta; self.longitudeDelta = longitudeDelta }
}
public struct MKCoordinateRegion: Sendable, Equatable {
    public var center: CLLocationCoordinate2D, span: MKCoordinateSpan
    public init() { center = .init(); span = .init() }
    public init(center: CLLocationCoordinate2D, span: MKCoordinateSpan) { self.center = center; self.span = span }
    public init(center: CLLocationCoordinate2D, latitudinalMeters: CLLocationDistance, longitudinalMeters: CLLocationDistance) { self.center = center; span = .init() }
}
open class MKPlacemark: CLPlacemark, @unchecked Sendable {
    public init(coordinate: CLLocationCoordinate2D) { super.init() }
    open var coordinate: CLLocationCoordinate2D { .init() }
    open var title: String? { nil }
}
open class MKMapItem: @unchecked Sendable {
    public init(placemark: MKPlacemark) {}
    open var name: String?
    open var placemark: MKPlacemark { MKPlacemark(coordinate: .init()) }
    open var phoneNumber: String?
    open var url: URL?
}
open class MKLocalSearch {
    open class Request {
        public init() {}
        open var naturalLanguageQuery: String?
        open var region: MKCoordinateRegion = .init()
    }
    open class Response { open var mapItems: [MKMapItem] { [] }; open var boundingRegion: MKCoordinateRegion { .init() } }
    public init(request: MKLocalSearch.Request) {}
    open func start() async throws -> MKLocalSearch.Response { Response() }
    open func cancel() {}
}

public struct MapCameraPosition: Sendable, Equatable {
    public static let automatic = MapCameraPosition()
    public static func region(_ region: MKCoordinateRegion) -> MapCameraPosition { .init() }
    public static func item(_ item: MKMapItem) -> MapCameraPosition { .init() }
    public static func userLocation(fallback: MapCameraPosition) -> MapCameraPosition { .init() }
    public var region: MKCoordinateRegion? { nil }
    public var positionedByUser: Bool { false }
}
public struct MapCameraBounds: Sendable { public init(minimumDistance: Double? = nil, maximumDistance: Double? = nil) {} }
public struct MapInteractionModes: OptionSet, Sendable {
    public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let pan = MapInteractionModes(rawValue: 1), zoom = MapInteractionModes(rawValue: 2), rotate = MapInteractionModes(rawValue: 4), pitch = MapInteractionModes(rawValue: 8), all = MapInteractionModes(rawValue: 15)
}

public protocol MapContent { associatedtype Body: MapContent; @MapContentBuilder var body: Body { get } }
extension Never: MapContent {}
public protocol _PrimitiveMapContent: MapContent where Body == Never {}
extension _PrimitiveMapContent { public var body: Never { fatalError() } }
public struct _MC<T>: _PrimitiveMapContent {}
extension Optional: MapContent where Wrapped: MapContent { public var body: Never { fatalError() } }
@resultBuilder public struct MapContentBuilder {
    public static func buildExpression<C: MapContent>(_ c: C) -> C { c }
    public static func buildBlock() -> _MC<Void> { .init() }
    public static func buildBlock<C: MapContent>(_ c: C) -> C { c }
    public static func buildBlock<each C: MapContent>(_ c: repeat each C) -> _MC<(repeat each C)> { .init() }
    public static func buildIf<C: MapContent>(_ c: C?) -> C? { c }
    public static func buildEither<T: MapContent, F: MapContent>(first: T) -> _MC<(T, F)> { .init() }
    public static func buildEither<T: MapContent, F: MapContent>(second: F) -> _MC<(T, F)> { .init() }
}
extension ForEach: MapContent, _PrimitiveMapContent where Content: MapContent {}
extension ForEach where Content: MapContent {
    public init(_ data: Data, @MapContentBuilder content: @escaping (Data.Element) -> Content) where ID == Data.Element.ID, Data.Element: Identifiable { fatalError() }
    public init(_ data: Data, id: KeyPath<Data.Element, ID>, @MapContentBuilder content: @escaping (Data.Element) -> Content) { fatalError() }
}
public struct Marker<Label: View>: _PrimitiveMapContent {
    public init<S: StringProtocol>(_ title: S, coordinate: CLLocationCoordinate2D) where Label == Text {}
    public init<S: StringProtocol>(_ title: S, systemImage: String, coordinate: CLLocationCoordinate2D) where Label == Text {}
    public init<S: StringProtocol>(_ title: S, image: String, coordinate: CLLocationCoordinate2D) where Label == Text {}
    public init<S: StringProtocol>(_ title: S, monogram: Text, coordinate: CLLocationCoordinate2D) where Label == Text {}
    public init(coordinate: CLLocationCoordinate2D, @ViewBuilder label: () -> Label) {}
}
public struct Annotation<Label: View, Content: View>: _PrimitiveMapContent {
    public init<S: StringProtocol>(_ title: S, coordinate: CLLocationCoordinate2D, anchor: UnitPoint = .bottom, @ViewBuilder content: () -> Content) where Label == Text {}
}
extension MapContent {
    public func tint(_ tint: Color) -> _MC<Self> { .init() }
    public func tag<V: Hashable>(_ tag: V) -> _MC<Self> { .init() }
    public func annotationTitles(_ visibility: Visibility) -> _MC<Self> { .init() }
}

public struct Map<Content>: _PrimitiveView {
    public init<C: MapContent>(position: Binding<MapCameraPosition>, bounds: MapCameraBounds? = nil, interactionModes: MapInteractionModes = .all, @MapContentBuilder content: () -> C) where Content == C {}
    public init<C: MapContent, S: Hashable>(position: Binding<MapCameraPosition>, bounds: MapCameraBounds? = nil, interactionModes: MapInteractionModes = .all, selection: Binding<S?>, @MapContentBuilder content: () -> C) where Content == (S, C) {}
    public init<C: MapContent>(initialPosition: MapCameraPosition = .automatic, bounds: MapCameraBounds? = nil, interactionModes: MapInteractionModes = .all, @MapContentBuilder content: () -> C) where Content == C {}
}

public struct MapStyle: Sendable {
    public enum Elevation: Sendable { case automatic, flat, realistic }
    public static let standard = MapStyle(), imagery = MapStyle(), hybrid = MapStyle()
    public static func standard(elevation: Elevation = .automatic, emphasis: Emphasis = .automatic, pointsOfInterest: PointOfInterestCategories = .all, showsTraffic: Bool = false) -> MapStyle { .init() }
    public static func imagery(elevation: Elevation = .automatic) -> MapStyle { .init() }
    public static func hybrid(elevation: Elevation = .automatic, pointsOfInterest: PointOfInterestCategories = .all, showsTraffic: Bool = false) -> MapStyle { .init() }
    public enum Emphasis: Sendable { case automatic, muted }
}
public struct PointOfInterestCategories: Sendable {
    public static let all = PointOfInterestCategories(), excludingAll = PointOfInterestCategories()
    public static func including(_ c: [String]) -> PointOfInterestCategories { .init() }
    public static func excluding(_ c: [String]) -> PointOfInterestCategories { .init() }
}

public protocol _MapControl: View {}
public struct MapCompass: _PrimitiveView, _MapControl { public init() {} }
public struct MapScaleView: _PrimitiveView, _MapControl { public init(anchorEdge: HorizontalEdge = .leading) {} }
public struct MapZoomStepper: _PrimitiveView, _MapControl { public init() {} }
public struct MapPitchToggle: _PrimitiveView, _MapControl { public init() {} }
public struct MapUserLocationButton: _PrimitiveView, _MapControl { public init() {} }

extension View {
    public func mapStyle(_ style: MapStyle) -> _V<Self> { .init() }
    public func mapControls<C: View>(@ViewBuilder _ content: () -> C) -> _V<Self> { .init() }
    public func mapControlVisibility(_ v: Visibility) -> _V<Self> { .init() }
    public func onMapCameraChange(_ action: @escaping () -> Void) -> _V<Self> { .init() }
}
