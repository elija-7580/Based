import SwiftUI
import BasedCore
#if canImport(MapKit)
import MapKit
import CoreLocation
#endif

// MARK: - Map view

/// Notion-style map view: rows with a Place property become pins. Rows whose place has no coordinates yet (typed
/// addresses, Notion HTML exports) are geocoded in the background and saved; the rest are listed under the map.
struct MapLayout: View {
    let ctx: DBContext
    var compact = false
    #if canImport(MapKit)
    @State private var position: MapCameraPosition = .automatic
    #endif
    @State private var selection: RecordID?
    @State private var locating = 0
    @State private var failed: Set<String> = []

    private var placeProperty: PropertySchema? {
        if let id = ctx.view.mapPropertyID, let p = ctx.db.property(id), p.type == .place { return p }
        return ctx.db.properties.first { $0.type == .place }
    }

    struct Pin: Identifiable, Equatable {
        var id: RecordID
        var title: String
        var place: PlaceValue
        var emoji: String?
    }

    private func place(of row: Block, _ p: PropertySchema) -> PlaceValue? {
        guard case .place(let raw)? = row.values[p.id] else { return nil }
        let v = PlaceValue(raw: raw)
        return v.isEmpty ? nil : v
    }

    private func pins(_ p: PropertySchema) -> [Pin] {
        ctx.result.rows.compactMap { row in
            guard let v = place(of: row, p), v.hasCoordinates else { return nil }
            var emoji: String?
            if case .emoji(let e)? = row.props.icon { emoji = e }
            return Pin(id: row.id, title: ctx.store.title(of: row.id).nonEmptyOr("Untitled"), place: v, emoji: emoji)
        }
    }

    /// Rows not on the map: no place, or a place we couldn't locate.
    private func unplaced(_ p: PropertySchema) -> [Block] {
        ctx.result.rows.filter { row in place(of: row, p).map { !$0.hasCoordinates } ?? true }
    }

    private var height: CGFloat {
        if compact { return 360 }
        switch ctx.view.mapHeight {
        case "small"?: return 300
        case "large"?: return 620
        case "extra_large"?: return 800
        default: return 460
        }
    }

    var body: some View {
        if let p = placeProperty {
            VStack(alignment: .leading, spacing: 10) {
                map(p)
                    .frame(height: height)
                    .clipShape(RoundedRectangle(cornerRadius: compact ? 6 : 8))
                    .overlay(RoundedRectangle(cornerRadius: compact ? 6 : 8).stroke(Color(Theme.divider)))
                if !compact { unplacedList(p) }
            }
            .padding(.vertical, compact ? 0 : 8)
            .task(id: geocodeKey(p)) { await geocodeMissing(p) }
            .accessibilityIdentifier("map")
        } else {
            VStack(spacing: 10) {
                Image(systemName: "map").font(.system(size: 30)).foregroundStyle(Theme.secondary)
                Text("Map views need a Place property").font(.headline)
                Text("Rows are positioned on the map by their Place.").foregroundStyle(Theme.secondary)
                if !ctx.locked {
                    Button("Add a Place property") {
                        if let id = ctx.store.addProperty(to: ctx.db.id, name: "Place", type: .place) {
                            ctx.store.updateView(ctx.view.id) { $0.mapPropertyID = id }
                        }
                    }
                    .buttonStyle(.borderedProminent)
                }
            }
            .frame(maxWidth: .infinity, minHeight: compact ? 200 : 300)
        }
    }

    @ViewBuilder
    private func map(_ p: PropertySchema) -> some View {
        let all = pins(p)
        #if canImport(MapKit)
        ZStack(alignment: .bottom) {
            Map(position: $position, selection: $selection) {
                ForEach(all) { pin in
                    if let e = pin.emoji {
                        Marker(pin.title, monogram: Text(e), coordinate: CLLocationCoordinate2D(latitude: pin.place.lat ?? 0, longitude: pin.place.lon ?? 0))
                            .tint(Theme.accentBlue)
                            .tag(pin.id)
                    } else {
                        Marker(pin.title, systemImage: "mappin", coordinate: CLLocationCoordinate2D(latitude: pin.place.lat ?? 0, longitude: pin.place.lon ?? 0))
                            .tint(Color.red)
                            .tag(pin.id)
                    }
                }
            }
            .mapStyle(.standard(pointsOfInterest: .excludingAll))
            .mapControls {
                MapCompass()
                MapScaleView()
                #if os(macOS)
                MapZoomStepper()
                #endif
            }
            if let sel = selection, let row = ctx.store.blocks[sel], let pin = all.first(where: { $0.id == sel }) {
                MapRowCard(ctx: ctx, row: row, place: pin.place, close: { selection = nil })
                    .padding(12)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .overlay(alignment: .topLeading) {
            HStack(spacing: 6) {
                Text("\(all.count) on map").fontWeight(.medium)
                if locating > 0 { ProgressView().controlSize(.mini); Text("Locating \(locating)…") }
                Button { withAnimation { position = .automatic } } label: { Image(systemName: "scope") }
                    .buttonStyle(.quiet).help("Show all pins")
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(Capsule().fill(.regularMaterial))
            .padding(8)
        }
        .animation(.easeOut(duration: 0.15), value: selection)
        #else
        Text("\(all.count) places").frame(maxWidth: .infinity, maxHeight: .infinity)
        #endif
    }

    @ViewBuilder
    private func unplacedList(_ p: PropertySchema) -> some View {
        let rows = unplaced(p)
        if !rows.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(rows.prefix(100)) { row in
                        HStack(spacing: 8) {
                            PageIconView(icon: row.props.icon, size: 14)
                            Text(ctx.store.title(of: row.id).nonEmptyOr("Untitled")).lineLimit(1)
                            if let v = place(of: row, p) {
                                Text(v.display).foregroundStyle(Theme.secondary).lineLimit(1)
                                if failed.contains(v.searchText) {
                                    Text("not found").font(.caption).foregroundStyle(.orange)
                                }
                            }
                            Spacer()
                            Button("Open") { ctx.open(row.id) }.buttonStyle(.borderless).font(.caption)
                        }
                        .padding(.vertical, 3)
                        .contentShape(Rectangle())
                        .onTapGesture { ctx.open(row.id) }
                    }
                }
                .padding(.top, 4)
            } label: {
                Text("\(rows.count) without a location").font(.system(size: 13)).foregroundStyle(Theme.secondary)
            }
        }
    }

    // MARK: Geocoding

    private func geocodeKey(_ p: PropertySchema) -> String {
        unplaced(p).compactMap { place(of: $0, p)?.searchText }.filter { !$0.isEmpty && !failed.contains($0) }.prefix(50).joined(separator: "|")
    }

    /// Looks up typed places (sequentially — CLGeocoder is rate limited) and stores the coordinates on the row.
    private func geocodeMissing(_ p: PropertySchema) async {
        guard !ctx.locked else { return }
        let todo = unplaced(p).compactMap { row -> (RecordID, PlaceValue)? in
            guard let v = place(of: row, p), !v.searchText.isEmpty, !failed.contains(v.searchText) else { return nil }
            return (row.id, v)
        }.prefix(40)
        guard !todo.isEmpty else { return }
        locating = todo.count
        defer { locating = 0 }
        for (rowID, v) in todo {
            if Task.isCancelled { return }
            if let found = await PlaceLookup.geocode(v.searchText) {
                var nv = v
                nv.lat = found.lat; nv.lon = found.lon
                if nv.address == nil, let a = found.address, a != nv.name { nv.address = a }
                ctx.store.setValue(rowID, p.id, .place(nv.raw))
            } else {
                failed.insert(v.searchText)
            }
            locating = max(0, locating - 1)
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
    }
}

/// Card for the selected pin: icon, title, place and the view's visible properties.
struct MapRowCard: View {
    let ctx: DBContext
    let row: Block
    let place: PlaceValue
    let close: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                PageIconView(icon: row.props.icon, size: 18)
                Text(ctx.store.title(of: row.id).nonEmptyOr("Untitled")).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Spacer()
                Button("Open") { ctx.open(row.id) }.controlSize(.small)
                Button(action: close) { Image(systemName: "xmark") }.buttonStyle(.hoverFill).foregroundStyle(Theme.secondary)
            }
            Label(place.display, systemImage: "mappin.and.ellipse").font(.system(size: 12.5)).foregroundStyle(Theme.secondary).lineLimit(2)
            ForEach(ctx.cardProperties.filter { $0.type != .place }.prefix(4), id: \.id) { p in
                let v = ctx.value(row, p)
                if !v.isEmpty {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(p.name).font(.system(size: 12)).foregroundStyle(Theme.secondary).frame(width: 90, alignment: .leading).lineLimit(1)
                        PropertyValueView(property: p, value: v, row: row).font(.system(size: 12.5))
                    }
                }
            }
        }
        .padding(12)
        .frame(maxWidth: 380, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10).fill(Chrome.appBackground).shadow(color: .black.opacity(0.18), radius: 10, y: 3))
        .contentShape(Rectangle())
        .onTapGesture(count: 2) { ctx.open(row.id) }
    }
}

// MARK: - Place lookup & editor

/// MapKit geocoding / search with an in-memory cache (results are saved on the row, so this only spans a launch).
enum PlaceLookup {
    struct Result: Identifiable, Hashable {
        var id: String { "\(name)|\(lat)|\(lon)" }
        var name: String
        var address: String?
        var lat: Double
        var lon: Double
    }

    @MainActor private static var cache: [String: Result?] = [:]

    @MainActor
    static func geocode(_ text: String) async -> Result? {
        if let hit = cache[text] { return hit }
        var out: Result?
        #if canImport(MapKit)
        if let pm = try? await CLGeocoder().geocodeAddressString(text).first, let loc = pm.location {
            let address = [pm.thoroughfare, pm.locality, pm.country].compactMap { $0 }.joined(separator: ", ")
            out = Result(name: pm.name ?? text, address: address.isEmpty ? nil : address, lat: loc.coordinate.latitude, lon: loc.coordinate.longitude)
        }
        #endif
        cache[text] = out
        return out
    }

    @MainActor
    static func search(_ query: String) async -> [Result] {
        #if canImport(MapKit)
        let req = MKLocalSearch.Request()
        req.naturalLanguageQuery = query
        guard let resp = try? await MKLocalSearch(request: req).start() else { return [] }
        return resp.mapItems.prefix(8).map { item in
            let c = item.placemark.coordinate
            return Result(name: item.name ?? query, address: item.placemark.title, lat: c.latitude, lon: c.longitude)
        }
        #else
        return []
        #endif
    }
}

/// Popover editor for a Place cell: search places / addresses (MapKit), or keep the typed text.
struct PlaceEditor: View {
    let rowID: RecordID
    let property: PropertySchema
    let done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var query = ""
    @State private var results: [PlaceLookup.Result] = []
    @State private var searching = false
    @FocusState private var focused: Bool

    private var current: PlaceValue? {
        guard case .place(let raw)? = model.store.blocks[rowID]?.values[property.id] else { return nil }
        let v = PlaceValue(raw: raw)
        return v.isEmpty ? nil : v
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Search for a place or address", text: $query)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit { if let r = results.first { pick(r) } else { keepTyped() } }
                .accessibilityIdentifier("place.search")
            if searching { ProgressView().controlSize(.small) }
            ForEach(results) { r in
                Button { pick(r) } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "mappin.circle.fill").foregroundStyle(.red)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(r.name).lineLimit(1)
                            if let a = r.address { Text(a).font(.caption).foregroundStyle(Theme.secondary).lineLimit(1) }
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.hoverFill)
            }
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                Button("Use “\(query)” as typed") { keepTyped() }.buttonStyle(.borderless).font(.caption)
            }
            if let c = current {
                Divider()
                HStack {
                    Label(c.display, systemImage: c.hasCoordinates ? "mappin.and.ellipse" : "mappin.slash").lineLimit(2)
                    Spacer()
                    Button("Remove") { model.store.setValue(rowID, property.id, nil); done() }.buttonStyle(.borderless).foregroundStyle(.red)
                }
                .font(.system(size: 12.5))
            }
        }
        .padding(10)
        .frame(width: 320)
        .onAppear { focused = true; query = current?.name ?? current?.address ?? "" }
        .task(id: query) {
            let q = query.trimmingCharacters(in: .whitespaces)
            guard q.count >= 2, q != current?.name else { results = []; return }
            try? await Task.sleep(nanoseconds: 300_000_000)
            if Task.isCancelled { return }
            searching = true
            results = await PlaceLookup.search(q)
            searching = false
        }
    }

    private func pick(_ r: PlaceLookup.Result) {
        let v = PlaceValue(name: r.name, address: r.address, lat: r.lat, lon: r.lon)
        model.store.setValue(rowID, property.id, .place(v.raw))
        done()
    }

    private func keepTyped() {
        let t = query.trimmingCharacters(in: .whitespacesAndNewlines)
        model.store.setValue(rowID, property.id, t.isEmpty ? nil : .place(PlaceValue(name: t).raw))
        done()
    }
}
