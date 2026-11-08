// Type-check stub of FluidAudio 0.18.3 (subset used by meeting notes). Signatures copied from the package
// sources (ASR/Parakeet/SlidingWindow/TDT/AsrManager.swift, AsrModels.swift, Shared/AudioConverter.swift,
// Diarizer/Offline/Core/OfflineDiarizerManager.swift, Diarizer/Core/DiarizerTypes.swift). Signatures only.
import Foundation
@_exported import AVFoundation

public struct DownloadProgress: Sendable { public let fractionCompleted: Double }
public typealias ProgressHandler = @Sendable (DownloadProgress) -> Void
public enum AsrModelVersion: Sendable { case v2, v3, redux, ultra, phonon2, phonon25, bark3, bark3Clean, tdtCtc110m, tdtJa }
public enum ParakeetEncoderPrecision: String, Sendable { case int8 }
public final class MLModelConfiguration {}
public enum MLComputeUnits { case all, cpuOnly, cpuAndGPU, cpuAndNeuralEngine }
public struct AsrModels: Sendable {
    public static func downloadAndLoad(to directory: URL? = nil, configuration: MLModelConfiguration? = nil, version: AsrModelVersion = .v3,
                                       encoderPrecision: ParakeetEncoderPrecision = .int8, encoderComputeUnits: MLComputeUnits? = nil,
                                       progressHandler: ProgressHandler? = nil) async throws -> AsrModels { fatalError() }
}
public struct ASRConfig: Sendable { public static let `default` = ASRConfig() }
public enum Language: String, Sendable, CaseIterable { case english = "en", german = "de", french = "fr" }
public struct TokenTiming: Sendable {
    public let token: String
    public let tokenId: Int
    public let startTime: TimeInterval
    public let endTime: TimeInterval
    public let confidence: Float
}
public struct WordTiming: Codable, Sendable {
    public let word: String
    public let startTime: TimeInterval
    public let endTime: TimeInterval
}
public func buildWordTimings(from tokenTimings: [TokenTiming]) -> [WordTiming] { [] }
public struct ASRResult: Sendable {
    public let text: String
    public let confidence: Float
    public let duration: TimeInterval
    public let tokenTimings: [TokenTiming]?
}
public struct TdtDecoderState: Sendable { public static func make(decoderLayers: Int = 2) -> TdtDecoderState { TdtDecoderState() } }
public actor AsrManager {
    public init(config: ASRConfig = .default, models: AsrModels? = nil) {}
    public var decoderLayerCount: Int { 2 }
    public func loadModels(_ models: AsrModels) async throws {}
    public func transcribe(_ audioSamples: [Float], decoderState: inout TdtDecoderState, language: Language? = nil) async throws -> ASRResult { fatalError() }
    public func transcribe(_ url: URL, decoderState: inout TdtDecoderState, language: Language? = nil) async throws -> ASRResult { fatalError() }
}
final public class AudioConverter: Sendable {
    public enum ResamplerQuality: Sendable { case balanced }
    public init(targetFormat: AVAudioFormat? = nil, resamplerQuality: ResamplerQuality = .balanced, debug: Bool = false) {}
    public func resampleAudioFile(_ url: URL) throws -> [Float] { [] }
    public func resampleBuffer(_ buffer: AVAudioPCMBuffer) throws -> [Float] { [] }
}
public struct OfflineDiarizerConfig: Sendable { public static var `default`: OfflineDiarizerConfig { OfflineDiarizerConfig() } }
public struct TimedSpeakerSegment: Sendable {
    public let speakerId: String
    public let embedding: [Float]
    public let startTimeSeconds: Float
    public let endTimeSeconds: Float
    public let qualityScore: Float
}
public struct DiarizationResult: Sendable { public let segments: [TimedSpeakerSegment] }
public final class OfflineDiarizerManager {
    public init(config: OfflineDiarizerConfig = .default) {}
    public func prepareModels(directory: URL? = nil, configuration: MLModelConfiguration? = nil, forceRedownload: Bool = false) async throws {}
    public func process(_ url: URL, progressCallback: (@Sendable (Int, Int) -> Void)? = nil) async throws -> DiarizationResult { fatalError() }
}
