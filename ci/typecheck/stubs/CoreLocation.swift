import Foundation
public typealias CLLocationDegrees = Double
public typealias CLLocationDistance = Double
public struct CLLocationCoordinate2D: Sendable, Equatable {
    public var latitude: CLLocationDegrees
    public var longitude: CLLocationDegrees
    public init() { latitude = 0; longitude = 0 }
    public init(latitude: CLLocationDegrees, longitude: CLLocationDegrees) { self.latitude = latitude; self.longitude = longitude }
}
public func CLLocationCoordinate2DIsValid(_ c: CLLocationCoordinate2D) -> Bool { true }
open class CLLocation: @unchecked Sendable {
    public init(latitude: CLLocationDegrees, longitude: CLLocationDegrees) {}
    open var coordinate: CLLocationCoordinate2D { .init() }
    open func distance(from location: CLLocation) -> CLLocationDistance { 0 }
}
open class CLPlacemark: @unchecked Sendable {
    public init() {}
    open var name: String? { nil }
    open var thoroughfare: String? { nil }
    open var subThoroughfare: String? { nil }
    open var locality: String? { nil }
    open var administrativeArea: String? { nil }
    open var postalCode: String? { nil }
    open var country: String? { nil }
    open var isoCountryCode: String? { nil }
    open var location: CLLocation? { nil }
}
open class CLGeocoder {
    public init() {}
    open func geocodeAddressString(_ addressString: String) async throws -> [CLPlacemark] { [] }
    open func reverseGeocodeLocation(_ location: CLLocation) async throws -> [CLPlacemark] { [] }
    open func cancelGeocode() {}
    open var isGeocoding: Bool { false }
}
