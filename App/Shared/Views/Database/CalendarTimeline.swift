import SwiftUI
import BasedCore

extension DBContext {
    /// The date property a calendar / timeline is laid out by.
    var dateProperty: PropertySchema? {
        if let id = view.datePropertyID, let p = db.property(id) { return p }
        return db.properties.first { $0.type == .date } ?? db.properties.first { $0.type == .createdTime || $0.type == .lastEditedTime }
    }

    /// Start / end of a row on the calendar or timeline.
    func span(_ row: Block) -> (Date, Date)? {
        guard let p = dateProperty, case .date(let d) = value(row, p) else { return nil }
        var end = d.end ?? d.start
        if let endID = view.endDatePropertyID, let ep = db.property(endID), case .date(let e) = value(row, ep) { end = e.end ?? e.start }
        return (d.start, max(end, d.start))
    }

    /// Move a row's date to `day`, keeping its duration.
    func reschedule(_ rowID: RecordID, to day: Date) {
        guard let p = dateProperty, p.type == .date, let row = store.blocks[rowID] else { return }
        let cal = Calendar.current
        var d: DateValue = { if case .date(let x)? = row.values[p.id] { return x }; return DateValue(start: day) }()
        let shift = cal.dateComponents([.day], from: cal.startOfDay(for: d.start), to: cal.startOfDay(for: day)).day ?? 0
        d.start = cal.date(byAdding: .day, value: shift, to: d.start) ?? day
        if let e = d.end { d.end = cal.date(byAdding: .day, value: shift, to: e) }
        store.setValue(rowID, p.id, .date(d))
    }
}

// MARK: - Calendar

struct CalendarLayout: View {
    let ctx: DBContext
    @State private var month = Calendar.current.date(from: Calendar.current.dateComponents([.year, .month], from: Date())) ?? Date()

    private let cal = Prefs.calendar

    var body: some View {
        if ctx.dateProperty == nil {
            Text("Add a date property to use the calendar layout.").foregroundStyle(Theme.secondary).padding(.vertical, 8)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(month.formatted(.dateTime.month(.wide).year())).font(.system(size: 15, weight: .semibold))
                    Spacer()
                    Button { shift(-1) } label: { Image(systemName: "chevron.left") }.buttonStyle(.plain)
                    Button("Today") { month = cal.date(from: cal.dateComponents([.year, .month], from: Date())) ?? Date() }.buttonStyle(.plain)
                    Button { shift(1) } label: { Image(systemName: "chevron.right") }.buttonStyle(.plain)
                }
                let symbols = weekdaySymbols
                HStack(spacing: 0) {
                    ForEach(symbols, id: \.self) { s in
                        Text(s).font(.caption).foregroundStyle(Theme.secondary).frame(maxWidth: .infinity)
                    }
                }
                let days = gridDays
                let byDay = rowsByDay()
                Grid(horizontalSpacing: 0, verticalSpacing: 0) {
                    ForEach(0..<(days.count / 7), id: \.self) { w in
                        GridRow {
                            ForEach(0..<7, id: \.self) { d in
                                let day = days[w * 7 + d]
                                CalendarDayCell(ctx: ctx, day: day, inMonth: cal.isDate(day, equalTo: month, toGranularity: .month),
                                                rows: byDay[cal.startOfDay(for: day)] ?? [])
                            }
                        }
                    }
                }
                .overlay(Rectangle().stroke(Color(Theme.divider)))
                let undated = ctx.result.rows.filter { ctx.span($0) == nil }
                if !undated.isEmpty {
                    DisclosureGroup("No date (\(undated.count))") {
                        ForEach(undated, id: \.id) { r in ListRow(ctx: ctx, row: r) }
                    }
                    .font(.system(size: 13))
                    .foregroundStyle(Theme.secondary)
                }
            }
        }
    }

    private func shift(_ n: Int) { month = cal.date(byAdding: .month, value: n, to: month) ?? month }

    private var weekdaySymbols: [String] {
        let s = cal.shortWeekdaySymbols
        let first = cal.firstWeekday - 1
        return Array(s[first...] + s[..<first])
    }

    private var gridDays: [Date] {
        let start = month
        let weekday = cal.component(.weekday, from: start)
        let lead = (weekday - cal.firstWeekday + 7) % 7
        let gridStart = cal.date(byAdding: .day, value: -lead, to: start) ?? start
        let daysInMonth = cal.range(of: .day, in: .month, for: start)?.count ?? 30
        let weeks = Int(ceil(Double(lead + daysInMonth) / 7.0))
        return (0..<(weeks * 7)).compactMap { cal.date(byAdding: .day, value: $0, to: gridStart) }
    }

    private func rowsByDay() -> [Date: [Block]] {
        var out: [Date: [Block]] = [:]
        for r in ctx.result.rows {
            guard let (s, e) = ctx.span(r) else { continue }
            var d = cal.startOfDay(for: s)
            let last = cal.startOfDay(for: e)
            var n = 0
            while d <= last && n < 62 {
                out[d, default: []].append(r)
                d = cal.date(byAdding: .day, value: 1, to: d) ?? last.addingTimeInterval(1)
                n += 1
            }
        }
        return out
    }
}

struct CalendarDayCell: View {
    let ctx: DBContext
    let day: Date
    let inMonth: Bool
    let rows: [Block]
    @State private var hover = false
    @State private var targeted = false

    var body: some View {
        let today = Calendar.current.isDateInToday(day)
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                if hover, !ctx.locked {
                    Button {
                        if let p = ctx.dateProperty, p.type == .date {
                            ctx.open(ctx.addRow(values: [p.id: .date(DateValue(start: Calendar.current.startOfDay(for: day)))]))
                        }
                    } label: { Image(systemName: "plus").font(.system(size: 10)) }
                    .buttonStyle(.plain)
                }
                Spacer()
                Text("\(Calendar.current.component(.day, from: day))")
                    .font(.system(size: 12, weight: today ? .bold : .regular))
                    .foregroundStyle(today ? Color.white : (inMonth ? Theme.primary : Theme.secondary))
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(today ? Color.red : Color.clear))
            }
            ForEach(rows.prefix(4), id: \.id) { r in
                Text(r.title.isEmpty ? "Untitled" : r.title)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                    .padding(.horizontal, 5).padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 4).fill(.background).shadow(color: .black.opacity(0.15), radius: 1))
                    .onTapGesture { ctx.open(r.id) }
                    .contextMenu { RowMenuItems(ctx: ctx, row: r) }
                    .onDrag {
                        ctx.model.draggedBlocks = [r.id]
                        return NSItemProvider(object: r.id as NSString)
                    }
            }
            if rows.count > 4 { Text("\(rows.count - 4) more").font(.caption2).foregroundStyle(Theme.secondary) }
            Spacer(minLength: 0)
        }
        .padding(4)
        .frame(maxWidth: .infinity, minHeight: 96, alignment: .topLeading)
        .background(inMonth ? Color.clear : Color.primary.opacity(0.03))
        .background(targeted ? Color.accentColor.opacity(0.1) : Color.clear)
        .overlay(Rectangle().stroke(Color(Theme.divider), lineWidth: 0.5))
        .onHover { hover = $0 }
        .onDrop(of: [.text], isTargeted: $targeted) { _ in
            let ids = ctx.model.draggedBlocks
            ctx.model.draggedBlocks = []
            for id in ids { ctx.reschedule(id, to: day) }
            return !ids.isEmpty
        }
    }
}

// MARK: - Timeline

struct TimelineLayout: View {
    let ctx: DBContext
    @State private var start = Calendar.current.date(byAdding: .day, value: -7, to: Calendar.current.startOfDay(for: Date())) ?? Date()
    @State private var scale: Scale = .day

    enum Scale: String, CaseIterable { case day = "Day", week = "Week", month = "Month" }

    private let cal = Calendar.current
    private var dayWidth: CGFloat { scale == .day ? 40 : scale == .week ? 16 : 6 }
    private var dayCount: Int { scale == .day ? 42 : scale == .week ? 120 : 365 }

    var body: some View {
        if ctx.dateProperty == nil {
            Text("Add a date property to use the timeline layout.").foregroundStyle(Theme.secondary).padding(.vertical, 8)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Picker("", selection: $scale) { ForEach(Scale.allCases, id: \.self) { Text($0.rawValue).tag($0) } }
                        .pickerStyle(.segmented).labelsHidden().frame(width: 200)
                    Spacer()
                    Button { move(-7) } label: { Image(systemName: "chevron.left") }.buttonStyle(.plain)
                    Button("Today") { start = cal.date(byAdding: .day, value: -7, to: cal.startOfDay(for: Date())) ?? Date() }.buttonStyle(.plain)
                    Button { move(7) } label: { Image(systemName: "chevron.right") }.buttonStyle(.plain)
                }
                let rows = ctx.result.rows
                HStack(alignment: .top, spacing: 0) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("").frame(height: 28)
                        ForEach(rows, id: \.id) { r in
                            Text(r.title.isEmpty ? "Untitled" : r.title).font(.system(size: 13)).lineLimit(1)
                                .frame(width: 180, height: 30, alignment: .leading)
                                .contentShape(Rectangle())
                                .onTapGesture { ctx.open(r.id) }
                        }
                    }
                    .padding(.trailing, 6)
                    ScrollView(.horizontal, showsIndicators: true) {
                        VStack(alignment: .leading, spacing: 0) {
                            axis
                            ForEach(rows, id: \.id) { r in bar(r) }
                        }
                        .frame(width: CGFloat(dayCount) * dayWidth, alignment: .leading)
                        .background(alignment: .topLeading) { todayLine }
                    }
                }
                if !ctx.locked {
                    Button {
                        if let p = ctx.dateProperty, p.type == .date {
                            ctx.open(ctx.addRow(values: [p.id: .date(DateValue(start: cal.startOfDay(for: Date())))]))
                        }
                    } label: { Label("New page", systemImage: "plus").foregroundStyle(Theme.secondary) }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private func move(_ days: Int) {
        let step = scale == .day ? days : scale == .week ? days * 4 : days * 12
        start = cal.date(byAdding: .day, value: step, to: start) ?? start
    }

    private var axis: some View {
        HStack(spacing: 0) {
            ForEach(0..<dayCount, id: \.self) { i in
                let d = cal.date(byAdding: .day, value: i, to: start) ?? start
                let dayNum = cal.component(.day, from: d)
                Text(label(d, dayNum))
                    .font(.system(size: 10))
                    .foregroundStyle(Theme.secondary)
                    .frame(width: dayWidth, height: 28, alignment: .leading)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(width: dayWidth, alignment: .leading)
            }
        }
    }

    private func label(_ d: Date, _ dayNum: Int) -> String {
        switch scale {
        case .day: return dayNum == 1 ? d.formatted(.dateTime.month(.abbreviated).day()) : "\(dayNum)"
        case .week: return cal.component(.weekday, from: d) == cal.firstWeekday ? "\(dayNum)" : (dayNum == 1 ? d.formatted(.dateTime.month(.abbreviated)) : "")
        case .month: return dayNum == 1 ? d.formatted(.dateTime.month(.abbreviated)) : ""
        }
    }

    private var todayLine: some View {
        let offset = CGFloat(cal.dateComponents([.day], from: start, to: cal.startOfDay(for: Date())).day ?? 0) * dayWidth
        return Rectangle().fill(Color.red.opacity(0.6)).frame(width: 1).offset(x: offset + dayWidth / 2)
    }

    @ViewBuilder
    private func bar(_ r: Block) -> some View {
        if let (s, e) = ctx.span(r) {
            let from = cal.dateComponents([.day], from: start, to: cal.startOfDay(for: s)).day ?? 0
            let len = max(1, (cal.dateComponents([.day], from: cal.startOfDay(for: s), to: cal.startOfDay(for: e)).day ?? 0) + 1)
            Text(r.title.isEmpty ? "Untitled" : r.title)
                .font(.system(size: 12, weight: .medium))
                .lineLimit(1)
                .padding(.horizontal, 6)
                .frame(width: max(dayWidth, CGFloat(len) * dayWidth - 2), height: 24, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 5).fill(.background).shadow(color: .black.opacity(0.18), radius: 1.5))
                .offset(x: CGFloat(from) * dayWidth)
                .frame(height: 30, alignment: .leading)
                .onTapGesture { ctx.open(r.id) }
                .contextMenu { RowMenuItems(ctx: ctx, row: r) }
                .gesture(DragGesture(minimumDistance: 6).onEnded { g in
                    let days = Int((g.translation.width / dayWidth).rounded())
                    if days != 0, let target = cal.date(byAdding: .day, value: days, to: s) { ctx.reschedule(r.id, to: target) }
                })
        } else {
            Color.clear.frame(height: 30)
        }
    }
}