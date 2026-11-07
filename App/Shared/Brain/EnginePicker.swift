import SwiftUI
import BasedCore
import BasedBrain

/// Model picker under the composer, modelled on the Claude / Claude Code apps: a quiet button ("Opus 5.5 · High ⌄")
/// that opens a popover — engine tabs (Claude Code, Codex, Gemini, OpenCode, API), the models with a one-line
/// description and a check mark, and the effort level. Changes apply to the next message.
struct EnginePickerButton: View {
    @Environment(BrainModel.self) private var brain
    @State private var open = false
    @State private var hover = false

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 4) {
                Text(label)
                    .font(.system(size: 12.5, weight: .medium))
                    .lineLimit(1)
                    .fixedSize()
                Image(systemName: "chevron.down")
                    .font(.system(size: 8.5, weight: .bold))
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .foregroundStyle(hover || open ? Theme.primary : Theme.secondary)
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover || open ? Theme.hoverFill : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.15), value: hover)
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: open)
        .help("Model and effort")
        .accessibilityIdentifier("ai.engine")
        .popover(isPresented: $open, arrowEdge: .bottom) {
            EnginePickerPanel { open = false }
                .environment(brain)
        }
    }

    private var label: String {
        switch brain.engineSpec.kind {
        case .auto:
            return "Auto"
        default:
            return CLICatalog.label(brain.engineSpec)
        }
    }
}

struct EnginePickerPanel: View {
    let done: () -> Void
    @Environment(BrainModel.self) private var brain
    @State private var tab: ChatEngineSpec.Kind = .auto

    private var tabs: [ChatEngineSpec.Kind] {
        var t: [ChatEngineSpec.Kind] = [.auto]
        for k in [ChatEngineSpec.Kind.claudeCode, .codex, .gemini, .opencode] where brain.installedCLIs.contains(k) { t.append(k) }
        if !brain.apiModelGroups.isEmpty { t.append(.api) }
        return t
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Engine tabs
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(tabs, id: \.self) { k in
                        EngineTab(title: k.title, selected: tab == k, current: brain.engineSpec.kind == k) {
                            withAnimation(.spring(response: 0.28, dampingFraction: 0.85)) { tab = k }
                        }
                    }
                }
                .padding(6)
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    content
                }
                .padding(6)
                .id(tab)
                .transition(.opacity.combined(with: .offset(y: 4)))
            }
            .frame(maxHeight: 360)
            if !CLICatalog.efforts(for: tab).isEmpty {
                Divider()
                EffortRow(kind: tab)
                    .padding(10)
            }
        }
        .frame(width: 320)
        .onAppear { tab = brain.engineSpec.kind == .auto ? .auto : brain.engineSpec.kind }
    }

    @ViewBuilder
    private var content: some View {
        switch tab {
        case .auto:
            ModelRow(title: "Auto", detail: "Best available: API key → Claude Code → Codex → on device. Currently: \(brain.chatEngine)",
                     selected: brain.engineSpec.kind == .auto) {
                brain.engineSpec = .auto; done()
            }
        case .api:
            ForEach(brain.apiModelGroups, id: \.provider) { g in
                SectionLabel(g.provider)
                ForEach(g.models, id: \.self) { ref in
                    ModelRow(title: g.onDevice ? "Apple Intelligence" : String(ref.split(separator: "/").last ?? ""),
                             detail: g.onDevice ? "On device · private · no tools" : ref,
                             selected: brain.engineSpec.kind == .api && brain.engineSpec.model == ref) {
                        brain.engineSpec = ChatEngineSpec(kind: .api, model: ref); done()
                    }
                }
            }
        default:
            SectionLabel(subtitle(tab))
            ForEach(CLICatalog.models(for: tab)) { m in
                ModelRow(title: m.label, detail: m.detail,
                         selected: brain.engineSpec.kind == tab && brain.engineSpec.model == m.id) {
                    var s = brain.engineSpec.kind == tab ? brain.engineSpec : ChatEngineSpec(kind: tab)
                    s.model = m.id
                    brain.engineSpec = s
                    done()
                }
            }
        }
    }

    private func subtitle(_ k: ChatEngineSpec.Kind) -> String {
        switch k {
        case .claudeCode: return "Claude Code · your Claude subscription"
        case .codex: return "Codex CLI · your ChatGPT subscription"
        case .gemini: return "Gemini CLI"
        case .opencode: return "OpenCode"
        default: return ""
        }
    }
}

private struct EngineTab: View {
    let title: String
    let selected: Bool
    let current: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if current { Circle().fill(Color.accentColor).frame(width: 5, height: 5) }
                Text(title).font(.system(size: 12, weight: selected ? .semibold : .regular))
            }
            .padding(.horizontal, 9).padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Theme.hoverFill : (hover ? Theme.hoverFill.opacity(0.6) : .clear)))
            .foregroundStyle(selected ? Theme.primary : Theme.secondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
    }
}

struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(Theme.secondary)
            .padding(.horizontal, 8).padding(.top, 6).padding(.bottom, 3)
    }
}

/// A model row: name, one-line description, check mark — highlighted on hover like a native menu row.
struct ModelRow: View {
    let title: String
    let detail: String
    let selected: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.primary)
                    if !detail.isEmpty {
                        Text(detail).font(.system(size: 11.5)).foregroundStyle(Theme.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "checkmark")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(selected ? 1 : 0)
                    .scaleEffect(selected ? 1 : 0.6)
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.hoverFill : .clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.12), value: hover)
    }
}

/// Effort / reasoning level as a segmented control with a sliding highlight.
struct EffortRow: View {
    let kind: ChatEngineSpec.Kind
    @Environment(BrainModel.self) private var brain
    @Namespace private var ns

    var body: some View {
        let levels = CLICatalog.efforts(for: kind)
        let current = brain.engineSpec.kind == kind ? brain.engineSpec.effort : ""
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(kind == .codex ? "Reasoning" : "Effort").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.secondary)
                Spacer()
                Text(levels.first { $0.id == current }?.detail ?? "").font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
            HStack(spacing: 0) {
                ForEach(levels) { l in
                    Button {
                        withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) {
                            var s = brain.engineSpec.kind == kind ? brain.engineSpec : ChatEngineSpec(kind: kind)
                            s.effort = l.id
                            brain.engineSpec = s
                        }
                    } label: {
                        Text(l.id.isEmpty ? "Auto" : l.label.replacingOccurrences(of: "Extra high", with: "X-High"))
                            .font(.system(size: 11, weight: current == l.id ? .semibold : .regular))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 4)
                            .background {
                                if current == l.id {
                                    RoundedRectangle(cornerRadius: 5).fill(.background)
                                        .shadow(color: .black.opacity(0.12), radius: 1, y: 0.5)
                                        .matchedGeometryEffect(id: "effort", in: ns)
                                }
                            }
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(current == l.id ? Theme.primary : Theme.secondary)
                }
            }
            .padding(2)
            .background(RoundedRectangle(cornerRadius: 7).fill(Theme.hoverFill))
        }
    }
}

/// Permission mode chip ("Ask permissions ⌄") next to the model picker — only for coding-agent CLIs.
struct PermissionModeButton: View {
    var iconOnly = false
    @Environment(BrainModel.self) private var brain
    @State private var hover = false

    var body: some View {
        let kind = brain.engineSpec.kind
        let modes = CLICatalog.permissions(for: kind)
        if !modes.isEmpty {
            let current = modes.first { $0.id == brain.engineSpec.permission } ?? modes[0]
            Menu {
                ForEach(modes) { m in
                    Button {
                        brain.engineSpec.permission = m.id
                    } label: {
                        Label("\(m.label) — \(m.detail)", systemImage: m.id == current.id ? "checkmark" : m.symbol)
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: current.symbol).font(.system(size: 10.5))
                    if !iconOnly { Text(current.label).font(.system(size: 12)).lineLimit(1) }
                }
                .help(current.label)
                .foregroundStyle(isRisky(current.id) ? Color.orange : (hover ? Theme.primary : Theme.secondary))
                .padding(.horizontal, 7).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.hoverFill : .clear))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .onHover { hover = $0 }
            .help("Permission mode")
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    private func isRisky(_ id: String) -> Bool { ["bypassPermissions", "danger-full-access", "yolo"].contains(id) }
}
