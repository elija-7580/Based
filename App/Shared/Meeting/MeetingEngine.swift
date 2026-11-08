import Foundation
import BasedCore
#if canImport(FluidAudio)
import FluidAudio
#endif

// On-device speech recognition and speaker separation for meeting notes, through FluidAudio:
//   • Parakeet TDT 0.6B v3 — 25 European languages incl. German, punctuation, word timestamps (CC-BY-4.0)
//   • pyannote community-1 + VBx — offline speaker diarization
// Models download once (~0.5 GB) into Application Support and run on the Neural Engine.

enum MeetingEngineError: LocalizedError {
    case unavailable
    var errorDescription: String? { "On-device transcription isn't available in this build." }
}

/// Model state shown in the meeting block ("Downloading speech model … 42 %").
enum SpeechModelState: Equatable {
    case notLoaded
    case loading(Double)
    case ready
    case failed(String)
}

/// Shared recogniser. An actor so live tracks and the final pass don't use the model at the same time.
actor SpeechEngine {
    static let shared = SpeechEngine()
    static let engineID = "fluid.parakeet-tdt-0.6b-v3"

    #if canImport(FluidAudio)
    private var asr: AsrManager?
    private var diarizer: OfflineDiarizerManager?
    private var loading: Task<AsrManager, Error>?
    #endif

    /// Loads (and on first use downloads) the recogniser. `progress` gets 0…1.
    func prepare(progress: (@Sendable (Double) -> Void)? = nil) async throws {
        #if canImport(FluidAudio)
        _ = try await recogniser(progress: progress)
        #else
        throw MeetingEngineError.unavailable
        #endif
    }

    #if canImport(FluidAudio)
    private func recogniser(progress: (@Sendable (Double) -> Void)? = nil) async throws -> AsrManager {
        if let asr { return asr }
        if let loading { return try await loading.value }
        let task = Task<AsrManager, Error> {
            let models = try await AsrModels.downloadAndLoad(version: .v3, progressHandler: { p in progress?(p.fractionCompleted) })
            let m = AsrManager(config: .default)
            try await m.loadModels(models)
            return m
        }
        loading = task
        do {
            let m = try await task.value
            asr = m; loading = nil
            return m
        } catch {
            loading = nil
            throw error
        }
    }
    #endif

    /// Words of 16 kHz mono samples, times relative to the first sample.
    func words(_ samples: [Float], language: String?) async throws -> [Transcript.Word] {
        #if canImport(FluidAudio)
        // Parakeet needs at least ~1 s of context; pad very short utterances with silence.
        var input = samples
        if input.count < 16_000 { input += [Float](repeating: 0, count: 16_000 - input.count) }
        let asr = try await recogniser()
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(input, decoderState: &state, language: Self.language(language))
        let duration = Double(samples.count) / 16_000
        return Self.words(result, fallbackDuration: duration).filter { $0.start < duration + 0.2 }
        #else
        throw MeetingEngineError.unavailable
        #endif
    }

    /// Words of a whole audio file (any format), times relative to its start.
    func words(file url: URL, language: String?) async throws -> [Transcript.Word] {
        #if canImport(FluidAudio)
        let samples = try AudioConverter().resampleAudioFile(url)
        guard !samples.isEmpty else { return [] }
        let asr = try await recogniser()
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(samples, decoderState: &state, language: Self.language(language))
        return Self.words(result, fallbackDuration: Double(samples.count) / 16_000)
        #else
        throw MeetingEngineError.unavailable
        #endif
    }

    /// Who spoke when, in a file. Labels are the diarizer's ("S1", "S2" …), stable within one file.
    func speakerTurns(file url: URL) async throws -> [SpeakerTurn] {
        #if canImport(FluidAudio)
        if diarizer == nil {
            let d = OfflineDiarizerManager(config: .default)
            try await d.prepareModels()
            diarizer = d
        }
        guard let diarizer else { return [] }
        let result = try await diarizer.process(url)
        return result.segments.map {
            SpeakerTurn(start: Double($0.startTimeSeconds), end: Double($0.endTimeSeconds), speaker: $0.speakerId)
        }
        #else
        throw MeetingEngineError.unavailable
        #endif
    }

    #if canImport(FluidAudio)
    private static func language(_ code: String?) -> Language? {
        guard let code else { return nil }
        return Language(rawValue: String(code.prefix(2)).lowercased())
    }

    private static func words(_ r: ASRResult, fallbackDuration: Double) -> [Transcript.Word] {
        if let timings = r.tokenTimings, !timings.isEmpty {
            return buildWordTimings(from: timings).map { Transcript.Word($0.word, $0.startTime, $0.endTime) }
        }
        // No timings: spread the text evenly so it still lands in roughly the right place.
        let parts = r.text.split(separator: " ").map(String.init)
        guard !parts.isEmpty else { return [] }
        let step = fallbackDuration / Double(parts.count)
        return parts.enumerated().map { Transcript.Word($0.element, Double($0.offset) * step, Double($0.offset + 1) * step) }
    }
    #endif

    nonisolated static var isAvailable: Bool {
        #if canImport(FluidAudio)
        return true
        #else
        return false
        #endif
    }
}

/// Live transcription of one track: utterance chunking + re-transcribing the growing utterance.
/// Results arrive in order on the main actor through `emit`.
final class LiveTrackTranscriber: @unchecked Sendable {
    private let track: AudioTrackRole
    private let speaker: String?
    /// Seconds of this track's sample 0 in the meeting timeline.
    private let offset: Double
    private let language: String?
    private let emit: @MainActor ([TranscriptSegment]) -> Void
    private var chunker = UtteranceChunker()
    private let lock = NSLock()
    private let queue: AsyncStream<UtteranceChunker.Event>
    private let input: AsyncStream<UtteranceChunker.Event>.Continuation
    private var worker: Task<Void, Never>?

    init(track: AudioTrackRole, speaker: String?, offset: Double, language: String?,
         emit: @escaping @MainActor ([TranscriptSegment]) -> Void) {
        self.track = track; self.speaker = speaker; self.offset = offset; self.language = language; self.emit = emit
        (queue, input) = AsyncStream.makeStream(of: UtteranceChunker.Event.self, bufferingPolicy: .unbounded)
        worker = Task.detached(priority: .userInitiated) { [queue, track, speaker, offset, language, emit] in
            var finished = Set<Int>()
            var iterator = queue.makeAsyncIterator()
            while let event = await iterator.next() {
                switch event {
                case .partial(let start, let samples):
                    // Only the newest partial of an utterance matters; skip it if the utterance already ended.
                    guard !finished.contains(start) else { continue }
                    if let seg = await Self.segment(samples, start: start, partial: true, track: track, speaker: speaker,
                                                    offset: offset, language: language) {
                        await emit([seg])
                    }
                case .final(let start, let samples):
                    finished.insert(start)
                    if let seg = await Self.segment(samples, start: start, partial: false, track: track, speaker: speaker,
                                                    offset: offset, language: language) {
                        await emit([seg])
                    } else {
                        // Nothing recognised: an empty segment removes the partial that may be showing.
                        await emit([TranscriptSegment(id: Self.id(track, start), start: 0, end: 0, text: "")])
                    }
                }
            }
        }
    }

    /// Called from the capture thread with 16 kHz samples and the track's sample index.
    func append(_ samples: [Float]) {
        lock.lock()
        let events = chunker.append(samples)
        lock.unlock()
        for e in events { input.yield(e) }
    }

    func finish() {
        lock.lock()
        let events = chunker.flush()
        lock.unlock()
        for e in events { input.yield(e) }
        input.finish()
    }

    /// Waits until queued utterances are transcribed.
    func drain() async { await worker?.value }

    static func id(_ track: AudioTrackRole, _ start: Int) -> String { "live-\(track.rawValue)-\(start)" }

    private static func segment(_ samples: [Float], start: Int, partial: Bool, track: AudioTrackRole, speaker: String?,
                                offset: Double, language: String?) async -> TranscriptSegment? {
        guard let words = try? await SpeechEngine.shared.words(samples, language: language), !words.isEmpty else { return nil }
        let text = words.map(\.text).joined(separator: " ")
        let t0 = offset + Double(start) / MeetingAudioFormat.sampleRate
        return TranscriptSegment(id: id(track, start), start: t0, end: t0 + Double(samples.count) / MeetingAudioFormat.sampleRate,
                                 speaker: speaker, track: track, text: text, partial: partial ? true : nil)
    }
}
