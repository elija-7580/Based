import Foundation
import BasedCore
import BasedBrain

extension BrainModel {
    /// Is any AI usable right now (API key, local server, Claude Code / Codex CLI or Apple Intelligence)?
    var hasEngine: Bool { resolvedEngine != .none }

    /// One prompt in, one answer out, with whatever engine the user set up (BYOK API model or coding-agent CLI).
    /// Used for meeting summaries; `write(_:pageID:)` is the page-content flavour of the same thing.
    func complete(system: String, prompt: String, maxTokens: Int = 4096) async throws -> String {
        switch resolvedEngine {
        case .model(let ref):
            guard let (provider, model) = registry.resolve(ref) else { throw ChatError.noEngine }
            let r = try await provider.complete([.system(system), .user(prompt)], model: model, tools: [], maxTokens: maxTokens)
            return r.message.content
        case .cli(let spec):
            if spec.kind == .claudeCode {
                switch await ClaudePrint.ask(prompt, cwd: chatFolder, appendSystemPrompt: system, model: spec.model.isEmpty ? nil : spec.model) {
                case .success(let r): return r.text
                case .failure(let e): throw e
                }
            }
            let collected = TextCollector()
            let result = await Self.runCLI(spec, prompt: prompt, resume: nil, system: system, cwd: chatFolder, mcp: nil) { e in
                if case .text(let t) = e { collected.parts.append(t) }
            }
            if case .failure(let e) = result { throw e }
            return collected.parts.joined(separator: "\n\n")
        case .none:
            throw ChatError.noEngine
        }
    }
}
