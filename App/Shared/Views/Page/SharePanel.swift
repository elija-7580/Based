import SwiftUI
import BasedCore
import BasedBrain
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Share → "Share on the web": links with a role, invites, publishing, and who has access. Links are served by
/// the user's based-server, so they open in any browser on any system (and in the app where it's installed).
struct SharePanel: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model
    @State private var access: ShareClient.Access?
    @State private var linkRole: ShareRole = .view
    @State private var inviteRole: ShareRole = .edit
    @State private var created: [SharingLink.Kind: String] = [:]
    @State private var error: String?
    @State private var busy = false

    private var client: ShareClient? {
        guard let url = URL(string: model.brain.serverURL), !model.brain.serverURL.isEmpty,
              let token = Secrets.get("server.token"), !token.isEmpty else { return nil }
        return ShareClient(baseURL: url, token: token)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Share “\(model.store.title(of: pageID).isEmpty ? "Untitled" : model.store.title(of: pageID))”").font(.headline)
            if client == nil {
                Text("Links are served by your Based server. Connect it under Settings → AI → Based server, then share from here.")
                    .font(.callout).foregroundStyle(Theme.secondary)
            } else {
                row(title: "Anyone with the link", detail: "No account needed. Sub-pages are included.") {
                    Picker("", selection: $linkRole) {
                        ForEach([ShareRole.view, .comment, .edit], id: \.self) { Text($0.label).tag($0) }
                    }.labelsHidden().fixedSize()
                    Button("Create link") { create(.access, role: linkRole) }
                }
                url(created[.access])
                row(title: "Invite a person", detail: "They join with their name; works once.") {
                    Picker("", selection: $inviteRole) {
                        ForEach([ShareRole.view, .comment, .edit, .full], id: \.self) { Text($0.label).tag($0) }
                    }.labelsHidden().fixedSize()
                    Button("Create invite") { create(.invite, role: inviteRole, uses: 1) }
                }
                url(created[.invite])
                row(title: "Publish to the web", detail: "A read-only page anyone can open.") {
                    Button("Publish") { create(.publish, role: .view) }
                }
                url(created[.publish])
                Divider()
                accessList
            }
            if let error { Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange) }
        }
        .padding(DS.Space.xl)
        .frame(width: 420)
        .disabled(busy)
        .task { await reload() }
    }

    private func row<Controls: View>(title: String, detail: String, @ViewBuilder controls: () -> Controls) -> some View {
        HStack(alignment: .center) {
            VStack(alignment: .leading, spacing: 1) {
                Text(title).font(DS.Text.body(.medium))
                Text(detail).font(.caption).foregroundStyle(Theme.secondary)
            }
            Spacer()
            controls()
        }
    }

    @ViewBuilder
    private func url(_ s: String?) -> some View {
        if let s {
            HStack {
                Text(s).font(.system(size: 12).monospaced()).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                Spacer()
                Button("Copy") { copy(s) }
            }
            .padding(DS.Space.sm)
            .background(RoundedRectangle(cornerRadius: DS.Radius.control).fill(Theme.hoverFill))
        }
    }

    @ViewBuilder
    private var accessList: some View {
        Text("Who has access").font(DS.Text.body(.medium))
        if let access {
            if access.people.isEmpty && access.links.isEmpty {
                Text("Only you.").font(.caption).foregroundStyle(Theme.secondary)
            }
            ForEach(access.people) { p in
                HStack {
                    Image(systemName: "person.crop.circle")
                    Text(p.name)
                    if p.pageID != pageID { Text("via \(model.store.title(of: p.pageID))").font(.caption).foregroundStyle(Theme.secondary) }
                    Spacer()
                    Menu(p.role.label) {
                        ForEach(ShareRole.allCases, id: \.self) { r in Button(r.label) { setRole(p, r) } }
                        Divider()
                        Button("Remove", role: .destructive) { setRole(p, nil) }
                    }
                    .menuStyle(.borderlessButton).fixedSize()
                    .disabled(p.pageID != pageID)
                }
                .font(DS.Text.body())
            }
            ForEach(access.links.filter(\.active)) { l in
                HStack {
                    Image(systemName: l.kind == .publish ? "globe" : l.kind == .invite ? "envelope" : "link")
                    Text(l.kind == .publish ? "Published" : l.kind == .invite ? "Invite" : "Link")
                    Text(l.role.label).foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Revoke") { revoke(l.id) }
                }
                .font(DS.Text.body())
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func reload() async {
        guard let client else { return }
        do { access = try await client.access(to: pageID); error = nil } catch { self.error = error.localizedDescription }
    }

    private func create(_ kind: SharingLink.Kind, role: ShareRole, uses: Int? = nil) {
        guard let client else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let c = try await client.createLink(pageID: pageID, kind: kind, role: role, uses: uses)
                created[kind] = c.url
                copy(c.url)
                await reload()
            } catch { self.error = error.localizedDescription }
        }
    }

    private func revoke(_ id: String) {
        guard let client else { return }
        Task {
            do { try await client.revokeLink(id); await reload() } catch { self.error = error.localizedDescription }
        }
    }

    private func setRole(_ p: ShareClient.Access.Person, _ role: ShareRole?) {
        guard let client else { return }
        Task {
            do { try await client.setRole(user: p.userID, pageID: p.pageID, role: role); await reload() } catch { self.error = error.localizedDescription }
        }
    }

    private func copy(_ s: String) {
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(s, forType: .string)
        #else
        UIPasteboard.general.string = s
        #endif
    }
}
