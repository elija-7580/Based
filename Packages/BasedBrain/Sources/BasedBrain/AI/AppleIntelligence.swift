import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// On-device model via Apple's Foundation Models framework (macOS 26 / iOS 26).
/// Used for private, free tasks: autofill properties, categorisation, summaries.
/// Tool calling is emulated by asking for a JSON answer.
public struct AppleIntelligenceProvider: AIProvider {
    public let id = "apple"
    public let displayName = "Apple Intelligence (on device)"
    public let models = ["on-device"]
    public init() {}

    public static var isAvailable: Bool {
        #if canImport(FoundationModels)
        if #available(macOS 26, iOS 26, *) { return SystemLanguageModel.default.isAvailable }
        #endif
        return false
    }

    public func complete(_ messages: [ChatMessage], model: String, tools: [ToolSpec], maxTokens: Int) async throws -> AIResponse {
        #if canImport(FoundationModels)
        if #available(macOS 26, iOS 26, *) {
            let system = messages.filter { $0.role == .system }.map(\.content).joined(separator: "\n")
            let session = LanguageModelSession(instructions: system)
            let transcript = messages.filter { $0.role != .system }.map { "\($0.role.rawValue.uppercased()): \($0.content)" }.joined(separator: "\n\n")
            let reply = try await session.respond(to: transcript)
            return AIResponse(message: .assistant(reply.content))
        }
        #endif
        throw AIError.unavailable("Apple Intelligence is not available on this device.")
    }
}

/// Small, model-agnostic helpers for "smart properties".
public enum SmartTasks {
    /// Ask a model to pick one option for a select property given page text.
    public static func categorise(text: String, options: [String], using provider: AIProvider, model: String) async throws -> String? {
        let prompt = "Choose the single best category for the note below. Answer with the category name only.\nCategories: \(options.joined(separator: ", "))\n\nNote:\n\(text.prefix(6000))"
        let r = try await provider.complete([.user(prompt)], model: model, tools: [], maxTokens: 30)
        let answer = r.message.content.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: ".\"'"))
        return options.first { $0.caseInsensitiveCompare(answer) == .orderedSame } ?? options.first { answer.localizedCaseInsensitiveContains($0) }
    }

    /// Fill a free-text property (summary, key points, …) from the page text.
    public static func fill(property: String, instruction: String?, text: String, using provider: AIProvider, model: String) async throws -> String {
        let prompt = "Fill the property \"\(property)\" for the note below.\(instruction.map { " Instruction: \($0)" } ?? "") Answer with the value only, no preamble.\n\nNote:\n\(text.prefix(8000))"
        let r = try await provider.complete([.user(prompt)], model: model, tools: [], maxTokens: 300)
        return r.message.content.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
