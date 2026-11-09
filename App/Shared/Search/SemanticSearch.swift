import Foundation
import SwiftUI
import NaturalLanguage
import BasedCore
import BasedBrain

// BSD-62: semantic search and related pages, on-device.
//
// * `AppleEmbeddingProvider` — Apple's sentence embedding (`NLEmbedding`): offline, no key, nothing leaves the Mac.
// * `SemanticService` — owns the index (`embeddings.sqlite` next to the workspace, never synced), fills it in the
//   background (first run ~20 s after start, then 30 s after the last edit of a page, low priority) and hands it to
//   ⌘K (`SearchOverlay`), the "Related pages" list at the end of a page and the agents' `search` tool.
// * Settings → My settings → Search turns it off (the index stays on disk) or rebuilds it.

/// On-device sentence embedding of one language (the system language when Apple ships a model for it, else English).
final class AppleEmbeddingProvider: EmbeddingProvider, @unchecked Sendable {
    let id: String
    let dimension: Int
    private let embedding: NLEmbedding
    private let lock = NSLock()

    init?(languageCode: String? = Locale.preferredLanguages.first) {
        let code = languageCode.map { String($0.prefix(2)) } ?? "en"
        let candidates = [NLLanguage(rawValue: code), .english]
        guard let (lang, e) = candidates.lazy.compactMap({ l in NLEmbedding.sentenceEmbedding(for: l).map { (l, $0) } }).first,
              e.dimension > 0 else { return nil }
        embedding = e
        dimension = e.dimension
        id = "apple-sentence:\(lang.rawValue):\(NLEmbedding.currentSentenceEmbeddingRevision(for: lang))"
    }

    func embed(_ texts: [String]) async throws -> [[Float]] {
        lock.withLock {
            texts.map { t in embedding.vector(for: t).map { $0.map(Float.init) } ?? [Float](repeating: 0, count: dimension) }
        }
    }
}

@MainActor
@Observable
final class SemanticService {
    static let enabledKey = "pref.search.semantic"
    static var enabledByDefault: Bool { UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true }

    /// Index + model while semantic search is on and a model is available.
    private(set) var context: SemanticContext?
    /// Bumped after each indexing pass, so "Related pages" refreshes.
    private(set) var revision = 0
    private(set) var status = "Off"
    private(set) var indexing = false

    @ObservationIgnored let store: WorkspaceStore
    @ObservationIgnored private let directory: URL?
    @ObservationIgnored private let excludedRoots: Set<RecordID>
    @ObservationIgnored private let onContext: (SemanticContext?) -> Void
    @ObservationIgnored private var indexer: SemanticIndexer?
    @ObservationIgnored private var token: ObservationToken?
    @ObservationIgnored private var dirty: Set<RecordID> = []
    @ObservationIgnored private var debounce: Task<Void, Never>?
    @ObservationIgnored private var running: Task<Void, Never>?

    static let editDelay: Double = 30

    init(store: WorkspaceStore, directory: URL?, excludedRoots: Set<RecordID>, onContext: @escaping (SemanticContext?) -> Void) {
        self.store = store
        self.directory = directory
        self.excludedRoots = excludedRoots
        self.onContext = onContext
        if Self.enabledByDefault { start() }
    }

    func setEnabled(_ on: Bool) {
        UserDefaults.standard.set(on, forKey: Self.enabledKey)
        on ? start() : stop()
    }

    private func start() {
        guard context == nil else { return }
        guard let provider = AppleEmbeddingProvider() else {
            status = "No on-device language model available"
            Log.warning("Semantic search: no sentence embedding for this language", category: "search")
            return
        }
        do {
            let index = try SemanticIndex(url: directory?.appendingPathComponent("embeddings.sqlite"),
                                          providerID: provider.id, dimension: provider.dimension)
            let ctx = SemanticContext(index: index, provider: provider)
            context = ctx
            indexer = SemanticIndexer(store: store, context: ctx, excludedRoots: excludedRoots)
            onContext(ctx)
            status = "\(index.pageIDs.count) pages indexed"
        } catch {
            status = "Index unavailable"
            Log.error("Semantic index unavailable: \(error)", category: "search")
            return
        }
        token = store.observe { [weak self] change in
            if Thread.isMainThread {
                MainActor.assumeIsolated { self?.note(change) }
            } else {
                Task { @MainActor in self?.note(change) }
            }
        }
        schedule(after: 20, pages: nil)
    }

    private func stop() {
        debounce?.cancel(); running?.cancel()
        token = nil
        indexer = nil
        context = nil
        onContext(nil)
        status = "Off"
    }

    /// Empties the index and builds it again.
    func rebuild() {
        context?.index.removeAll()
        schedule(after: 0, pages: nil)
    }

    private func note(_ change: ChangeSet) {
        for id in change.blockIDs {
            if store.blocks[id]?.type.isPageLike == true { dirty.insert(id) }
            else if let p = store.containingPage(of: id) { dirty.insert(p) }
        }
        for key in change.parents where key.hasPrefix("b:") {
            let id = String(key.dropFirst(2))
            if store.blocks[id]?.type.isPageLike == true { dirty.insert(id) }
            else if let p = store.containingPage(of: id) { dirty.insert(p) }
        }
        if !dirty.isEmpty { schedule(after: Self.editDelay, pages: []) }
    }

    /// `pages` nil = whole workspace; empty = the pages edited since the last pass.
    private func schedule(after delay: Double, pages: [RecordID]?) {
        debounce?.cancel()
        debounce = Task(priority: .background) { @MainActor [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard !Task.isCancelled, let self else { return }
            await self.running?.value
            self.run(pages: pages)
        }
    }

    private func run(pages: [RecordID]?) {
        guard let indexer else { return }
        let targets: [RecordID]? = pages == nil ? nil : Array(dirty)
        dirty = []
        indexing = true
        running = Task(priority: .background) { @MainActor [weak self] in
            let r = await indexer.update(pages: targets)
            guard let self else { return }
            self.indexing = false
            self.revision += 1
            self.status = "\(indexer.context.index.pageIDs.count) pages indexed"
            if r.embedded + r.removed + r.failed > 0 {
                Log.info("Semantic index: \(r.embedded) embedded, \(r.removed) removed, \(r.failed) failed, \(r.unchanged) unchanged", category: "search")
            }
        }
    }

    func hybrid() -> HybridSearch { HybridSearch(store: store, semantic: context) }
}

// MARK: - Related pages (end of a page)

struct RelatedPagesView: View {
    let pageID: RecordID
    @Environment(AppModel.self) private var model

    var body: some View {
        let service = model.semantic
        let _ = service?.revision
        let hits = service.map { $0.hybrid().related(to: pageID, limit: 5) } ?? []
        if !hits.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Text("Related pages").font(DS.Text.small(.semibold)).foregroundStyle(Theme.secondary)
                ForEach(hits, id: \.pageID) { h in
                    Button { model.open(h.pageID) } label: {
                        HStack(spacing: 6) {
                            PageIconView(icon: model.store.icon(of: h.pageID), size: 14)
                            Text(model.store.title(of: h.pageID).nonEmptyOr("Untitled")).lineLimit(1)
                            Text(h.snippet).lineLimit(1).foregroundStyle(Theme.secondary)
                        }
                    }
                    .buttonStyle(.hoverFill)
                    .help(h.snippet)
                }
            }
            .font(DS.Text.body())
            .padding(.top, DS.Space.xxl)
            .padding(.bottom, DS.Space.md)
        }
    }
}

// MARK: - Settings

struct SemanticSearchSettings: View {
    @Environment(AppModel.self) private var model
    @State private var on = SemanticService.enabledByDefault

    var body: some View {
        Section("Search") {
            Toggle("Search by meaning (on-device)", isOn: Binding(get: { on }, set: { v in on = v; model.semantic?.setEnabled(v) }))
            if let s = model.semantic {
                HStack {
                    Text(s.indexing ? "Indexing…" : s.status).font(.caption).foregroundStyle(Theme.secondary)
                    Spacer()
                    Button("Rebuild index") { s.rebuild() }.disabled(s.context == nil || s.indexing)
                }
            }
            Text("⌘K, “Related pages” and agents also find pages by meaning. Apple’s on-device language model computes it; nothing leaves this device. The index (embeddings.sqlite) is not synced.")
                .font(.caption).foregroundStyle(Theme.secondary)
        }
    }
}
