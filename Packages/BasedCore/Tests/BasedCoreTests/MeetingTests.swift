import Foundation
import Testing
@testable import BasedCore

@MainActor
struct MeetingTests {
    func store() -> WorkspaceStore { WorkspaceStore(persistence: MemoryPersistence(), node: "m") }

    @Test func testCreateMeetingHasSectionsAndSurvivesRoundTrip() throws {
        let s = store()
        let page = s.createPage(title: "Weekly")
        let m = s.createMeeting(in: .block(page), title: "Sync")
        #expect(s.blocks[m]?.type == .meeting)
        #expect(s.meetingInfo(m)?.status == .ready)
        let kinds = s.contentBlocks(of: m).compactMap(\.props.meetingSection)
        #expect(kinds == [.notes, .summary])
        #expect(s.meetingSection(m, .notes) == s.contentBlocks(of: m)[0].id)

        // JSON round trip of the new props
        var b = try #require(s.blocks[m])
        b.props.meeting?.speakers = [MeetingSpeaker(id: "me", name: "Me", isMe: true)]
        let data = try Record.block(b).encoded()
        guard case .block(let back) = try Record.decode(kind: .block, data: data) else { Issue.record("decode"); return }
        #expect(back.props.meeting == b.props.meeting)
    }

    @Test func testLiveSegmentsChunkAndPartialsAreReplaced() {
        let s = store()
        let m = s.createMeeting(in: .workspace)
        s.appendTranscript(m, [TranscriptSegment(id: "a", start: 0, end: 1, speaker: "me", track: .microphone, text: "Hal", partial: true)])
        s.appendTranscript(m, [TranscriptSegment(id: "a", start: 0, end: 1.4, speaker: "me", track: .microphone, text: "Hallo zusammen")])
        #expect(s.transcript(of: m).map(\.text) == ["Hallo zusammen"])
        #expect(s.transcriptChunks(of: m).count == 1)

        let many = (0..<(Transcript.chunkSize * 2)).map {
            TranscriptSegment(id: "s\($0)", start: Double($0 + 2), end: Double($0 + 3), text: "w\($0)")
        }
        s.appendTranscript(m, many)
        #expect(s.transcriptChunks(of: m).count == 3)
        #expect(s.transcript(of: m).count == 1 + many.count)
        #expect(s.meetingInfo(m)?.duration == Double(Transcript.chunkSize * 2 + 2))
        // A later update to a segment in an older chunk lands in place, no duplicate.
        s.appendTranscript(m, [TranscriptSegment(id: "s3", start: 5, end: 6, text: "fixed")])
        #expect(s.transcript(of: m).filter { $0.id == "s3" }.map(\.text) == ["fixed"])
        #expect(s.transcript(of: m).count == 1 + many.count)
        // An empty segment removes a partial that came to nothing.
        s.appendTranscript(m, [TranscriptSegment(id: "x", start: 90, end: 91, text: "äh", partial: true)])
        s.appendTranscript(m, [TranscriptSegment(id: "x", start: 0, end: 0, text: "")])
        #expect(!s.transcript(of: m).contains { $0.id == "x" })
        // Transcription isn't undoable (the user's undo shouldn't eat the recogniser's output).
        #expect(s.undoActionName == "New meeting notes")
    }

    @Test func testReplaceTranscriptAndSpeakerSeparation() {
        let s = store()
        let m = s.createMeeting(in: .workspace)
        s.appendTranscript(m, [TranscriptSegment(id: "live", start: 0, end: 1, text: "x", partial: true)])
        let segs = [
            TranscriptSegment(id: "1", start: 0, end: 2, speaker: "me", track: .microphone, text: "Wie war die Woche?"),
            TranscriptSegment(id: "2", start: 2.2, end: 5, speaker: "others", track: .system, text: "Gut, das Release ist draußen."),
            TranscriptSegment(id: "3", start: 5.1, end: 7, speaker: "others", track: .system, text: "Bei mir auch."),
        ]
        s.replaceTranscript(m, segs, engine: "test")
        #expect(s.transcript(of: m).map(\.id) == ["1", "2", "3"])
        #expect(s.meetingInfo(m)?.engine == "test")

        s.applySpeakerTurns(m, [SpeakerTurn(start: 0, end: 5.05, speaker: "spk_a"), SpeakerTurn(start: 5.05, end: 8, speaker: "spk_b")],
                            tracks: [.system])
        let after = s.transcript(of: m)
        #expect(after.map(\.speaker) == ["me", "spk_a", "spk_b"], "mic track stays 'me'")
        let names = s.meetingInfo(m)?.speakers?.map(\.name)
        #expect(names == ["Me", "Speaker 1", "Speaker 2"])

        s.renameSpeaker(m, speaker: "spk_a", to: "Anna")
        s.mergeSpeakers(m, from: "spk_b", into: "spk_a")
        #expect(s.transcript(of: m).map(\.speaker) == ["me", "spk_a", "spk_a"])
        let info = s.meetingInfo(m)
        #expect(info?.speakers?.map(\.name) == ["Me", "Anna"])
        #expect(Transcript.text(s.transcript(of: m), info: info) == "[0:00] Me: Wie war die Woche?\n[0:02] Anna: Gut, das Release ist draußen. Bei mir auch.")
    }

    @Test func testTimecodesAndCitations() {
        #expect(Transcript.timecode(5) == "0:05")
        #expect(Transcript.timecode(754.9) == "12:34")
        #expect(Transcript.timecode(3723) == "1:02:03")
        #expect(Transcript.seconds(fromTimecode: "[12:34]") == 754)
        #expect(Transcript.seconds(fromTimecode: "1:02:03") == 3723)
        #expect(Transcript.seconds(fromTimecode: "12:75") == nil)
        #expect(Transcript.seconds(fromTimecode: "[link]") == nil)
        let c = Transcript.citations(in: "- Release fertig [2:05] und Budget [1:00:00] ok [x]")
        #expect(c.map(\.seconds) == [125, 3600])
    }

    @Test func testContextVocabularyAndSummary() {
        let s = store()
        let spec = s.createPage(title: "Projekt Nordlicht")
        _ = s.insertBlock(.text, text: RichText("Das Team um Katharina plant die API für BasedSync. Katharina übernimmt das KPI-Board."), in: .block(spec))
        let m = s.createMeeting(in: .workspace)
        s.addMeetingContext(m, .page(spec))
        s.addMeetingContext(m, .page(spec)) // no duplicate
        s.addMeetingContext(m, .note("Agenda: Roadmap Q1"))
        s.updateMeeting(m) { $0.attendees = ["Elija", "Katharina"]; $0.vocabulary = ["Parakeet"] }
        #expect(s.meetingInfo(m)?.context?.count == 2)

        let vocab = s.meetingVocabulary(m)
        #expect(Array(vocab.prefix(3)) == ["Parakeet", "Elija", "Katharina"])
        #expect(vocab.contains("Projekt Nordlicht"))
        #expect(vocab.contains("API"))
        #expect(vocab.contains("BasedSync"))
        #expect(!(vocab.contains("Das")), "sentence starts are not names")
        #expect(!(vocab.contains("Team")), "a German noun seen once is not vocabulary")
        #expect(s.meetingContextText(m).contains("Agenda: Roadmap Q1"))

        // notes with timestamps feed the prompt
        let notes = s.meetingSection(m, .notes)
        let n = s.insertBlock(.text, text: "Budget klären", in: .block(notes))
        s.stampNote(n, time: 95)
        #expect(s.meetingNotesText(m) == "[1:35] Budget klären")
        let prompt = MeetingSummaryPrompt.build(title: "Sync", transcript: "[0:00] Me: Hallo", notes: s.meetingNotesText(m),
                                                context: s.meetingContextText(m), instructions: "Kurz halten")
        #expect(prompt.contains("<my_notes>\n[1:35] Budget klären"))
        #expect(prompt.contains("Additional instructions: Kurz halten"))

        s.applyMeetingSummary(m, markdown: "## Zusammenfassung\nAlles gut [0:00]\n\n## Action items\n- [ ] Elija: Budget [1:35]", engine: "claude")
        let summary = s.contentBlocks(of: s.meetingSection(m, .summary))
        #expect(summary.map(\.type) == [.heading2, .text, .heading2, .todo])
        #expect(s.meetingInfo(m)?.summary == .done)
        // re-running replaces instead of appending
        s.applyMeetingSummary(m, markdown: "Neu", engine: "claude")
        #expect(s.contentBlocks(of: s.meetingSection(m, .summary)).map(\.text.plainText) == ["Neu"])
    }

    @Test func testExportAndSearchIncludeTranscript() {
        let s = store()
        let page = s.createPage(title: "Kunden")
        let m = s.createMeeting(in: .block(page), title: "Call mit Acme")
        s.replaceTranscript(m, [TranscriptSegment(id: "1", start: 61, end: 63, speaker: "me", text: "Der Preis ist fix.")])
        s.updateMeeting(m) { $0.speakers = [MeetingSpeaker(id: "me", name: "Elija", isMe: true)] }
        let md = MarkdownExporter(store: s).export(page: page)
        #expect(md.contains("## Call mit Acme"))
        #expect(md.contains("**Elija** [1:01]: Der Preis ist fix."))
        #expect(SearchEngine(store: s).search("Preis").first?.pageID == page)
        #expect(s.meeting(containing: s.transcriptChunks(of: m)[0].id) == m)
    }

    @Test func testWordsSplitIntoUtterances() {
        typealias W = Transcript.Word
        let words = [W("Hallo", 0, 0.4), W("zusammen.", 0.45, 0.9), W("Kurz", 2.5, 2.8), W("zum", 2.85, 3), W("Budget", 3.05, 3.5),
                     W("für", 3.55, 3.7), W("Q1.", 3.75, 7.2), W("Passt", 7.3, 7.6), W("das?", 7.65, 8)]
        let segs = Transcript.segments(words: words, offset: 60, speaker: "me", track: .microphone)
        #expect(segs.map(\.text) == ["Hallo zusammen.", "Kurz zum Budget für Q1.", "Passt das?"])
        #expect(segs.map(\.start) == [60, 62.5, 67.3])
        #expect(segs.allSatisfy { $0.speaker == "me" && $0.track == .microphone })
        #expect(Set(segs.map(\.id)).count == 3)
    }

    @Test func testChunkerFindsUtterancesAndPartials() {
        let sr = 16_000
        func tone(_ seconds: Double, amp: Float = 0.2) -> [Float] {
            (0..<Int(seconds * Double(sr))).map { amp * sin(Float($0) * 0.07) }
        }
        func noise(_ seconds: Double) -> [Float] { (0..<Int(seconds * Double(sr))).map { _ in Float.random(in: -0.001...0.001) } }
        var c = UtteranceChunker()
        var events: [UtteranceChunker.Event] = []
        let audio = noise(1) + tone(3.2) + noise(1.2) + tone(0.05) + noise(1) + tone(1)
        // feed in odd-sized buffers like a real tap
        var i = 0
        while i < audio.count { let n = min(1_037, audio.count - i); events += c.append(Array(audio[i..<(i + n)])); i += n }
        events += c.flush()
        let finals = events.compactMap { e -> (Int, Int)? in if case .final(let s, let a) = e { return (s, a.count) } else { return nil } }
        let partials = events.filter { if case .partial = $0 { return true } else { return false } }
        #expect(finals.count == 2, "the 50 ms click is dropped")
        // first utterance starts ~1 s in (minus pre-roll) and lasts ~3.2 s
        #expect(abs(Double(finals[0].0) / Double(sr) - 0.7) < 0.1)
        #expect(abs(Double(finals[0].1) / Double(sr) - 3.65) < 0.25)
        #expect(partials.count >= 2)
        // last one ends with the stream
        #expect(abs(Double(finals[1].0) / Double(sr) - (1 + 3.2 + 1.2 + 0.05 + 1 - 0.3)) < 0.1)
    }
}

