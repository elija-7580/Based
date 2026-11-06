import Foundation
import BasedCore

/// Imports pages and databases straight from the Notion API: content, formatting, database schemas,
/// views (filters, sorts, grouping), rows with their content, relations and files.
///
/// Usage: create an internal integration at notion.so/profile/integrations, share the pages with it
/// (••• → Connections), then `try await NotionWorkspaceImport(token: …).run([NotionTarget(link)!], into: store, assets: assets)`.
public final class NotionWorkspaceImport: @unchecked Sendable {
    public let options: NotionImportOptions
    let client: NotionClient
    /// Progress (0…1) and a short description of the current step. Called from background tasks.
    public var onProgress: (@Sendable (Double, String) -> Void)?
    private var tempDir: URL?

    public init(token: String, options: NotionImportOptions = NotionImportOptions(), transport: NotionTransport = URLSessionNotionTransport()) {
        self.options = options
        self.client = NotionClient(token: token, transport: transport)
    }

    init(client: NotionClient, options: NotionImportOptions) {
        self.options = options
        self.client = client
    }

    /// Fetches the targets (everything shared with the integration when empty) and maps them.
    public func fetch(_ targets: [NotionTarget]) async throws -> ImportBuilder {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("notion-api-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        tempDir = dir
        let crawler = NotionCrawler(client: client, options: options, fileDirectory: dir)
        let progress = onProgress
        crawler.onProgress = { done, total, message in
            // The total grows while crawling; keep the bar moving without jumping back.
            progress?(min(0.92, Double(done) / Double(max(total, 1)) * 0.92), message)
        }
        let snap = try await crawler.crawl(targets)
        progress?(0.94, "Converting…")
        let builder = ImportBuilder()
        NotionAPIMapper.map(snap, into: builder)
        let requests = await client.requestCount
        builder.notes.append("\(requests) Notion API requests.")
        return builder
    }

    /// Fetches, maps and writes the import in one undoable step. Re-importing the same pages updates them in place.
    @MainActor
    public func run(_ targets: [NotionTarget], into store: WorkspaceStore, assets: AssetStore?, parent: ParentRef = .workspace) async throws -> ImportReport {
        defer { cleanup() }
        let builder = try await fetch(targets)
        if builder.isEmpty {
            var r = builder.report()
            if r.warnings.isEmpty { r.warnings.append("Nothing was imported. Make sure the pages are shared with the integration (••• → Connections).") }
            return r
        }
        onProgress?(0.97, "Saving…")
        let stored = builder.resolveAssets(assets)
        var report = store.commitImport(builder, into: parent, name: "Import from Notion")
        report.assets = stored
        onProgress?(1, "Done")
        return report
    }

    /// Removes downloaded files (after they were copied into the asset store).
    public func cleanup() {
        if let d = tempDir { try? FileManager.default.removeItem(at: d) }
        tempDir = nil
    }

    /// Checks a token; returns the integration's name and workspace.
    public static func verify(token: String, transport: NotionTransport = URLSessionNotionTransport()) async throws -> String {
        let me = try await NotionClient(token: token, transport: transport).get("users/me")
        let name = me["name"]?.string ?? "Integration"
        if let ws = me["bot"]?["workspace_name"]?.string, !ws.isEmpty { return "\(name) · \(ws)" }
        return name
    }
}
