import SwiftUI
import BasedCore
import BasedBrain

/// BSD-132: Settings → Agents & AI → Sandbox snapshots. Lists old snapshot archives, snapshot images and restore
/// backups on the Based server (GET /sandbox/leftovers) and removes them only after a confirmation
/// (POST /sandbox/cleanup; the server re-scans and removes nothing else). Network only on a click, never in a body.
struct SandboxCleanupSection: View {
    @Environment(AppModel.self) private var model
    @State private var items: [SandboxLeftover] = []
    @State private var provider = ""
    @State private var status: String?
    @State private var busy = false
    @State private var confirm = false

    private var server: (url: URL, token: String)? {
        let s = model.brain.serverURL.trimmingCharacters(in: .whitespaces)
        guard !s.isEmpty, let u = URL(string: s), let t = Secrets.get("server.token"), !t.isEmpty else { return nil }
        return (u, t)
    }

    var body: some View {
        Section("Sandbox snapshots (server)") {
            Text("Old snapshot archives, snapshot images and folders kept before a restore. Snapshots of running sandboxes are never listed; nothing is removed without your confirmation.")
                .font(.caption).foregroundStyle(Theme.secondary)
            if server == nil {
                Text("Connect a Based server (Settings → Sync) to see its sandboxes.").font(.caption).foregroundStyle(Theme.secondary)
            } else {
                HStack {
                    Button("Scan") { Task { await scan() } }.disabled(busy)
                        .accessibilityIdentifier("settings.sandbox.scan")
                    Button("Remove \(items.count)…", role: .destructive) { confirm = true }
                        .disabled(busy || items.isEmpty)
                    if busy { ProgressView().controlSize(.small) }
                    Spacer()
                    if let status { Text(status).font(.caption).foregroundStyle(Theme.secondary) }
                }
                ForEach(items, id: \.reference) { item in
                    HStack {
                        Text(item.label).font(.caption).lineLimit(1).truncationMode(.middle)
                        Spacer()
                        if let m = item.modified { Text(m.formatted(date: .abbreviated, time: .omitted)).font(.caption2).foregroundStyle(Theme.secondary) }
                    }
                }
            }
        }
        .confirmationDialog("Remove \(items.count) old snapshot item(s) on the server?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Remove", role: .destructive) { Task { await remove() } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Archives, images and restore backups listed here are deleted for good. Project folders stay.")
        }
    }

    private func request(_ path: String, body: JSONValue? = nil) async throws -> JSONValue {
        guard let server else { throw CLIError("no server") }
        var req = URLRequest(url: server.url.appendingPathComponent(path))
        req.setValue("Bearer " + server.token, forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 60
        if let body {
            req.httpMethod = "POST"
            req.httpBody = try body.encoded()
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
        let v = (try? JSONValue.parse(data)) ?? .null
        guard code == 200 else { throw CLIError(v["error"]?.string ?? "HTTP \(code)") }
        return v
    }

    private func scan() async {
        busy = true; defer { busy = false }
        do {
            let v = try await request("sandbox/leftovers")
            provider = v["sandbox"]?.string ?? ""
            items = (v["leftovers"]?.array ?? []).compactMap(SandboxLeftover.init(json:))
            status = provider == "none" ? "The server runs agents without a sandbox." : (items.isEmpty ? "Nothing to clean up." : "\(items.count) item(s)")
        } catch { status = "\(error)" }
    }

    private func remove() async {
        busy = true; defer { busy = false }
        do {
            let v = try await request("sandbox/cleanup", body: ["references": .array(items.map { .string($0.reference) }), "confirm": true])
            let n = v["removed"]?.array?.count ?? 0
            Log.notice("sandbox cleanup on server removed \(n) item(s)", category: "agents")
            items = []
            status = "Removed \(n)."
        } catch { status = "\(error)" }
    }
}
