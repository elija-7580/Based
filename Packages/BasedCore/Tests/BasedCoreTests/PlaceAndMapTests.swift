import XCTest
@testable import BasedCore

/// Pass 12: Place values and Notion-style map views.
@MainActor
final class PlaceAndMapTests: XCTestCase {
    func testPlaceValueParsingAndEncoding() {
        let typed = PlaceValue(raw: "Marienplatz, München")
        XCTAssertEqual(typed.name, "Marienplatz, München")
        XCTAssertFalse(typed.hasCoordinates)
        XCTAssertEqual(typed.raw, "Marienplatz, München", "plain text stays readable until geocoded")
        XCTAssertEqual(typed.searchText, "Marienplatz, München")

        let coords = PlaceValue(raw: "48.1371, 11.5754")
        XCTAssertEqual(coords.lat ?? 0, 48.1371, accuracy: 1e-9)
        XCTAssertEqual(coords.lon ?? 0, 11.5754, accuracy: 1e-9)
        XCTAssertTrue(coords.hasCoordinates)
        XCTAssertEqual(coords.display, "48.13710, 11.57540")
        XCTAssertNil(PlaceValue(raw: "123, 456").lat, "out of range numbers are a name")

        let full = PlaceValue(name: "Café", address: "Main St 1, Berlin", lat: 52.5, lon: 13.4, googlePlaceID: "g1")
        let back = PlaceValue(raw: full.raw)
        XCTAssertEqual(back, full)
        XCTAssertTrue(full.raw.contains("\"google_place_id\":\"g1\""))
        XCTAssertEqual(full.display, "Café, Main St 1, Berlin")
        XCTAssertEqual(PlaceValue(name: "Berlin", address: "Berlin, Germany").display, "Berlin, Germany")
        XCTAssertTrue(PlaceValue(name: "  ").isEmpty)
        XCTAssertFalse(PlaceValue(lat: 0, lon: 0).hasCoordinates, "0,0 means unknown")
        XCTAssertEqual(PlaceValue.display(full.raw), full.display)
    }

    func testMapViewCreatesPlacePropertyAndDisplaysPlaces() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let page = s.createPage(title: "Trips")
        let c = s.createDatabase(title: RichText("Places"), in: .block(page), inline: true, sampleRows: 0)
        XCTAssertNil(s.databases[c.databaseID]?.properties.first { $0.type == .place })
        let block = try XCTUnwrap(s.views[c.viewID]?.blockID)
        let mapID = try XCTUnwrap(s.addView(to: block, type: .map))
        let map = try XCTUnwrap(s.views[mapID])
        XCTAssertEqual(map.type, .map)
        let place = try XCTUnwrap(s.databases[c.databaseID]?.properties.first { $0.type == .place })
        XCTAssertEqual(map.mapPropertyID, place.id, "map views get a Place property like in Notion")
        XCTAssertTrue(ViewType.available.contains(.map))

        let row = s.addRow(to: c.databaseID, title: RichText("Lunch"),
                           values: [place.id: .place(PlaceValue(name: "Café", address: "Main St 1", lat: 52.5, lon: 13.4).raw)])
        XCTAssertEqual(s.blocks[row]?.values[place.id]?.plainString(place), "Café, Main St 1")

        // A second map view reuses the existing Place property; deleting it clears the map setting.
        let map2 = try XCTUnwrap(s.addView(to: block, type: .map))
        XCTAssertEqual(s.views[map2]?.mapPropertyID, place.id)
        XCTAssertEqual(s.databases[c.databaseID]?.properties.filter { $0.type == .place }.count, 1)
        s.deleteProperty(c.databaseID, place.id)
        XCTAssertNil(s.views[map2]?.mapPropertyID)
    }
}
