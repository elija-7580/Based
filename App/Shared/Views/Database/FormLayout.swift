import SwiftUI
import BasedCore

/// Notion-style form view: every visible property becomes a question; "Submit" adds a row to the database.
/// Computed properties (formula, rollup, created / edited, unique ID) and people / files / relations are skipped.
struct FormLayout: View {
    let ctx: DBContext
    @State private var title = ""
    @State private var texts: [String: String] = [:]
    @State private var choices: [String: Set<String>] = [:]
    @State private var flags: [String: Bool] = [:]
    @State private var dates: [String: Date] = [:]
    @State private var submitted = 0
    @State private var missing: Set<String> = []

    private static let supported: Set<PropertyType> = [.title, .text, .number, .select, .multiSelect, .status, .date, .checkbox, .url, .email, .phone, .place]

    private var questions: [PropertySchema] {
        ctx.visibleProperties.filter { Self.supported.contains($0.type) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ctx.view.name).font(.system(size: 26, weight: .bold))
                if let s = ctx.db.summary?.plainText, !s.isEmpty { Text(s).foregroundStyle(Theme.secondary) }
            }
            ForEach(questions, id: \.id) { p in question(p) }
            HStack(spacing: 12) {
                Button("Submit") { submit() }
                    .buttonStyle(.borderedProminent)
                    .disabled(ctx.locked)
                    .keyboardShortcut(.return, modifiers: .command)
                    .accessibilityIdentifier("form.submit")
                if submitted > 0 {
                    Label(submitted == 1 ? "Response submitted" : "\(submitted) responses submitted", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green).font(.callout)
                }
                Spacer()
                Text("\(ctx.result.rows.count) responses").font(.caption).foregroundStyle(Theme.secondary)
            }
        }
        .padding(.vertical, DS.Space.xl)
        .frame(maxWidth: 640, alignment: .leading)
        .accessibilityIdentifier("form")
    }

    @ViewBuilder
    private func question(_ p: PropertySchema) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: p.type.symbol).font(DS.Text.small()).foregroundStyle(Theme.secondary)
                Text(p.name).font(.system(size: 15, weight: .semibold))
                if p.type == .title { Text("*").foregroundStyle(.red) }
            }
            input(p)
            if missing.contains(p.id) { Text("Required").font(.caption).foregroundStyle(.red) }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10).stroke(Color(Theme.divider)))
    }

    @ViewBuilder
    private func input(_ p: PropertySchema) -> some View {
        switch p.type {
        case .title:
            TextField("Your answer", text: $title).textFieldStyle(.roundedBorder)
        case .select, .status:
            let opts = p.options ?? []
            Picker("", selection: Binding(get: { choices[p.id]?.first ?? "" }, set: { choices[p.id] = $0.isEmpty ? [] : [$0] })) {
                Text("—").tag("")
                ForEach(opts, id: \.id) { o in Text(o.name).tag(o.id) }
            }
            .labelsHidden()
            .frame(maxWidth: 280, alignment: .leading)
        case .multiSelect:
            let opts = p.options ?? []
            VStack(alignment: .leading, spacing: 4) {
                ForEach(opts, id: \.id) { o in
                    Toggle(isOn: Binding(get: { choices[p.id]?.contains(o.id) == true }, set: { on in
                        var s = choices[p.id] ?? []
                        if on { s.insert(o.id) } else { s.remove(o.id) }
                        choices[p.id] = s
                    })) { OptionPill(name: o.name, color: o.color) }
                }
            }
        case .checkbox:
            Toggle("Yes", isOn: Binding(get: { flags[p.id] ?? false }, set: { flags[p.id] = $0 }))
        case .date:
            DatePicker("", selection: Binding(get: { dates[p.id] ?? Date() }, set: { dates[p.id] = $0 }), displayedComponents: [.date])
                .labelsHidden()
                .frame(maxWidth: 200, alignment: .leading)
        default:
            TextField(placeholder(p), text: Binding(get: { texts[p.id] ?? "" }, set: { texts[p.id] = $0 }))
                .textFieldStyle(.roundedBorder)
        }
    }

    private func placeholder(_ p: PropertySchema) -> String {
        switch p.type {
        case .number: return "Number"
        case .url: return "https://"
        case .email: return "name@example.com"
        case .phone: return "Phone number"
        default: return "Your answer"
        }
    }

    private func submit() {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { missing = [ctx.db.titleProperty.id]; return }
        missing = []
        var values: [String: PropertyValue] = [:]
        for p in questions {
            switch p.type {
            case .title: break
            case .text: if let s = texts[p.id], !s.isEmpty { values[p.id] = .text(RichText(s)) }
            case .number: if let s = texts[p.id], let n = Double(s.replacingOccurrences(of: ",", with: ".")) { values[p.id] = .number(n) }
            case .url: if let s = texts[p.id], !s.isEmpty { values[p.id] = .url(s) }
            case .email: if let s = texts[p.id], !s.isEmpty { values[p.id] = .email(s) }
            case .phone: if let s = texts[p.id], !s.isEmpty { values[p.id] = .phone(s) }
            case .place: if let s = texts[p.id], !s.isEmpty { values[p.id] = .place(s) }
            case .select: if let id = choices[p.id]?.first { values[p.id] = .select(id) }
            case .status: if let id = choices[p.id]?.first { values[p.id] = .status(id) }
            case .multiSelect: if let ids = choices[p.id], !ids.isEmpty { values[p.id] = .multiSelect((p.options ?? []).map(\.id).filter(ids.contains)) }
            case .checkbox: if let b = flags[p.id] { values[p.id] = .checkbox(b) }
            case .date: if let d = dates[p.id] { values[p.id] = .date(DateValue(start: d)) }
            default: break
            }
        }
        ctx.addRow(values: values, title: RichText(t))
        submitted += 1
        title = ""; texts = [:]; choices = [:]; flags = [:]; dates = [:]
    }
}
