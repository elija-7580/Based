import SwiftUI
import Charts
import BasedCore

/// Notion‑style "Chart" layout: bar / line / area / pie / donut over the filtered rows of the view.
/// Aggregation runs in BasedCore (`ChartData`), rendering in Swift Charts.
struct ChartLayout: View {
    let ctx: DBContext
    /// Inside a dashboard widget: no axis caption row, height from the widget.
    var compact = false
    @State private var hovered: String?

    private var config: ChartConfig { ctx.view.chart ?? ChartConfig(xPropertyID: defaultX?.id) }
    private var defaultX: PropertySchema? {
        ctx.db.properties.first { [.select, .status, .multiSelect, .checkbox, .date].contains($0.type) }
    }
    private var points: [ChartPoint] {
        ChartData(engine: ctx.engine).points(rows: ctx.result.rows, db: ctx.db, config: config)
    }
    private var yTitle: String {
        guard let y = config.yPropertyID, let p = ctx.db.property(y) else { return "Count" }
        return "\(config.aggregate.displayName) of \(p.name)"
    }
    private var xTitle: String { config.xPropertyID.flatMap { ctx.db.property($0)?.name } ?? "All" }

    var body: some View {
        if config.kind == .number {
            numberView
        } else {
            chartBody
        }
    }

    /// Notion "Number" chart: one big aggregate value.
    private var numberView: some View {
        let value = ChartData(engine: ctx.engine).number(rows: ctx.result.rows, db: ctx.db, config: config)
        return VStack(alignment: compact ? .leading : .center, spacing: 4) {
            Text(format(value))
                .font(.system(size: compact ? 40 : 56, weight: .semibold))
                .foregroundStyle(themeColor ?? Theme.primary)
                .monospacedDigit()
                .accessibilityIdentifier("chart.number")
            Text(yTitle).font(.callout).foregroundStyle(Theme.secondary)
            if let c = config.caption { Text(c).font(.caption).foregroundStyle(Theme.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: compact ? .leading : .center)
        .padding(.vertical, compact ? 10 : 30)
    }

    /// Single colour for bars / lines when the view has a Notion colour theme ("auto" / "colorful" keep per-category colours).
    private var lineColor: Color { themeColor ?? Theme.accentBlue }

    private var themeColor: Color? {
        switch config.colorTheme {
        case nil, "auto"?, "colorful"?: return nil
        case "teal"?: return Color(Theme.dynamic(light: 0x2A9D8F, dark: 0x4FB3A7))
        case let name?: return TColor(rawValue: name).map { Theme.color($0) }
        }
    }

    private var chartBody: some View {
        let pts = points
        return VStack(alignment: .leading, spacing: 8) {
            if pts.isEmpty {
                ContentUnavailableView("Nothing to chart", systemImage: "chart.bar", description: Text("Add rows, or pick an x‑axis property in the view settings."))
                    .frame(height: 220)
            } else {
                chart(pts)
                    .frame(height: compact ? min(CGFloat(config.heightPoints), 300) : CGFloat(config.heightPoints))
                    .padding(.horizontal, 8)
                    .accessibilityIdentifier("chart.canvas")
                if let c = config.caption {
                    Text(c).font(.caption).foregroundStyle(Theme.secondary).padding(.horizontal, 8)
                }
                if !compact { HStack {
                    Text("\(xTitle) · \(yTitle)").font(.caption).foregroundStyle(Theme.secondary)
                    Spacer()
                    if let h = hovered, let p = pts.first(where: { $0.key == h }) {
                        Text("\(p.label): \(format(p.value))").font(.caption.monospacedDigit())
                    }
                }
                .padding(.horizontal, 8) }
            }
        }
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func chart(_ pts: [ChartPoint]) -> some View {
        switch config.kind {
        case .bar:
            Chart(pts) { p in
                BarMark(x: .value(xTitle, p.label), y: .value(yTitle, p.value))
                    .foregroundStyle(color(p))
                    .annotation(position: .top) { if config.showValues { Text(format(p.value)).font(.caption2).foregroundStyle(Theme.secondary) } }
                    .opacity(hovered == nil || hovered == p.key ? 1 : 0.5)
            }
            .chartXScale(domain: pts.map(\.label))
            .chartLegend(.hidden)
            .chartOverlay { proxy in hoverOverlay(proxy, pts, horizontal: false) }
        case .horizontalBar:
            Chart(pts) { p in
                BarMark(x: .value(yTitle, p.value), y: .value(xTitle, p.label))
                    .foregroundStyle(color(p))
                    .annotation(position: .trailing) { if config.showValues { Text(format(p.value)).font(.caption2).foregroundStyle(Theme.secondary) } }
                    .opacity(hovered == nil || hovered == p.key ? 1 : 0.5)
            }
            .chartYScale(domain: pts.map(\.label))
            .chartLegend(.hidden)
            .chartOverlay { proxy in hoverOverlay(proxy, pts, horizontal: true) }
        case .line, .area:
            Chart(pts) { p in
                if config.kind == .area {
                    AreaMark(x: .value(xTitle, p.label), y: .value(yTitle, p.value))
                        .foregroundStyle(LinearGradient(colors: [lineColor.opacity(0.35), lineColor.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                        .interpolationMethod(.catmullRom)
                }
                LineMark(x: .value(xTitle, p.label), y: .value(yTitle, p.value))
                    .foregroundStyle(lineColor)
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: 2))
                PointMark(x: .value(xTitle, p.label), y: .value(yTitle, p.value))
                    .foregroundStyle(lineColor)
                    .symbolSize(hovered == p.key ? 90 : 30)
                    .annotation(position: .top) { if config.showValues { Text(format(p.value)).font(.caption2).foregroundStyle(Theme.secondary) } }
            }
            .chartXScale(domain: pts.map(\.label))
            .chartOverlay { proxy in hoverOverlay(proxy, pts, horizontal: false) }
        case .number:
            EmptyView()
        case .pie, .donut:
            HStack(alignment: .center, spacing: 16) {
                Chart(pts) { p in
                    SectorMark(angle: .value(yTitle, p.value), innerRadius: .ratio(config.kind == .donut ? 0.6 : 0), angularInset: 1.5)
                        .foregroundStyle(color(p))
                        .cornerRadius(3)
                        .opacity(hovered == nil || hovered == p.key ? 1 : 0.5)
                }
                .chartLegend(.hidden)
                .chartBackground { _ in
                    if config.kind == .donut {
                        VStack { Text(format(pts.reduce(0) { $0 + $1.value })).font(.title2.bold()); Text(yTitle).font(.caption).foregroundStyle(Theme.secondary) }
                    }
                }
                if config.showLegend {
                    let total = max(pts.reduce(0) { $0 + $1.value }, 0.000001)
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(pts) { p in
                            HStack(spacing: 6) {
                                Circle().fill(color(p)).frame(width: 9, height: 9)
                                Text(p.label).lineLimit(1)
                                Spacer(minLength: 8)
                                Text(config.showValues ? format(p.value) : "").foregroundStyle(Theme.secondary)
                                Text("\(Int((p.value / total * 100).rounded()))%").foregroundStyle(.tertiary).monospacedDigit()
                            }
                            .font(.caption)
                            .contentShape(Rectangle())
                            .onHover { hovered = $0 ? p.key : nil }
                        }
                    }
                    .frame(maxWidth: 220)
                }
            }
        }
    }

    /// Hover / tap → highlight the nearest category.
    private func hoverOverlay(_ proxy: ChartProxy, _ pts: [ChartPoint], horizontal: Bool) -> some View {
        GeometryReader { geo in
            Rectangle().fill(.clear).contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let loc):
                        let origin = geo[proxy.plotFrame!].origin
                        let pos = CGPoint(x: loc.x - origin.x, y: loc.y - origin.y)
                        let label: String? = horizontal ? proxy.value(atY: pos.y, as: String.self) : proxy.value(atX: pos.x, as: String.self)
                        hovered = pts.first { $0.label == label }?.key
                    case .ended: hovered = nil
                    }
                }
        }
    }

    private func color(_ p: ChartPoint) -> Color {
        if let t = themeColor { return t }
        if let c = p.color, c != .default { return Theme.color(c) }
        let stable = p.key.unicodeScalars.reduce(0) { ($0 &* 31 &+ Int($1.value)) & 0x7fffffff }
        return Theme.chartPalette[stable % Theme.chartPalette.count]
    }

    private func format(_ v: Double) -> String {
        if let y = config.yPropertyID, let p = ctx.db.property(y), let f = p.numberFormat { return CellFormatter.number(v, f) }
        return v == v.rounded() ? String(Int(v)) : String(format: "%.2f", v)
    }
}

extension Theme {
    /// Palette for categories without an option colour (Notion‑like soft tones).
    static let chartPalette: [Color] = [
        Color(red: 0.35, green: 0.56, blue: 0.95), Color(red: 0.98, green: 0.62, blue: 0.27), Color(red: 0.36, green: 0.73, blue: 0.47),
        Color(red: 0.86, green: 0.38, blue: 0.47), Color(red: 0.60, green: 0.47, blue: 0.86), Color(red: 0.95, green: 0.78, blue: 0.27),
        Color(red: 0.37, green: 0.72, blue: 0.78), Color(red: 0.62, green: 0.53, blue: 0.45),
    ]
}
