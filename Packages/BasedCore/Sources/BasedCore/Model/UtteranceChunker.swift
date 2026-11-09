import Foundation

/// Cuts a live 16 kHz mono stream into utterances for pseudo-streaming recognition: while someone speaks it
/// asks for a partial transcript every `partialEvery` seconds, and when they pause (or the utterance gets too
/// long) it hands over the finished utterance. Batch models like Parakeet transcribe a few seconds of audio in
/// milliseconds, so re-transcribing the growing utterance gives live text in any of their languages.
///
/// Speech detection is energy based with an adaptive noise floor: cheap, language-agnostic and good enough to
/// find pauses. Exact speaker turns and the final text come from the full-file pass after the recording.
public struct UtteranceChunker: Sendable {
    public enum Event: Equatable, Sendable {
        /// Speech so far in the current utterance (`start` = absolute sample index of its first sample).
        case partial(start: Int, samples: [Float])
        /// A finished utterance.
        case final(start: Int, samples: [Float])
    }

    public var sampleRate: Int
    public var frameSize: Int
    /// Silence that ends an utterance.
    public var silenceToEnd: Double = 0.7
    /// Utterances are cut here even without a pause (keeps partial latency bounded).
    public var maxUtterance: Double = 20
    public var partialEvery: Double = 1.5
    /// Shorter bursts (clicks, coughs) are dropped.
    public var minSpeech: Double = 0.25
    /// Audio kept before the detected start, so the first syllable isn't cut.
    public var preRoll: Double = 0.3
    /// Lowest RMS treated as speech, whatever the noise floor.
    public var minThreshold: Float = 0.004

    private var pending: [Float] = []
    private var consumed = 0            // absolute index of pending[0]
    private var utterance: [Float] = []
    private var utteranceStart = 0
    private var speechFrames = 0
    private var silentRun = 0
    private var sinceLastPartial = 0
    private var noiseFloor: Float = 0.002
    private var history: [Float] = []   // pre-roll ring

    public init(sampleRate: Int = 16_000, frameMillis: Int = 20) {
        self.sampleRate = sampleRate
        self.frameSize = sampleRate * frameMillis / 1000
    }

    public var isInUtterance: Bool { !utterance.isEmpty }

    public mutating func append(_ samples: [Float]) -> [Event] {
        pending.append(contentsOf: samples)
        var events: [Event] = []
        var offset = 0
        while pending.count - offset >= frameSize {
            let frame = Array(pending[offset..<(offset + frameSize)])
            let frameStart = consumed + offset
            offset += frameSize
            if let e = process(frame, at: frameStart) { events.append(e) }
        }
        pending.removeFirst(offset)
        consumed += offset
        return events
    }

    /// Ends the stream: a running utterance is returned as final.
    public mutating func flush() -> [Event] {
        var events: [Event] = []
        if !pending.isEmpty {
            let pad = pending + [Float](repeating: 0, count: frameSize - pending.count)
            if let e = process(pad, at: consumed) { events.append(e) }
            consumed += pending.count
            pending = []
        }
        if let e = finish() { events.append(e) }
        return events
    }

    private mutating func process(_ frame: [Float], at start: Int) -> Event? {
        let rms = (frame.reduce(Float(0)) { $0 + $1 * $1 } / Float(frame.count)).squareRoot()
        let threshold = max(minThreshold, noiseFloor * 3)
        let speech = rms > threshold
        if !speech {
            // Follow the noise floor down quickly and up slowly.
            noiseFloor = rms < noiseFloor ? noiseFloor * 0.9 + rms * 0.1 : noiseFloor * 0.995 + rms * 0.005
        }
        let framesPerSecond = Double(sampleRate) / Double(frameSize)

        if utterance.isEmpty {
            history.append(contentsOf: frame)
            let keep = Int(preRoll * Double(sampleRate))
            if history.count > keep { history.removeFirst(history.count - keep) }
            guard speech else { return nil }
            utterance = history
            utteranceStart = start + frameSize - history.count
            history = []
            speechFrames = 1; silentRun = 0; sinceLastPartial = 0
            return nil
        }

        utterance.append(contentsOf: frame)
        sinceLastPartial += 1
        if speech { speechFrames += 1; silentRun = 0 } else { silentRun += 1 }

        if Double(silentRun) / framesPerSecond >= silenceToEnd
            || Double(utterance.count) / Double(sampleRate) >= maxUtterance {
            return finish()
        }
        if Double(sinceLastPartial) / framesPerSecond >= partialEvery,
           Double(speechFrames) / framesPerSecond >= minSpeech {
            sinceLastPartial = 0
            return .partial(start: utteranceStart, samples: utterance)
        }
        return nil
    }

    private mutating func finish() -> Event? {
        defer { utterance = []; speechFrames = 0; silentRun = 0; sinceLastPartial = 0 }
        guard !utterance.isEmpty else { return nil }
        let framesPerSecond = Double(sampleRate) / Double(frameSize)
        guard Double(speechFrames) / framesPerSecond >= minSpeech else { return nil }
        // Trailing silence isn't part of the utterance.
        let trim = max(0, silentRun - Int(0.15 * framesPerSecond)) * frameSize
        return .final(start: utteranceStart, samples: Array(utterance.dropLast(min(trim, utterance.count))))
    }
}
