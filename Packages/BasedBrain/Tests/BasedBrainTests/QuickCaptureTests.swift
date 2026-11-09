import Foundation
import Testing
import BasedCore
@testable import BasedBrain

/// BSD-64: system-wide quick capture on the Mac — shortcut parsing and what the field saves.
@MainActor
struct QuickCaptureTests {
    @Test func parsesSymbolsWordsAndSeparators() throws {
        let def = try #require(HotKey.parse("⌥⇧Space"))
        #expect(def == HotKey.defaultQuickCapture)
        #expect(def.description == "⌥⇧Space")
        #expect(def.carbonKeyCode == 49)
        #expect(def.carbonModifiers == 0x800 | 0x200)

        #expect(HotKey.parse("option+shift+space") == def)
        #expect(HotKey.parse("  Alt Shift Leertaste ") == def)
        let c = try #require(HotKey.parse("Cmd-Ctrl-c"))
        #expect(c.description == "⌃⌘C")
        #expect(c.carbonKeyCode == 8)
        #expect(c.carbonModifiers == 0x100 | 0x1000)
        #expect(HotKey.parse("⌃⌥-")?.carbonKeyCode == 27)
        #expect(HotKey.parse("F5")?.carbonKeyCode == 96)          // F-keys may stand alone
        #expect(HotKey.parse("ctrl+F12")?.description == "⌃F12")
        #expect(HotKey.parse("cmd+return")?.carbonKeyCode == 36)
    }

    @Test func rejectsBareKeysAndUnknownNames() {
        #expect(HotKey.parse("") == nil)
        #expect(HotKey.parse("a") == nil)              // would swallow typing
        #expect(HotKey.parse("Space") == nil)
        #expect(HotKey.parse("hyper+a") == nil)
        #expect(HotKey.parse("cmd+") == nil)
        #expect(HotKey.parse("cmd+escape") == nil)
        #expect(HotKey.parse("⌘F13") == nil)
    }

    @Test func clipboardOnlyPrefillsWebLinks() {
        #expect(QuickCapture.prefillLink(clipboard: " https://example.com/a?b=1 \n") == "https://example.com/a?b=1")
        #expect(QuickCapture.prefillLink(clipboard: "file:///etc/passwd") == nil)
        #expect(QuickCapture.prefillLink(clipboard: "my secret password") == nil)
        #expect(QuickCapture.prefillLink(clipboard: "https://a.com\nhttps://b.com") == nil)
        #expect(QuickCapture.prefillLink(clipboard: nil) == nil)
    }

    @Test func submitCreatesCaptureOrMainAgentTask() throws {
        let store = WorkspaceStore(persistence: MemoryPersistence(), node: "t")
        let brain = BrainStore(store: store)
        let at = Date(timeIntervalSince1970: 1_800_000_000)

        guard case .captured(let id) = QuickCapture.submit(text: "  Idee: Sync-Doku kürzen ", link: "https://based.app", toMainAgent: false,
                                                            brain: brain, now: at) else { Issue.record("no capture"); return }
        let c = try #require(brain.capture(id))
        #expect(c.text.contains("Idee: Sync-Doku kürzen"))
        #expect(c.link == "https://based.app")
        #expect(c.source == .mac)
        #expect(c.status == .new)

        #expect(QuickCapture.submit(text: "   ", toMainAgent: false, brain: brain) == .failed(CaptureInput.Problem.empty.description))
        #expect(QuickCapture.submit(text: "x", link: "ftp://nope", toMainAgent: false, brain: brain) == .failed("Not a web link: ftp://nope"))

        let before = brain.captures().count
        #expect(QuickCapture.submit(text: "Recherchiere X", link: "https://x.org", toMainAgent: true, brain: brain) == .askMainAgent("Recherchiere X\nhttps://x.org"))
        #expect(brain.captures().count == before)   // a task is not a capture
        #expect(QuickCapture.submit(text: " ", toMainAgent: true, brain: brain) == .failed(CaptureInput.Problem.empty.description))
    }
}
