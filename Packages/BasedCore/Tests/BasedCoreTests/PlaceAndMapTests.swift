import Foundation
import Testing
@testable import BasedCore

/// Pass 12: Place values and Notion-style map views.
@MainActor
@Suite struct PlaceAndMapTests {
    @Test func placeValueParsingAndEncoding() {
        let typed = PlaceValue(raw: "Marienplatz, München")
        #expect(typed.name == "Marienplatz, München")
        #expect(!typed.hasCoordinates)
        #expect(typed.raw == "Marienplatz, München", "plain text stays readable until geocoded")
        #expect(typed.searchText == "Marienplatz, München")

        let coords = PlaceValue(raw: "48.1371, 11.5754")
        #expect(abs((coords.lat ?? 0) - 48.1371) <= 1e-9)
        #expect(abs((coords.lon ?? 0) - 11.5754) <= 1e-9)
        #expect(coords.hasCoordinates)
        #expect(coords.display == "48.13710, 11.57540")
        #expect(PlaceValue(raw: "123, 456").lat == nil, "out of range numbers are a name")

        let full = PlaceValue(name: "Café", address: "Main St 1, Berlin", lat: 52.5, lon: 13.4, googlePlaceID: "g1")
        let back = PlaceValue(raw: full.raw)
        #expect(back == full)
        #expect(full.raw.contains("\"google_place_id\":\"g1\""))
        #expect(full.display == "Café, Main St 1, Berlin")
        #expect(PlaceValue(name: "Berlin", address: "Berlin, Germany").display == "Berlin, Germany")
        #expect(PlaceValue(name: "  ").isEmpty)
        #expect(!(PlaceValue(lat: 0, lon: 0).hasCoordinates), "0,0 means unknown")
        #expect(PlaceValue.display(full.raw) == full.display)
    }

    @Test func mapViewCreatesPlacePropertyAndDisplaysPlaces() throws {
        let s = WorkspaceStore(persistence: nil, node: "t")
        let page = s.createPage(title: "Trips")
        let c = s.createDatabase(title: RichText("Places"), in: .block(page), inline: true, sampleRows: 0)
        #expect(s.databases[c.databaseID]?.properties.first { $0.type == .place } == nil)
        let block = try #require(s.views[c.viewID]?.blockID)
        let mapID = try #require(s.addView(to: block, type: .map))
        let map = try #require(s.views[mapID])
        #expect(map.type == .map)
        let place = try #require(s.databases[c.databaseID]?.properties.first { $0.type == .place })
        #expect(map.mapPropertyID == place.id, "map views get a Place property like in Notion")
        #expect(ViewType.available.contains(.map))

        let row = s.addRow(to: c.databaseID, title: RichText("Lunch"),
                           values: [place.id: .place(PlaceValue(name: "Café", address: "Main St 1", lat: 52.5, lon: 13.4).raw)])
        #expect(s.blocks[row]?.values[place.id]?.plainString(place) == "Café, Main St 1")

        // A second map view reuses the existing Place property; deleting it clears the map setting.
        let map2 = try #require(s.addView(to: block, type: .map))
        #expect(s.views[map2]?.mapPropertyID == place.id)
        #expect(s.databases[c.databaseID]?.properties.filter { $0.type == .place }.count == 1)
        s.deleteProperty(c.databaseID, place.id)
        #expect(s.views[map2]?.mapPropertyID == nil)
    }
}
