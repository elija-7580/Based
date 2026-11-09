import Foundation
import BasedCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Embeddings from an OpenAI-compatible `/v1/embeddings` endpoint (BSD-62) — OpenAI, or a local Ollama
/// (`http://127.0.0.1:11434/v1`, model e.g. `nomic-embed-text`). Used by based-server, where Apple's on-device
/// embedding isn't available.
public struct OpenAIEmbeddingProvider: EmbeddingProvider {
    public typealias Post = @Sendable (URL, [String: String], JSONValue) async throws -> (Int, Data)

    public let baseURL: URL
    public let model: String
    public let apiKey: String
    public let dimension: Int
    public var id: String { "openai-compatible:\(baseURL.host ?? "?"):\(model)" }
    var post: Post

    public init(baseURL: URL, model: String, apiKey: String = "", dimension: Int,
                post: Post? = nil) {
        self.baseURL = baseURL
        self.model = model
        self.apiKey = apiKey
        self.dimension = dimension
        self.post = post ?? { try await HTTP.post($0, headers: $1, body: $2) }
    }

    /// Asks the endpoint once to learn the vector size of `model`.
    public static func probe(baseURL: URL, model: String, apiKey: String = "",
                             post: Post? = nil) async throws -> OpenAIEmbeddingProvider {
        let tmp = OpenAIEmbeddingProvider(baseURL: baseURL, model: model, apiKey: apiKey, dimension: 0, post: post)
        let v = try await tmp.request(["dimension probe"])
        guard let n = v.first?.count, n > 0 else { throw AIError.badResponse("no embedding returned") }
        return OpenAIEmbeddingProvider(baseURL: baseURL, model: model, apiKey: apiKey, dimension: n, post: post)
    }

    public func embed(_ texts: [String]) async throws -> [[Float]] {
        guard !texts.isEmpty else { return [] }
        let out = try await request(texts)
        guard out.count == texts.count, out.allSatisfy({ $0.count == dimension }) else {
            throw AIError.badResponse("expected \(texts.count) vectors of \(dimension), got \(out.map(\.count))")
        }
        return out
    }

    func request(_ texts: [String]) async throws -> [[Float]] {
        var headers: [String: String] = [:]
        if !apiKey.isEmpty { headers["Authorization"] = "Bearer \(apiKey)" }
        let body: JSONValue = ["model": .string(model), "input": .array(texts.map { .string($0) })]
        let (code, data) = try await post(baseURL.appendingPathComponent("embeddings"), headers, body)
        guard (200..<300).contains(code) else { throw AIError.http(code, String(decoding: data.prefix(500), as: UTF8.self)) }
        return try Self.parse(data)
    }

    /// `{"data": [{"index": 0, "embedding": [...]}, …]}` → vectors in input order.
    static func parse(_ data: Data) throws -> [[Float]] {
        let json = try JSONValue.parse(data)
        guard let items = json["data"]?.array else { throw AIError.badResponse(String(json.text.prefix(300))) }
        let sorted = items.enumerated().sorted { ($0.element["index"]?.int ?? $0.offset) < ($1.element["index"]?.int ?? $1.offset) }
        return sorted.map { ($0.element["embedding"]?.array ?? []).compactMap { $0.number.map(Float.init) } }
    }
}

public extension AgentTools {
    /// BSD-62: `search` by words and meaning when a semantic index is attached (`semantic`); nil otherwise, so the
    /// caller falls back to the plain keyword search of `call`.
    func semanticSearchCall(_ name: String, _ args: JSONValue) async -> ToolResult? {
        guard name == "search", let semantic, let q = args["query"]?.string, !q.isEmpty else { return nil }
        let hits = await HybridSearch(store: store, semantic: semantic).search(q, limit: args["limit"]?.int ?? 20)
        let text = hits.map { h in
            "- \(store.title(of: h.pageID)) [id: \(h.pageID), link: \(PageLink.url(h.pageID))]" + (h.snippet.map { " — \($0)" } ?? "")
                + (h.blockID.map { $0 == h.pageID ? "" : " [block: \($0)]" } ?? "")
        }.joined(separator: "\n")
        return ToolResult(text: text.isEmpty ? "No results." : text, isError: false)
    }
}
