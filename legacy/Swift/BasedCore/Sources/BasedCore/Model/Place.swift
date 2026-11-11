import Foundation

/// Value of a Place property (Notion's "place": name, address, coordinates). Stored in `PropertyValue.place(String)`:
/// a JSON object once coordinates are known, otherwise the plain text the user typed (geocoded later by the map view).
public struct PlaceValue: Codable, Hashable, Sendable {
    public var name: String?
    public var address: String?
    public var lat: Double?
    public var lon: Double?
    public var googlePlaceID: String?

    enum CodingKeys: String, CodingKey { case name, address, lat, lon, googlePlaceID = "google_place_id" }

    public init(name: String? = nil, address: String? = nil, lat: Double? = nil, lon: Double? = nil, googlePlaceID: String? = nil) {
        self.name = name?.nilIfBlank; self.address = address?.nilIfBlank; self.lat = lat; self.lon = lon; self.googlePlaceID = googlePlaceID
    }

    /// Parses a stored place: JSON (`{"name":…,"lat":…}`) or legacy plain text (treated as the name / search text).
    public init(raw: String) {
        let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("{"), let d = t.data(using: .utf8), let v = try? JSONDecoder().decode(PlaceValue.self, from: d) {
            self = v
            return
        }
        // "48.1371, 11.5754" → coordinates only
        let parts = t.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
        if parts.count == 2, let a = Double(parts[0]), let b = Double(parts[1]), abs(a) <= 90, abs(b) <= 180 {
            self.init(lat: a, lon: b)
            return
        }
        self.init(name: t)
    }

    /// Encoded for `PropertyValue.place`. Without coordinates and address the plain name is kept (readable, legacy-compatible).
    public var raw: String {
        if lat == nil, lon == nil, address == nil, googlePlaceID == nil { return name ?? "" }
        let enc = JSONEncoder()
        enc.outputFormatting = [.sortedKeys]
        return (try? enc.encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? (name ?? "")
    }

    public var hasCoordinates: Bool {
        guard let lat, let lon else { return false }
        return abs(lat) <= 90 && abs(lon) <= 180 && !(lat == 0 && lon == 0)
    }

    /// What cells, search and filters show.
    public var display: String {
        if let name, let address { return address.hasPrefix(name) ? address : "\(name), \(address)" }
        if let name { return name }
        if let address { return address }
        if let lat, let lon { return String(format: "%.5f, %.5f", lat, lon) }
        return ""
    }

    /// Text to geocode when coordinates are missing.
    public var searchText: String { [address, name].compactMap { $0 }.first ?? "" }

    public var isEmpty: Bool { name == nil && address == nil && lat == nil && lon == nil }

    /// Display text of a stored raw place value.
    public static func display(_ raw: String) -> String { PlaceValue(raw: raw).display }
}

private extension String {
    var nilIfBlank: String? { trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : self }
}
