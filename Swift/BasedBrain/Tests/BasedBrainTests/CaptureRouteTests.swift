import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-65: the logic behind the iPhone intents (capture, voice note, ask the agent) and the `based://` routes.
@MainActor
struct CaptureRouteTests {
    private func brain() -> BrainStore { BrainStore(store: WorkspaceStore(persistence: nil, node: "t")) }

    @Test(arguments: [CaptureRoute.compose(""), .compose("Buy milk & eggs? 50%"), .record, .askMainAgent("Plan my week, please")])
    func routesSurviveTheirURL(_ r: CaptureRoute) {
        #expect(CaptureRoute(url: r.url) == r, "\(r.url)")
    }

    @Test func routeParsingIsStrict() {
        #expect(CaptureRoute(url: URL(string: "based://capture")!) == .compose(""))
        #expect(CaptureRoute(url: URL(string: "BASED://Capture/Record")!) == .record)
        #expect(CaptureRoute(url: URL(string: "based://capture/delete")!) == nil)
        #expect(CaptureRoute(url: URL(string: "based://ask")!) == nil, "asking needs a text")
        #expect(CaptureRoute(url: URL(string: "based://ask?text=%20%20")!) == nil)
        #expect(CaptureRoute(url: URL(string: "https://capture?text=x")!) == nil)
        #expect(CaptureRoute(url: URL(string: "based://page/abc")!) == nil, "page links stay with PageLink")
    }

    @Test func captureIntentFromParameters() throws {
        let b = brain()
        #expect(CaptureIntentLogic.capture(text: nil, source: .iPhone, brain: b) == .needsInput(CaptureIntentLogic.capturePrompt))
        #expect(CaptureIntentLogic.capture(text: "  ", source: .iPhone, brain: b) == .needsInput(CaptureIntentLogic.capturePrompt))
        #expect(b.existingCapturesDB == nil, "asking for input writes nothing")
        guard case .saved(let id, let dialog) = CaptureIntentLogic.capture(text: "Call Anna\nabout the cover", source: .shortcut, brain: b) else {
            Issue.record("not saved"); return
        }
        #expect(dialog == "Saved to Captures: Call Anna")
        let c = try #require(b.capture(id))
        #expect(c.source == .shortcut && c.status == .new && c.text.contains("about the cover"))
        // Shortcuts can hand over a shared link as text.
        guard case .saved(let lid, _) = CaptureIntentLogic.capture(text: "https://example.com/a", source: .share, brain: b) else {
            Issue.record("link not saved"); return
        }
        #expect(b.capture(lid)?.link == "https://example.com/a")
        if case .failed(let m) = CaptureIntentLogic.capture(text: String(repeating: "x", count: 20_001), source: .iPhone, brain: b) {
            #expect(m.contains("too long"))
        } else { Issue.record("too long accepted") }
    }

    @Test func voiceNoteWithAndWithoutTranscript() throws {
        let b = brain()
        guard case .saved(let a, let d1) = CaptureIntentLogic.voiceNote(audio: AssetRef(id: "x", name: "v.m4a"), transcript: nil, source: .iPhone, brain: b),
              case .saved(let t, let d2) = CaptureIntentLogic.voiceNote(audio: AssetRef(id: "y", name: "w.m4a"), transcript: "Plant tulips", source: .watch, brain: b)
        else { Issue.record("not saved"); return }
        #expect(d1.contains("transcribed") && d2 == "Voice note saved.")
        #expect(b.capture(a)?.needsTranscript == true && b.capture(t)?.status == .transcribed && b.capture(t)?.title == "Plant tulips")
    }

    @Test func askNeedsAText() {
        #expect(CaptureIntentLogic.ask(nil) == .failure(.empty))
        #expect(CaptureIntentLogic.ask(" Summarise my captures ") == .success(.askMainAgent("Summarise my captures")))
        #expect(CaptureIntentLogic.ask(String(repeating: "a", count: 20_001)) == .failure(.tooLong(20_001)))
    }

    @Test func transcriptWordsJoinLikeText() {
        #expect(CaptureIntentLogic.transcriptText(["Hello", ",", "world", ".", "Call", "(", "Anna", ")", " "]) == "Hello, world. Call (Anna)")
        #expect(CaptureIntentLogic.transcriptText([]) == "")
    }
}
