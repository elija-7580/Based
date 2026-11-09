import Foundation
import Observation
import AVFoundation
import BasedCore
import BasedBrain

extension Capture.Source {
    /// The device this build runs on.
    static var thisDevice: Capture.Source {
        #if os(iOS)
        return .iPhone
        #else
        return .mac
        #endif
    }
}

/// BSD-65: records a voice note for Captures with the meeting-notes audio pipeline (16 kHz mono AAC), stores it as an
/// asset, and transcribes it on this device afterwards (FluidAudio Parakeet, like meeting notes). Without the speech
/// model the note is saved anyway and waits for its transcript (`Capture.needsTranscript`).
/// On iPhone the recording keeps running in the background once started (UIBackgroundModes: audio).
@MainActor @Observable
final class VoiceCaptureService {
    static let shared = VoiceCaptureService()

    private(set) var isRecording = false
    private(set) var elapsed: Double = 0
    private(set) var level: Float = 0
    private(set) var lastError: String?

    @ObservationIgnored private var writer: TrackWriter?
    @ObservationIgnored private var mic: MicrophoneCapture?
    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var fileURL: URL?

    /// Shorter recordings are dropped (an accidental tap).
    static let minimumSeconds = 0.7

    func start() async {
        guard !isRecording else { return }
        lastError = nil
        if MeetingService.shared.session != nil { lastError = "A meeting is being recorded. Stop it first."; return }
        guard await MicrophoneCapture.requestPermission() else {
            lastError = "Microphone access is off. Allow Based in Settings → Privacy & Security → Microphone."
            return
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("based-voice-\(UUID().uuidString).m4a")
        do {
            let w = try TrackWriter(role: .microphone, url: url)
            let m = MicrophoneCapture(writer: w)
            try m.start()
            writer = w; mic = m; fileURL = url
            isRecording = true; elapsed = 0
            ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor in self?.tick() }
            }
            MeetingService.shared.loadModelInBackground()
        } catch {
            lastError = "Recording failed: \(error.localizedDescription)"
            try? FileManager.default.removeItem(at: url)
        }
    }

    private func tick() {
        guard let w = writer else { return }
        elapsed = w.seconds
        level = w.level
    }

    /// Stops and discards the recording.
    func cancel() {
        let url = finishRecording().url
        if let url { try? FileManager.default.removeItem(at: url) }
    }

    /// Stops, stores the audio and adds the capture; the transcript follows in the background.
    @discardableResult
    func stopAndSave(model: AppModel) -> CaptureIntentResult? {
        let (url, seconds) = finishRecording()
        guard let url else { return nil }
        guard seconds >= Self.minimumSeconds else { try? FileManager.default.removeItem(at: url); return nil }
        let ref: AssetRef
        do { ref = try model.assets.importFile(at: url) } catch {
            lastError = "The voice note couldn't be stored: \(error.localizedDescription)"
            try? FileManager.default.removeItem(at: url)
            return .failed(lastError ?? "")
        }
        let brain = model.brain.brain
        let result = CaptureIntentLogic.voiceNote(audio: ref, transcript: nil, source: .thisDevice, brain: brain)
        if case .saved(let id, _) = result {
            Task { await Self.transcribe(id, file: url, brain: brain) }
        } else {
            try? FileManager.default.removeItem(at: url)
        }
        return result
    }

    private func finishRecording() -> (url: URL?, seconds: Double) {
        ticker?.invalidate(); ticker = nil
        mic?.stop()
        let seconds = writer?.seconds ?? 0
        // Releasing the writer closes the AAC file before it is copied into the asset store.
        mic = nil; writer = nil
        let url = fileURL
        fileURL = nil
        isRecording = false; level = 0
        return (url, seconds)
    }

    /// BSD-111: transcribes voice notes that still wait for text (from the watch, a device without the speech
    /// model, an interrupted run). Nil when this build/device has no on-device speech model.
    /// BSD-113: `download` fetches audio that only the Based server has (voice notes sent to its POST /capture).
    static func transcribeWaiting(brain: BrainStore, assets: FileAssetStore?,
                                  download: ((AssetRef) async -> URL?)? = nil) async -> CaptureTranscription.Report? {
        guard SpeechEngine.isAvailable, !CaptureTranscription.waiting(brain).isEmpty else { return nil }
        return await CaptureTranscription.run(brain, assets: assets, download: download) { url in
            let words = try await SpeechEngine.shared.words(file: url, language: nil)
            return CaptureIntentLogic.transcriptText(words.map(\.text))
        }
    }

    private static func transcribe(_ id: RecordID, file: URL, brain: BrainStore) async {
        defer { try? FileManager.default.removeItem(at: file) }
        guard SpeechEngine.isAvailable else { return }
        do {
            let words = try await SpeechEngine.shared.words(file: file, language: nil)
            let text = CaptureIntentLogic.transcriptText(words.map(\.text))
            if !text.isEmpty { brain.setTranscript(id, text) }
        } catch {
            Log.warning("Voice note transcription failed: \(error)", category: "capture")
        }
    }
}
