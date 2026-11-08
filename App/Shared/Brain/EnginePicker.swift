import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#endif

/// Model picker under the composer, modelled on the Claude / Claude Code apps: a quiet button ("Opus 5.5 · High ⌄")
/// that opens a popover — engine tabs (Claude Code, Codex, Gemini, OpenCode, API), the models with a one-line
/// description and a check mark, and the effort level. Changes apply to the next message.
struct EnginePickerButton: View {
    /// Opens the picker from outside (the /model command).
    var openRequest: Binding<Bool>? = nil
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
        .panelPopover(isPresented: $open, arrowEdge: .bottom) {
            EnginePickerPanel { open = false }
                .environment(brain)
        }
        .onChange(of: openRequest?.wrappedValue ?? false) { _, v in
            if v { open = true; openRequest?.wrappedValue = false }
        }
        #if DEBUG
        .onReceive(NotificationCenter.default.publisher(for: .debugOpenEnginePicker)) { _ in open = true }
        #endif
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

/// One scrolling list like the Claude app's model menu: Auto, then every installed engine as a section with its
/// models (name, one-line description, check mark), and the effort for the current engine pinned at the bottom.
struct EnginePickerPanel: View {
    let done: () -> Void
    @Environment(BrainModel.self) private var brain

    private var engines: [ChatEngineSpec.Kind] {
        [ChatEngineSpec.Kind.claudeCode, .codex, .gemini, .opencode].filter { brain.installedCLIs.contains($0) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ModelRow(title: "Auto", detail: "Picks the best available · now \(brain.chatEngine)",
                                 symbol: "sparkles", selected: brain.engineSpec.kind == .auto) {
                            brain.engineSpec = .auto; done()
                        }
                        .id("auto")
                        ForEach(engines, id: \.self) { k in
                            SectionLabel(k.title, detail: subtitle(k))
                            ForEach(CLICatalog.models(for: k)) { m in
                                let selected = brain.engineSpec.kind == k && brain.engineSpec.model == m.id
                                ModelRow(title: m.label, detail: m.detail, selected: selected) {
                                    var spec = brain.engineSpec.kind == k ? brain.engineSpec : ChatEngineSpec(kind: k)
                                    spec.model = m.id
                                    brain.engineSpec = spec
                                    done()
                                }
                                .id("\(k.rawValue):\(m.id)")
                            }
                        }
                        ForEach(brain.apiModelGroups, id: \.provider) { g in
                            SectionLabel(g.provider, detail: g.onDevice ? "On this Mac" : "API key")
                            ForEach(g.models, id: \.self) { ref in
                                ModelRow(title: g.onDevice ? "Apple Intelligence" : String(ref.split(separator: "/").last ?? ""),
                                         detail: g.onDevice ? "Private · no tools" : "",
                                         selected: brain.engineSpec.kind == .api && brain.engineSpec.model == ref) {
                                    brain.engineSpec = ChatEngineSpec(kind: .api, model: ref); done()
                                }
                                .id("api:\(ref)")
                            }
                        }
                    }
                    .padding(6)
                }
                .frame(height: listHeight)
                .onAppear {
                    let spec = brain.engineSpec
                    let id = spec.kind == .auto ? "auto" : spec.kind == .api ? "api:\(spec.model ?? "")" : "\(spec.kind.rawValue):\(spec.model ?? "")"
                    proxy.scrollTo(id, anchor: .center)
                }
            }
            if brain.engineSpec.kind != .auto, !CLICatalog.efforts(for: brain.engineSpec.kind).isEmpty {
                Rectangle().fill(Theme.gridLine).frame(height: 1)
                EffortRow(kind: brain.engineSpec.kind)
                    .padding(.horizontal, 12).padding(.vertical, 10)
            }
        }
        .frame(width: 300)
        .arrowlessPopover()
    }

    /// Rows are ~34 pt (title + one-line detail), section labels ~30 pt; capped so the list scrolls.
    private var listHeight: CGFloat {
        let rows = 1 + engines.reduce(0) { $0 + CLICatalog.models(for: $1).count } + brain.apiModelGroups.reduce(0) { $0 + $1.models.count }
        let labels = engines.count + brain.apiModelGroups.count
        return min(440, CGFloat(rows) * 36 + CGFloat(labels) * 30 + 12)
    }

    private func subtitle(_ k: ChatEngineSpec.Kind) -> String {
        switch k {
        case .claudeCode: return "Claude subscription"
        case .codex: return "ChatGPT subscription"
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
                if current { Circle().fill(Theme.accentBlue).frame(width: 5, height: 5) }
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
    var detail = ""
    init(_ text: String, detail: String = "") { self.text = text; self.detail = detail }
    var body: some View {
        HStack(spacing: 6) {
            Text(text).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondary)
            if !detail.isEmpty { Text(detail).font(.system(size: 11)).foregroundStyle(Theme.secondary.opacity(0.7)) }
        }
        .padding(.horizontal, 8).padding(.top, 10).padding(.bottom, 3)
    }
}

/// A model row: name, one-line description, check mark — highlighted on hover like a native menu row.
struct ModelRow: View {
    let title: String
    let detail: String
    var symbol: String? = nil
    let selected: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 8) {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Theme.secondary).frame(width: 16)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13, weight: selected ? .semibold : .regular)).foregroundStyle(Theme.primary)
                    if !detail.isEmpty {
                        Text(detail).font(.system(size: 11)).foregroundStyle(Theme.secondary).lineLimit(1).truncationMode(.tail)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.accentBlue)
                    .opacity(selected ? 1 : 0)
            }
            .padding(.horizontal, 8).padding(.vertical, 5)
            .frame(minHeight: 32)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(hover ? Theme.hoverFill : (selected ? Theme.hoverFill.opacity(0.5) : .clear)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .clickableCursor()
        .help(detail)
        .onHover { hover = $0 }
        .animation(.easeOut(duration: 0.1), value: hover)
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
                    .buttonStyle(.hoverFill)
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

/// Working folder for coding-agent CLIs ("📁 Based ⌄"): recent folders and "Choose folder…", like the Claude
/// Code app's project picker. Only shown for CLI engines.
struct FolderChip: View {
    @Environment(BrainModel.self) private var brain
    @State private var hover = false

    var body: some View {
        if [.claudeCode, .codex, .gemini, .opencode].contains(brain.engineSpec.kind) {
            Menu {
                Section("Recent") {
                    ForEach(brain.recentFolders.filter { $0 != brain.chatFolder }, id: \.self) { f in
                        Button(Self.short(f)) { brain.chatFolder = f }
                    }
                }
                Button("Home folder") { brain.chatFolder = NSHomeDirectory() }
                Divider()
                Button("Choose folder…") { Self.choose(brain) }
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: "folder").font(.system(size: 11))
                    Text(brain.chatFolder == NSHomeDirectory() ? "Home" : URL(fileURLWithPath: brain.chatFolder).lastPathComponent)
                        .font(.system(size: 12)).lineLimit(1)
                }
                .foregroundStyle(hover ? Theme.primary : Theme.secondary)
                .padding(.horizontal, 7).padding(.vertical, 4)
                .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Theme.hoverFill : .clear))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .onHover { hover = $0 }
            .help("Working folder: " + Self.short(brain.chatFolder))
            .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    static func short(_ path: String) -> String {
        let home = NSHomeDirectory()
        return path.hasPrefix(home) ? "~" + path.dropFirst(home.count) : path
    }

    static func choose(_ brain: BrainModel) {
        #if os(macOS)
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: brain.chatFolder)
        panel.prompt = "Use folder"
        if panel.runModal() == .OK, let url = panel.url { brain.chatFolder = url.path }
        #endif
    }
}

#if DEBUG
extension Notification.Name { static let debugOpenEnginePicker = Notification.Name("based.debug.enginePicker") }
#endif
