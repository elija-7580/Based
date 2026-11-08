import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Settings → Updates: installed build, what's new on GitHub, and "Update now".
struct UpdatesSettings: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let u = model.updater
        if !u.isSupported {
            Section("Updates") {
                Text("On iPhone and iPad, Based is updated by installing a new build from Xcode (or TestFlight).")
                    .font(.callout).foregroundStyle(Theme.secondary)
            }
        } else if u.channel == .release {
            releaseSection(u)
        } else {
            Section("Based for Mac") {
                LabeledContent("Installed") {
                    Text(installedText(u)).textSelection(.enabled)
                }
                statusRow(u)
                if u.justUpdated {
                    Label("Updated — you're running the new build.", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                }
                Toggle("Check for updates automatically", isOn: Binding(get: { u.autoCheck }, set: { u.autoCheck = $0 }))
            }
            if u.phase != .idle { progressSection(u) }
            if u.agentAvailable == false { setupSection }
            if !u.newCommits.isEmpty { whatsNew(u) }
        }
    }

    /// Downloaded (DMG) build: Sparkle does the work; this shows the state and its settings.
    @ViewBuilder
    private func releaseSection(_ u: Updater) -> some View {
        Section("Based for Mac") {
            LabeledContent("Installed") { Text("Version \(u.version) · \(u.shortCommit)").textSelection(.enabled) }
            HStack(spacing: 10) {
                switch u.check {
                case .available:
                    Image(systemName: "arrow.down.circle.fill").foregroundStyle(Color.accentColor)
                    Text("Version \(u.availableVersion ?? "") is available").fontWeight(.medium)
                case .upToDate:
                    Image(systemName: "checkmark.circle").foregroundStyle(.green)
                    Text("Based is up to date")
                case .checking:
                    ProgressView().controlSize(.small)
                    Text("Checking…").foregroundStyle(Theme.secondary)
                case .failed(let why), .unknown(let why):
                    Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.secondary)
                    Text(why).font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
                case .idle:
                    Text("Not checked yet").foregroundStyle(Theme.secondary)
                }
                Spacer(minLength: 8)
                if u.updateAvailable {
                    Button("Update now…") { Task { await u.install() } }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("updates.install")
                } else {
                    Button("Check now") { Task { await u.checkWithUI() } }
                }
            }
            if let d = u.lastChecked {
                Text("Last checked \(d.formatted(date: .abbreviated, time: .shortened))")
                    .font(.caption).foregroundStyle(Theme.secondary)
            }
            Toggle("Check for updates automatically", isOn: Binding(get: { u.autoCheck }, set: { u.autoCheck = $0 }))
            Toggle("Download updates in the background", isOn: Binding(get: { _ = u.autoDownloadTick; return u.autoDownload },
                                                                        set: { u.autoDownload = $0 }))
                .disabled(!u.autoCheck)
            Text("Updates come from the latest release on GitHub. The window that opens shows what's new; Install Update replaces Based and reopens it.")
                .font(.caption).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
        }
        Section {
            if let url = URL(string: "https://github.com/\(u.repo)/releases") { Link("All releases on GitHub", destination: url) }
        }
    }

    private func installedText(_ u: Updater) -> String {
        var parts = ["\(u.version.isEmpty ? "dev" : u.version) (build \(u.build.isEmpty ? "–" : u.build))", u.shortCommit]
        if let d = u.installedDate { parts.append(d.formatted(date: .abbreviated, time: .omitted)) }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private func statusRow(_ u: Updater) -> some View {
        HStack(spacing: 10) {
            switch u.check {
            case .idle:
                Text("Not checked yet").foregroundStyle(Theme.secondary)
            case .checking:
                ProgressView().controlSize(.small)
                Text("Checking GitHub…").foregroundStyle(Theme.secondary)
            case .upToDate:
                Image(systemName: "checkmark.circle").foregroundStyle(.green)
                Text("Based is up to date")
            case .available:
                Image(systemName: "arrow.down.circle.fill").foregroundStyle(Color.accentColor)
                Text(u.newCommits.count == 1 ? "1 update available" : "\(u.newCommits.count) updates available").fontWeight(.medium)
            case .unknown(let why), .failed(let why):
                Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.secondary)
                Text(why).font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            Button("Check now") { Task { await u.checkNow() } }
                .disabled(u.check == .checking || u.phase.isRunning)
            Button("Update now") { Task { await u.install() } }
                .buttonStyle(.borderedProminent)
                .disabled(u.phase.isRunning || u.agentAvailable == false || !(u.updateAvailable || u.isDevelopmentBuild || isUnknown(u)))
                .accessibilityIdentifier("updates.install")
        }
        if let d = u.lastChecked {
            Text("Last checked \(d.formatted(date: .omitted, time: .shortened))")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
    }

    private func isUnknown(_ u: Updater) -> Bool { if case .unknown = u.check { return true }; return false }

    @ViewBuilder
    private func progressSection(_ u: Updater) -> some View {
        Section("Update") {
            switch u.phase {
            case .idle: EmptyView()
            case .fetching:
                step("Downloading changes from GitHub…")
            case .building(let c):
                step("Building \(c.isEmpty ? "the new version" : c) — this takes a few minutes. You can keep working.")
            case .installing:
                step("Installing — Based quits and reopens by itself.")
            case .done(let c):
                Label("Installed \(c). Restart Based if it didn't reopen.", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            case .failed(let why):
                VStack(alignment: .leading, spacing: 8) {
                    Label("The update didn't finish", systemImage: "xmark.octagon").foregroundStyle(.red)
                    Text(why).font(.callout).foregroundStyle(Theme.secondary).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Try again") { Task { await u.install() } }
                        if u.agentAvailable != false {
                            Button("Run in Terminal") { Task { await u.installInTerminal() } }
                                .help("macOS can block background jobs from reading Documents or Desktop; Terminal is allowed.")
                        }
                        #if os(macOS)
                        Button("Show log") { _ = NSWorkspace.shared.open(URL(fileURLWithPath: NSHomeDirectory() + "/Library/Logs/Based/update.log")) }
                        #endif
                    }
                }
            }
        }
    }

    private func step(_ text: String) -> some View {
        HStack(spacing: 10) {
            ProgressView().controlSize(.small)
            Text(text).fixedSize(horizontal: false, vertical: true)
        }
    }

    private var setupSection: some View {
        Section("Set up one-click updates") {
            Text("Updates are built on this Mac from the source code. The updater that does this is installed the next time you run the install script in Terminal, from your Based folder:")
                .font(.callout).foregroundStyle(Theme.secondary).fixedSize(horizontal: false, vertical: true)
            HStack {
                Text("scripts/install-mac.sh").font(.system(.body, design: .monospaced)).textSelection(.enabled)
                Spacer()
                #if os(macOS)
                Button("Copy") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString("scripts/install-mac.sh", forType: .string)
                }
                #endif
            }
        }
    }

    private func whatsNew(_ u: Updater) -> some View {
        Section("What's new") {
            ForEach(u.newCommits.prefix(50)) { c in
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.title).fixedSize(horizontal: false, vertical: true)
                    HStack(spacing: 6) {
                        Text(c.short).font(.system(.caption, design: .monospaced))
                        if let d = c.date { Text(d.formatted(.relative(presentation: .named))).font(.caption) }
                    }
                    .foregroundStyle(Theme.secondary)
                }
                .padding(.vertical, 2)
            }
            if u.newCommits.count > 50 {
                Text("…and \(u.newCommits.count - 50) more").font(.caption).foregroundStyle(Theme.secondary)
            }
            if let url = u.compareURL { Link("See all changes on GitHub", destination: url) }
        }
    }
}

/// Sidebar footer row shown while an update is available or installing.
struct SidebarUpdateRow: View {
    @Environment(AppModel.self) private var model
    @State private var hover = false

    var body: some View {
        let u = model.updater
        if u.updateAvailable || u.phase.isRunning {
            HStack(spacing: 8) {
                Group {
                    if u.phase.isRunning { ProgressView().controlSize(.mini) }
                    else { Image(systemName: "arrow.down.circle.fill").font(.system(size: 13)).foregroundStyle(Color.accentColor) }
                }
                .frame(width: 20, height: 20)
                Text(u.phase.isRunning ? "Updating…" : "Update available").font(.system(size: 14, weight: .medium)).lineLimit(1)
                Spacer(minLength: 4)
            }
            .foregroundStyle(Chrome.sidebarText)
            .padding(.horizontal, 8)
            .frame(height: Chrome.rowHeight)
            .background(RoundedRectangle(cornerRadius: 6).fill(hover ? Chrome.hover : .clear))
            .contentShape(Rectangle())
            .onHover { hover = $0 }
            .onTapGesture {
                if u.channel == .release { Task { await u.install() } } else { model.openSettings(page: "updates") }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("sidebar.update")
        }
    }
}
