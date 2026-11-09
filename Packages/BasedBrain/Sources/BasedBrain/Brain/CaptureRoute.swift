import Foundation
import BasedCore

// BSD-65: the logic behind "capture a thought" on iPhone (App Intents: Shortcuts, Action Button, Siri) and on the
// Mac. The intents and the capture sheet stay thin: they call `CaptureIntentLogic` and follow a `CaptureRoute`.

/// Where the app should go after an intent or a `based://` link opened it.
public enum CaptureRoute: Hashable, Sendable, Identifiable {
    /// The capture sheet, optionally prefilled.
    case compose(String)
    /// The capture sheet, recording a voice note right away.
    case record
    /// The main agent's thread with this message sent.
    case askMainAgent(String)

    public var id: String {
        switch self {
        case .compose(let t): return "compose:" + t
        case .record: return "record"
        case .askMainAgent(let t): return "ask:" + t
        }
    }

    /// `based://capture[?text=…]`, `based://capture/record`, `based://ask?text=…`.
    public var url: URL {
        var c = URLComponents()
        c.scheme = "based"
        switch self {
        case .compose(let t):
            c.host = "capture"
            if !t.isEmpty { c.queryItems = [URLQueryItem(name: "text", value: t)] }
        case .record:
            c.host = "capture"; c.path = "/record"
        case .askMainAgent(let t):
            c.host = "ask"; c.queryItems = [URLQueryItem(name: "text", value: t)]
        }
        return c.url!
    }

    public init?(url: URL) {
        guard url.scheme?.lowercased() == "based", let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let text = c.queryItems?.first { $0.name == "text" }?.value ?? ""
        let path = c.path.trimmingCharacters(in: CharacterSet(charactersIn: "/")).lowercased()
        switch c.host?.lowercased() {
        case "capture":
            switch path {
            case "": self = .compose(text)
            case "record": self = .record
            default: return nil
            }
        case "ask":
            let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard path.isEmpty, !t.isEmpty else { return nil }
            self = .askMainAgent(t)
        default:
            return nil
        }
    }
}

/// What an intent answers.
public enum CaptureIntentResult: Equatable, Sendable {
    /// Stored; `dialog` is what Siri / the Shortcuts banner says.
    case saved(RecordID, dialog: String)
    /// Nothing given yet: ask with this prompt (or open the sheet).
    case needsInput(String)
    /// Invalid input; say this.
    case failed(String)
}

@MainActor
public enum CaptureIntentLogic {
    public static let capturePrompt = "What's on your mind?"
    public static let askPrompt = "What should your agent do?"

    /// "Capture a thought" with an optional text (Shortcuts may pass a link or shared text). Works offline: the
    /// capture is written to the local workspace and syncs later.
    public static func capture(text: String?, source: Capture.Source, brain: BrainStore, at date: Date = Date()) -> CaptureIntentResult {
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !t.isEmpty else { return .needsInput(capturePrompt) }
        do {
            let id = try brain.addCapture(CaptureInput(text: t, source: source, capturedAt: date))
            return .saved(id, dialog: "Saved to Captures: \(brain.capture(id)?.title ?? t)")
        } catch let p as CaptureInput.Problem {
            return .failed(p.description)
        } catch {
            return .failed("\(error)")
        }
    }

    /// A finished voice note: stores the audio (and the transcript when the device already has one).
    public static func voiceNote(audio: AssetRef, transcript: String?, source: Capture.Source, brain: BrainStore,
                                 at date: Date = Date()) -> CaptureIntentResult {
        do {
            let id = try brain.addCapture(CaptureInput(audio: audio, transcript: transcript, source: source, capturedAt: date))
            let pending = brain.capture(id)?.needsTranscript == true
            return .saved(id, dialog: pending ? "Voice note saved. It is transcribed on this device shortly." : "Voice note saved.")
        } catch let p as CaptureInput.Problem {
            return .failed(p.description)
        } catch {
            return .failed("\(error)")
        }
    }

    /// "Ask my agent": checks the request and returns the route that opens the main thread with it.
    public static func ask(_ text: String?) -> Result<CaptureRoute, CaptureInput.Problem> {
        let t = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if t.isEmpty { return .failure(.empty) }
        if t.count > CaptureInput.maxLength { return .failure(.tooLong(t.count)) }
        return .success(.askMainAgent(t))
    }

    /// Joins recognised words into text ("Hello , world" → "Hello, world").
    public nonisolated static func transcriptText(_ words: [String]) -> String {
        var out = ""
        for w in words {
            let s = w.trimmingCharacters(in: .whitespaces)
            guard !s.isEmpty else { continue }
            let attaches = s.first.map { ",.;:!?)…".contains($0) } ?? false
            if !out.isEmpty, !attaches, !out.hasSuffix("(") { out += " " }
            out += s
        }
        return out
    }
}

// MARK: - Apple Watch (BSD-66)

@MainActor
public enum WatchCaptureLogic {
    /// What the watch shows: captures of today (any device) and when "Sort captures" runs ("daily 23:00" → "23:00").
    public static func status(brain: BrainStore, now: Date = Date(), calendar: Calendar = .current) -> WatchStatus {
        let today = brain.captures().filter { calendar.isDate($0.capturedAt, inSameDayAs: now) }.count
        let schedule = brain.agents().first { $0.name == BrainStore.captureSorterName }?.schedule ?? ""
        let time = schedule.split(separator: " ").last.map(String.init).flatMap { t -> String? in
            let p = t.split(separator: ":")
            guard p.count == 2, let h = Int(p[0]), let m = Int(p[1]), (0..<24).contains(h), (0..<60).contains(m) else { return nil }
            return String(format: "%02d:%02d", h, m)
        }
        return WatchStatus(capturedToday: today, sortTime: time)
    }

    /// A voice note that arrived from the watch: stored audio → capture (source Watch, recorded time of the watch),
    /// waiting for its transcript. A transfer seen before (`ledger`) is skipped and returns nil.
    public static func receive(meta: WatchCaptureMeta, audio: AssetRef, brain: BrainStore, ledger: inout WatchInboxLedger) -> CaptureIntentResult? {
        guard ledger.accept(meta.id) else { return nil }
        return CaptureIntentLogic.voiceNote(audio: audio, transcript: nil, source: .watch, brain: brain, at: meta.capturedAt)
    }
}
