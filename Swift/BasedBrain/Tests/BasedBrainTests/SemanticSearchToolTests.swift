import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-62: OpenAI-compatible embeddings and the agent `search` tool using the semantic index.
@MainActor
struct SemanticSearchToolTests {
    /// Words → concept axes (synonyms share one), like a tiny embedding model.
    struct ConceptProvider: EmbeddingProvider {
        let id = "concepts"
        let dimension = 4
        static let concepts = [["sync", "synchronisieren", "abgleich", "icloud"], ["geräte", "mac", "iphone"], ["pasta", "kochen"]]
        func embed(_ texts: [String]) async throws -> [[Float]] {
            texts.map { t in
                var v: [Float] = [0, 0, 0, 0.05]
                for w in t.lowercased().split(whereSeparator: { !$0.isLetter }) {
                    if let i = Self.concepts.firstIndex(where: { $0.contains(String(w)) }) { v[i] += 1 }
                }
                return v
            }
        }
    }

    @Test func openAICompatibleEmbeddingsRequestAndParse() async throws {
        let seen = LockedBox<[JSONValue]>([])
        let post: OpenAIEmbeddingProvider.Post = { url, headers, body in
            #expect(url.absoluteString == "http://127.0.0.1:11434/v1/embeddings")
            #expect(headers["Authorization"] == nil)
            seen.mutate { $0.append(body) }
            let n = body["input"]?.array?.count ?? 0
            // Out of order on purpose: the provider sorts by "index".
            let items = (0..<n).reversed().map { i in "{\"index\": \(i), \"embedding\": [\(i), 1, 0]}" }.joined(separator: ",")
            return (200, Data("{\"data\": [\(items)]}".utf8))
        }
        let p = try await OpenAIEmbeddingProvider.probe(baseURL: URL(string: "http://127.0.0.1:11434/v1")!, model: "nomic-embed-text", post: post)
        #expect(p.dimension == 3)
        let v = try await p.embed(["a", "b"])
        #expect(v == [[0, 1, 0], [1, 1, 0]])
        #expect(seen.value.last?["model"]?.string == "nomic-embed-text")

        let failing = OpenAIEmbeddingProvider(baseURL: URL(string: "http://x/v1")!, model: "m", apiKey: "k", dimension: 3) { _, headers, _ in
            #expect(headers["Authorization"] == "Bearer k")
            return (500, Data("boom".utf8))
        }
        await #expect(throws: (any Error).self) { try await failing.embed(["a"]) }
    }

    @Test func searchToolFindsPagesByMeaning() async throws {
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let brain = BrainStore(store: store)
        let tools = AgentTools(store: store, brain: brain)
        let docs = store.createPage(title: "Abgleich")
        store.insertBlock(.text, text: RichText("Mac und iPhone über iCloud"), in: .block(docs))
        let food = store.createPage(title: "Kochen")
        store.insertBlock(.text, text: RichText("Pasta"), in: .block(food))

        // Keyword only: nothing contains "synchronisieren".
        #expect(await tools.callAsync("search", ["query": "synchronisieren"]).text == "No results.")

        let provider = ConceptProvider()
        let ctx = SemanticContext(index: try SemanticIndex(url: nil, providerID: provider.id, dimension: provider.dimension), provider: provider)
        let report = await SemanticIndexer(store: store, context: ctx, excludedRoots: [brain.rootID]).update()
        #expect(report.embedded == 2)
        #expect(!ctx.index.pageIDs.contains(brain.rootID))
        tools.semantic = ctx
        let out = await tools.callAsync("search", ["query": "synchronisieren"]).text
        #expect(out.contains("Abgleich [id: \(docs)"))
        #expect(!out.contains("Kochen"))
    }
}

final class LockedBox<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var _value: T
    init(_ v: T) { _value = v }
    var value: T { lock.withLock { _value } }
    func mutate(_ f: (inout T) -> Void) { lock.withLock { f(&_value) } }
}
