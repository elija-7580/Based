// Signature-only stub of Apple's NaturalLanguage framework (BSD-62: on-device sentence embeddings).
import Foundation

public struct NLLanguage: RawRepresentable, Hashable, Sendable {
    public var rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public init(_ rawValue: String) { self.rawValue = rawValue }
    public static let english = NLLanguage("en")
    public static let german = NLLanguage("de")
    public static let french = NLLanguage("fr")
    public static let spanish = NLLanguage("es")
    public static let italian = NLLanguage("it")
    public static let portuguese = NLLanguage("pt")
    public static let simplifiedChinese = NLLanguage("zh-Hans")
    public static let undetermined = NLLanguage("und")
}

open class NLEmbedding: NSObject {
    open class func wordEmbedding(for language: NLLanguage) -> NLEmbedding? { nil }
    open class func sentenceEmbedding(for language: NLLanguage) -> NLEmbedding? { nil }
    open class func currentSentenceEmbeddingRevision(for language: NLLanguage) -> Int { 0 }
    open var dimension: Int { 0 }
    open var language: NLLanguage? { nil }
    open var revision: Int { 0 }
    open func vector(for string: String) -> [Double]? { nil }
    open func contains(_ string: String) -> Bool { false }
    open func distance(between firstString: String, and secondString: String) -> Double { 0 }
}

open class NLLanguageRecognizer: NSObject {
    public override init() {}
    open class func dominantLanguage(for string: String) -> NLLanguage? { nil }
    open func processString(_ string: String) {}
    open var dominantLanguage: NLLanguage? { nil }
}
