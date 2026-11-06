import SwiftUI
import BasedCore
import BasedBrain

/// "Agent Brain" — one place for what the AI and coding agents know: About you, Memories, Skills,
/// scheduled agents and MCP connections. Each tab is the underlying (editable) page / database.
struct BrainDashboard: View {
    enum Tab: String, CaseIterable, Identifiable {
        case about = "About you", memories = "Memories", skills = "Skills", agents = "Scheduled agents", connections = "Connections"
        var id: String { rawValue }
        var symbol: String {
            switch self {
            case .about: return "person.text.rectangle"
            case .memories: return "brain"
            case .skills: return "wand.and.stars"
            case .agents: return "clock.arrow.circlepath"
            case .connections: return "point.3.connected.trianglepath.dotted"
            }
        }
    }

    @Environment(AppModel.self) private var model
    @Environment(BrainModel.self) private var brainModel
    @AppStorage("brain.tab") private var tabRaw = Tab.about.rawValue

    private var tab: Tab { Tab(rawValue: tabRaw) ?? .about }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 14) {
                Image(systemName: "brain").font(.system(size: 26)).foregroundStyle(Color.accentColor)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Agent Brain").font(.system(size: 24, weight: .bold))
                    Text("What your AI chat and coding agents know about you. Everything here is a normal page you can edit.")
                        .font(.callout).foregroundStyle(Theme.secondary).lineLimit(2)
                }
                Spacer()
                if let page = pageID(for: tab) {
                    Button { model.openRoot(page) } label: { Label("Open as page", systemImage: "arrow.up.right.square") }
                        .controlSize(.small)
                }
            }
            .padding(.horizontal, 28).padding(.top, 20).padding(.bottom, 12)
            HStack(spacing: 4) {
                ForEach(Tab.allCases) { t in
                    Button { tabRaw = t.rawValue } label: {
                        Label(t.rawValue, systemImage: t.symbol)
                            .font(.system(size: 13, weight: t == tab ? .semibold : .regular))
                            .padding(.horizontal, 10).padding(.vertical, 6)
                            .foregroundStyle(t == tab ? Theme.primary : Theme.secondary)
                            .background(RoundedRectangle(cornerRadius: 6).fill(t == tab ? Color.primary.opacity(0.07) : .clear))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("brain.tab.\(t)")
                }
                Spacer()
            }
            .padding(.horizontal, 24).padding(.bottom, 8)
            Divider()
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .id(tab)
        }
        .accessibilityIdentifier("brain.dashboard")
        // Brings back anything of the brain that ended up in the Trash (older builds, other devices).
        .onAppear { if brainModel.brain.repair() { model.showToast("Agent Brain restored") } }
    }

    @ViewBuilder
    private var content: some View {
        if tab == .connections {
            Form { ConnectionsSettingsView() }.formStyle(.grouped)
        } else if let id = pageID(for: tab), model.store.blocks[id] != nil, !model.store.isTrashed(id) {
            PageScreen(pageID: id, model: model, isPeek: true)
        } else {
            ContentUnavailableView("Not set up yet", systemImage: tab.symbol, description: Text("The Agent Brain pages are created on first launch."))
        }
    }

    private func pageID(for tab: Tab) -> RecordID? {
        let b = brainModel.brain
        func host(_ db: RecordID) -> RecordID? { db.isEmpty ? nil : model.store.databases[db]?.blockID }
        switch tab {
        case .about: return b.aboutID.isEmpty ? nil : b.aboutID
        case .memories: return host(b.memoriesDB)
        case .skills: return host(b.skillsDB)
        case .agents: return host(b.agentsDB)
        case .connections: return nil
        }
    }
}
