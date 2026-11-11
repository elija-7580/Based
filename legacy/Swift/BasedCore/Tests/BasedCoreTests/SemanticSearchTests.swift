import Foundation
import Testing
@testable import BasedCore

/// Deterministic stand-in for a real embedding model: words map to "concepts" (synonyms share one), each concept
/// is one axis. Texts about the same thing in different words get similar vectors.
final class FakeEmbeddingProvider: EmbeddingProvider, @unchecked Sendable {
    let id: String
    let dimension = 16
    private let lock = NSLock()
    private var _calls = 0
    private var _texts = 0
    var calls: Int { lock.withLock { _calls } }
    var texts: Int { lock.withLock { _texts } }

    init(id: String = "fake-1") { self.id = id }

    static let concepts: [[String]] = [
        ["sync", "synchronisieren", "synchronisiert", "abgleich", "abgleichen", "icloud", "cloudkit"],
        ["geräte", "gerate", "geraete", "mac", "iphone", "ipad", "devices"],
        ["rezept", "kochen", "pasta", "tomaten", "nudeln"],
        ["urlaub", "reise", "flug", "hotel", "strand"],
        ["steuer", "finanzamt", "rechnung", "belege"],
        ["datenbank", "tabelle", "spalte", "zeilen"],
    ]

    func embed(_ texts: [String]) async throws -> [[Float]] {
        lock.withLock { _calls += 1; _texts += texts.count }
        return texts.map(Self.vector)
    }

    static func vector(_ text: String) -> [Float] {
        var v = [Float](repeating: 0, count: 16)
        let words = text.lowercased().split(whereSeparator: { !$0.isLetter })
        for w in words {
            if let c = concepts.firstIndex(where: { $0.contains(String(w)) }) { v[c] += 1 }
            else { v[6 + abs(String(w).unicodeScalars.reduce(0) { $0 &* 31 &+ Int($1.value) }) % 10] += 0.1 }
        }
        return v
    }
}

@MainActor
struct SemanticSearchTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "test") }

    @Test func chunksFollowBlocksAndSplitLongText() {
        let s = store()
        let page = s.createPage(title: "Notes")
        for i in 0..<20 { s.insertBlock(.text, text: RichText("Paragraph \(i) " + String(repeating: "word ", count: 20)), in: .block(page)) }
        let long = String(repeating: "lorem ", count: 400)
        s.insertBlock(.text, text: RichText(long), in: .block(page))
        let chunks = s.semanticChunks(of: page, maxChars: 800)
        #expect(chunks.count > 3)
        #expect(chunks.allSatisfy { $0.count <= 800 })
        #expect(chunks[0].hasPrefix("Notes\nParagraph 0 "))
        // Block boundaries: no paragraph is cut in two.
        for i in 0..<20 { #expect(chunks.contains { $0.contains("Paragraph \(i) " + String(repeating: "word ", count: 19) + "word") }) }
        #expect(WorkspaceStore.pack(["a b c d e f g h"], maxChars: 40) == ["a b c d e f g h"])
        #expect(WorkspaceStore.pack([String(repeating: "x", count: 100)], maxChars: 40).map(\.count) == [40, 40, 20])
    }

    @Test func indexPersistsAndResetsWhenTheModelChanges() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("semantic-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("embeddings.sqlite")
        do {
            let idx = try SemanticIndex(url: url, providerID: "fake-1", dimension: 16)
            #expect(idx.replace(page: "p1", texts: ["Sync"], hashes: ["h1"], vectors: [FakeEmbeddingProvider.vector("sync")]))
            #expect(idx.replace(page: "p2", texts: ["Pasta"], hashes: ["h2"], vectors: [FakeEmbeddingProvider.vector("pasta")]))
            #expect(!idx.replace(page: "p3", texts: ["bad"], hashes: ["h3"], vectors: [[1, 2]]))   // wrong dimension
        }
        let again = try SemanticIndex(url: url, providerID: "fake-1", dimension: 16)
        #expect(again.pageIDs == ["p1", "p2"])
        #expect(again.hashes(of: "p1") == ["h1"])
        let hits = again.query(FakeEmbeddingProvider.vector("icloud abgleich"), limit: 1)
        #expect(hits.map(\.pageID) == ["p1"])
        #expect(hits[0].score > 0.9)

        let other = try SemanticIndex(url: url, providerID: "fake-2", dimension: 16)
        #expect(other.pageIDs.isEmpty)
    }

    @Test func indexerOnlyReembedsChangedPagesAndDropsDeletedOnes() async throws {
        let s = store()
        let provider = FakeEmbeddingProvider()
        let ctx = SemanticContext(index: try SemanticIndex(url: nil, providerID: provider.id, dimension: 16), provider: provider)
        let indexer = SemanticIndexer(store: s, context: ctx)
        let a = s.createPage(title: "Sync")
        let block = s.insertBlock(.text, text: RichText("Mac und iPhone gleichen sich über iCloud ab."), in: .block(a))
        let b = s.createPage(title: "Rezepte")
        s.insertBlock(.text, text: RichText("Pasta mit Tomaten"), in: .block(b))

        var r = await indexer.update()
        #expect(r.embedded == 2)
        let calls = provider.calls
        r = await indexer.update()
        #expect(r.embedded == 0 && r.unchanged == 2)
        #expect(provider.calls == calls)

        s.setText(block, RichText("Geräte synchronisieren über CloudKit."))
        r = await indexer.update(pages: [a])
        #expect(r.embedded == 1)

        s.trash([b])
        r = await indexer.update()
        #expect(r.removed == 1)
        #expect(ctx.index.pageIDs == [a])
    }

    @Test func reciprocalRankFusionRewardsAgreement() {
        let fused = HybridSearch.fuse([["a", "b", "c"], ["c", "d", "a"]])
        // a: 1/61 + 1/63, c: 1/63 + 1/61 — tie, broken by first appearance; b and d one list each.
        #expect(fused.map(\.id) == ["a", "c", "b", "d"])
        #expect(abs(fused[0].score - (1.0 / 61 + 1.0 / 63)) < 1e-12)
        let merged = HybridSearch.merge(keyword: [SearchHit(pageID: "x", snippet: "kw")],
                                        semantic: [SemanticHit(pageID: "y", score: 0.8, snippet: "sem"), SemanticHit(pageID: "x", score: 0.5, snippet: "s2")],
                                        limit: 10)
        #expect(merged.map(\.pageID) == ["x", "y"])
        #expect(merged[0].snippet == "kw")
        #expect(merged[1].snippet == "sem")
    }

    @Test func hybridSearchFindsPagesByMeaningAndRelatedPages() async throws {
        let s = store()
        let provider = FakeEmbeddingProvider()
        let ctx = SemanticContext(index: try SemanticIndex(url: nil, providerID: provider.id, dimension: 16), provider: provider)
        let docs = s.createPage(title: "Abgleich")
        s.insertBlock(.text, text: RichText("Mac, iPhone und iPad bleiben über iCloud und CloudKit im Abgleich."), in: .block(docs))
        let food = s.createPage(title: "Kochen")
        s.insertBlock(.text, text: RichText("Pasta mit Tomaten und Nudeln."), in: .block(food))
        let devices = s.createPage(title: "Geräte")
        s.insertBlock(.text, text: RichText("Mac und iPhone abgleichen."), in: .block(devices))
        let template = s.createPage(title: "Vorlage Sync")
        s.updateBlock(template) { $0.props.isTemplate = true }
        await SemanticIndexer(store: s, context: ctx).update()

        // No page contains the word "synchronisieren" — keyword search finds nothing, hybrid finds the docs.
        #expect(SearchEngine(store: s).search("Wie synchronisieren Geräte").isEmpty)
        let hits = await HybridSearch(store: s, semantic: ctx).search("Wie synchronisieren Geräte")
        #expect(hits.first.map { [docs, devices].contains($0.pageID) } == true)
        #expect(!hits.contains { $0.pageID == food })
        #expect(!hits.contains { $0.pageID == template })
        #expect(hits.first?.snippet != nil)

        // A keyword hit and a semantic hit on the same page rank first.
        let both = await HybridSearch(store: s, semantic: ctx).search("Geräte")
        #expect(both.first?.pageID == devices)

        let related = HybridSearch(store: s, semantic: ctx).related(to: devices)
        #expect(related.first?.pageID == docs)
        #expect(!related.contains { $0.pageID == devices || $0.pageID == food })

        // Without an index it is plain keyword search.
        #expect(await HybridSearch(store: s, semantic: nil).search("Geräte").map(\.pageID) == SearchEngine(store: s).search("Geräte").map(\.pageID))
    }
}
