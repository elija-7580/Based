import Foundation
import BasedCore

/// BSD-111: voice notes that arrived without text (recorded on a device without the speech model, sent by a
/// watch, or the transcription was interrupted) wait as Captures with status New and an audio file
/// (`Capture.needsTranscript`). The Mac — which has the on-device model — transcribes them later, at the latest
/// right before "Sort captures" runs (`AgentScheduler.beforeRun`), so the sorter sees their text.
///
/// The speech engine lives in the app; it comes in as `transcribe` (audio file → text). Everything else — which
/// captures wait, where their audio is, what happens on errors — is here and tested.
@MainActor
public enum CaptureTranscription {
    public struct Report: Sendable, Equatable {
        public var transcribed = 0
        /// Audio not on this device yet (asset not synced/downloaded) — retried next time.
        public var notOnDevice = 0
        /// "<title> — <error>" for transcriptions that failed or came back empty — retried next time.
        public var failed: [String] = []
        public init() {}
    }

    /// Voice notes still waiting for their transcript, oldest first.
    public static func waiting(_ brain: BrainStore, limit: Int = 20) -> [Capture] {
        Array(brain.captures([.new]).filter(\.needsTranscript).reversed().prefix(limit))
    }

    /// Transcribes up to `limit` waiting voice notes one after the other; each result goes in with
    /// `setTranscript` (status Transcribed, title from the text), so the capture becomes sortable.
    public static func run(_ brain: BrainStore, assets: AssetStore?, limit: Int = 20,
                           transcribe: (URL) async throws -> String) async -> Report {
        var report = Report()
        for c in waiting(brain, limit: limit) {
            guard let ref = c.audio?.asset, let url = assets?.url(for: ref) else { report.notOnDevice += 1; continue }
            do {
                let text = try await transcribe(url).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { report.failed.append("\(c.title) — no speech recognised"); continue }
                // The capture may have been transcribed or removed elsewhere while we were busy.
                guard brain.capture(c.id)?.needsTranscript == true else { continue }
                brain.setTranscript(c.id, text)
                report.transcribed += 1
            } catch {
                report.failed.append("\(c.title) — \(error)")
            }
        }
        return report
    }
}
