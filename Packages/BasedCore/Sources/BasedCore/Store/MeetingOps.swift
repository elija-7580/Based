import Foundation

/// Meeting notes operations. Recording and recognition live in the app; everything that touches records
/// is here so it is unit-tested and the same on every platform (and the server).
@MainActor
public extension WorkspaceStore {

    // MARK: Create / lookup

    /// Inserts a meeting block with its notes and summary sections. The title defaults to
    /// "Meeting notes — <date>".
    @discardableResult
    func createMeeting(in parent: ParentRef, at position: InsertPosition = .end, title: String? = nil,
                       info: MeetingInfo = MeetingInfo(), now: Date = Date(), name: String = "New meeting notes") -> RecordID {
        transact(name) { tx in
            var props = BlockProps()
            props.meeting = info
            let label = title ?? ("Meeting notes — " + Self.meetingDateFormatter.string(from: now))
            let m = Block(type: .meeting, parent: parent, sortKey: tx.sortKey(in: parent, position),
                          text: RichText(label), props: props, createdAt: now, createdBy: userID)
            tx.put(m)
            let keys = tx.sortKeys(2, in: .block(m.id), .start)
            for (kind, key) in zip(MeetingSectionKind.allCases, keys) {
                var p = BlockProps(); p.meetingSection = kind
                tx.put(Block(type: .meetingSection, parent: .block(m.id), sortKey: key, props: p, createdAt: now, createdBy: userID))
            }
            return m.id
        }
    }

    private static let meetingDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .medium; f.timeStyle = .short
        return f
    }()

    func meetingInfo(_ id: RecordID) -> MeetingInfo? { blocks[id]?.props.meeting }

    /// The meeting a block belongs to (the block itself, a section, a note inside it, or a transcript chunk).
    func meeting(containing id: RecordID) -> RecordID? {
        var cur: RecordID? = id
        while let c = cur, let b = blocks[c] {
            if b.type == .meeting { return b.id }
            cur = b.parent.id
            if case .database = b.parent { return nil }
        }
        return nil
    }

    /// Notes or summary section (created on demand for meetings that lack one).
    @discardableResult
    func meetingSection(_ meeting: RecordID, _ kind: MeetingSectionKind) -> RecordID {
        if let s = contentBlocks(of: meeting).first(where: { $0.type == .meetingSection && $0.props.meetingSection == kind }) {
            return s.id
        }
        var p = BlockProps(); p.meetingSection = kind
        return insertBlock(.meetingSection, props: p, in: .block(meeting), at: kind == .notes ? .start : .end, name: "Add section")
    }

    func transcriptChunks(of meeting: RecordID) -> [Block] {
        contentBlocks(of: meeting).filter { $0.type == .transcript }
    }

    /// The whole transcript, ordered by time.
    func transcript(of meeting: RecordID, includePartial: Bool = true) -> [TranscriptSegment] {
        transcriptChunks(of: meeting).flatMap { $0.props.segments ?? [] }
            .filter { includePartial || !$0.isPartial }
            .sorted(by: Transcript.order)
    }

    // MARK: Meeting info

    func updateMeeting(_ id: RecordID, name: String = "Edit meeting", undoable: Bool = true, _ f: (inout MeetingInfo) -> Void) {
        guard blocks[id]?.type == .meeting else { return }
        transact(name, undoable: undoable) { tx in
            tx.update(id) { b in
                var info = b.props.meeting ?? MeetingInfo()
                f(&info)
                b.props.meeting = info
            }
        }
    }

    func setMeetingStatus(_ id: RecordID, _ status: MeetingStatus, now: Date = Date()) {
        updateMeeting(id, name: "Meeting status", undoable: false) { m in
            if status == .recording, m.startedAt == nil { m.startedAt = now }
            if status == .processing || status == .done, m.endedAt == nil { m.endedAt = now }
            if status != .failed { m.error = nil }
            m.status = status
        }
    }

    func addMeetingTrack(_ id: RecordID, _ track: MeetingTrack) {
        updateMeeting(id, name: "Add recording", undoable: false) { m in
            m.tracks = (m.tracks ?? []) + [track]
            m.duration = max(m.duration ?? 0, track.offset + (track.duration ?? 0))
        }
    }

    // MARK: Transcript

    /// Adds or updates segments from a live recogniser. A segment whose id already exists replaces it (partial →
    /// final); new ones go to the last chunk, and a new chunk starts every `Transcript.chunkSize` segments.
    /// A segment with empty text removes the segment with its id (a partial that came to nothing).
    /// Not undoable: the recogniser, not the user, writes here.
    func appendTranscript(_ meeting: RecordID, _ incoming: [TranscriptSegment]) {
        guard !incoming.isEmpty, blocks[meeting]?.type == .meeting else { return }
        transact("Transcribe", undoable: false) { tx in
            var chunks = contentBlocks(of: meeting).filter { $0.type == .transcript }
            // Where each existing id lives. Partials only ever sit in the last chunks, so look there first.
            var location: [String: Int] = [:]
            for (ci, c) in chunks.enumerated().reversed() {
                for s in c.props.segments ?? [] where location[s.id] == nil { location[s.id] = ci }
            }
            var dirty = Set<Int>()
            for seg in incoming {
                let remove = seg.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                if let ci = location[seg.id] {
                    var segs = chunks[ci].props.segments ?? []
                    if remove { segs.removeAll { $0.id == seg.id }; location[seg.id] = nil }
                    else if let i = segs.firstIndex(where: { $0.id == seg.id }) { segs[i] = seg } else { segs.append(seg) }
                    chunks[ci].props.segments = segs
                    dirty.insert(ci)
                    continue
                }
                if remove { continue }
                if chunks.isEmpty || (chunks[chunks.count - 1].props.segments?.count ?? 0) >= Transcript.chunkSize {
                    let parent = ParentRef.block(meeting)
                    let after = chunks.last?.sortKey ?? tx.store.childBlocks(of: parent).last?.sortKey
                    var p = BlockProps(); p.segments = []
                    chunks.append(Block(type: .transcript, parent: parent, sortKey: FractionalIndex.between(after, nil),
                                        props: p, createdBy: userID))
                }
                let ci = chunks.count - 1
                chunks[ci].props.segments = (chunks[ci].props.segments ?? []) + [seg]
                location[seg.id] = ci
                dirty.insert(ci)
            }
            for ci in dirty.sorted() {
                var c = chunks[ci]
                c.props.segments?.sort(by: Transcript.order)
                if tx.block(c.id) != nil {
                    tx.update(c.id) { $0.props.segments = c.props.segments }
                } else {
                    c.updatedAt = Date()
                    tx.put(c)
                }
            }
            if let end = incoming.filter({ !$0.text.isEmpty }).map(\.end).max() {
                tx.update(meeting) { b in
                    var m = b.props.meeting ?? MeetingInfo()
                    m.duration = max(m.duration ?? 0, end)
                    b.props.meeting = m
                }
            }
        }
    }

    /// Replaces the whole transcript (the final pass after recording, or a re-transcription).
    func replaceTranscript(_ meeting: RecordID, _ segments: [TranscriptSegment], engine: String? = nil) {
        guard blocks[meeting]?.type == .meeting else { return }
        transact("Transcript") { tx in
            for c in transcriptChunks(of: meeting) { tx.removeBlock(c.id) }
            let sorted = segments.sorted(by: Transcript.order)
            let parts = stride(from: 0, to: sorted.count, by: Transcript.chunkSize).map {
                Array(sorted[$0..<min($0 + Transcript.chunkSize, sorted.count)])
            }
            let keys = tx.sortKeys(parts.count, in: .block(meeting), .end)
            for (part, key) in zip(parts, keys) {
                var p = BlockProps(); p.segments = part
                tx.put(Block(type: .transcript, parent: .block(meeting), sortKey: key, props: p, createdBy: userID))
            }
            tx.update(meeting) { b in
                var m = b.props.meeting ?? MeetingInfo()
                if let engine { m.engine = engine }
                if let end = sorted.map(\.end).max() { m.duration = max(m.duration ?? 0, end) }
                b.props.meeting = m
            }
        }
    }

    /// Rewrites segments in place (speaker fixes, text corrections). `f` returns nil to drop a segment.
    func editTranscript(_ meeting: RecordID, name: String = "Edit transcript",
                        _ f: (TranscriptSegment) -> TranscriptSegment?) {
        transact(name) { tx in
            for c in transcriptChunks(of: meeting) {
                let old = c.props.segments ?? []
                let new = old.compactMap(f)
                if new != old { tx.update(c.id) { $0.props.segments = new } }
            }
        }
    }

    func setSegmentText(_ meeting: RecordID, segment: String, text: String) {
        editTranscript(meeting, name: "Edit transcript") { s in
            guard s.id == segment else { return s }
            var t = s; t.text = text; return t
        }
    }

    /// Attributes one segment (or, with `following`, it and everything after it of the same old speaker
    /// until another speaker talks) to `speaker`.
    func setSegmentSpeaker(_ meeting: RecordID, segment: String, speaker: String) {
        editTranscript(meeting, name: "Change speaker") { s in
            guard s.id == segment else { return s }
            var t = s; t.speaker = speaker; return t
        }
    }

    /// Applies a speaker separation result: segments of `tracks` get the speaker of the overlapping turn.
    /// New speaker labels are added as "Speaker 1", "Speaker 2", …
    func applySpeakerTurns(_ meeting: RecordID, _ turns: [SpeakerTurn], tracks: Set<AudioTrackRole>? = nil) {
        let segs = Transcript.assignSpeakers(transcript(of: meeting), turns: turns, tracks: tracks)
        let byID = Dictionary(uniqueKeysWithValues: segs.map { ($0.id, $0) })
        transact("Separate speakers") { tx in
            for c in transcriptChunks(of: meeting) {
                let new = (c.props.segments ?? []).map { byID[$0.id] ?? $0 }
                if new != c.props.segments { tx.update(c.id) { $0.props.segments = new } }
            }
            tx.update(meeting) { b in
                var m = b.props.meeting ?? MeetingInfo()
                m.speakers = Self.mergedSpeakers(m.speakers ?? [], used: segs.compactMap(\.speaker))
                b.props.meeting = m
            }
        }
    }

    /// Known speakers plus a default entry for every id the transcript uses. Labels keep their first-seen
    /// order, so "Speaker 1" is whoever talked first.
    static func mergedSpeakers(_ known: [MeetingSpeaker], used: [String]) -> [MeetingSpeaker] {
        var out = known
        var seen = Set(known.map(\.id))
        let palette: [TColor] = [.blue, .orange, .green, .purple, .pink, .brown, .red, .yellow, .gray]
        var n = known.filter { $0.isMe != true }.count
        for id in used where !seen.contains(id) {
            seen.insert(id)
            if id == MeetingSpeaker.meID {
                out.insert(MeetingSpeaker(id: id, name: "Me", isMe: true, color: .default), at: 0)
                continue
            }
            n += 1
            let name = id == MeetingSpeaker.othersID ? "Others" : "Speaker \(n)"
            out.append(MeetingSpeaker(id: id, name: name, color: palette[(n - 1) % palette.count]))
        }
        return out
    }

    func renameSpeaker(_ meeting: RecordID, speaker: String, to name: String) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        updateMeeting(meeting, name: "Rename speaker") { m in
            var list = m.speakers ?? []
            if let i = list.firstIndex(where: { $0.id == speaker }) { list[i].name = clean }
            else { list.append(MeetingSpeaker(id: speaker, name: clean)) }
            m.speakers = list
        }
    }

    /// Two labels turned out to be the same person: `from` becomes `into` everywhere.
    func mergeSpeakers(_ meeting: RecordID, from: String, into: String) {
        guard from != into else { return }
        transact("Merge speakers") { tx in
            for c in transcriptChunks(of: meeting) {
                let old = c.props.segments ?? []
                let new = old.map { s -> TranscriptSegment in var t = s; if t.speaker == from { t.speaker = into }; return t }
                if new != old { tx.update(c.id) { $0.props.segments = new } }
            }
            tx.update(meeting) { b in
                var m = b.props.meeting ?? MeetingInfo()
                m.speakers?.removeAll { $0.id == from }
                b.props.meeting = m
            }
        }
    }

    // MARK: Notes

    /// Marks a note block with the recording time it was written at (click → play from there).
    func stampNote(_ id: RecordID, time: Double) {
        guard let b = blocks[id], b.props.meetingTime == nil else { return }
        transact("Note time", undoable: false) { tx in tx.update(id) { $0.props.meetingTime = time } }
    }

    // MARK: Context

    func addMeetingContext(_ meeting: RecordID, _ item: MeetingContextItem) {
        updateMeeting(meeting, name: "Add context") { m in
            if item.kind == .page, m.context?.contains(where: { $0.pageID == item.pageID }) == true { return }
            m.context = (m.context ?? []) + [item]
        }
    }

    func removeMeetingContext(_ meeting: RecordID, item: String) {
        updateMeeting(meeting, name: "Remove context") { m in m.context?.removeAll { $0.id == item } }
    }

    /// Text of everything attached as context (linked pages as Markdown), capped at `limit` characters.
    func meetingContextText(_ meeting: RecordID, limit: Int = 40_000) -> String {
        guard let info = meetingInfo(meeting) else { return "" }
        var parts: [String] = []
        if let a = info.attendees, !a.isEmpty { parts.append("Attendees: " + a.joined(separator: ", ")) }
        let exporter = MarkdownExporter(store: self)
        for item in info.context ?? [] {
            switch item.kind {
            case .page:
                guard let id = item.pageID, blocks[id] != nil else { continue }
                parts.append(exporter.export(page: id))
            case .text:
                if let t = item.text { parts.append(t) }
            case .url:
                parts.append([item.title, item.text].compactMap { $0 }.joined(separator: " — "))
            case .file:
                parts.append("File: " + (item.title ?? item.asset?.name ?? "") + (item.text.map { "\n" + $0 } ?? ""))
            }
        }
        let joined = parts.joined(separator: "\n\n")
        return joined.count > limit ? String(joined.prefix(limit)) : joined
    }

    /// Terms for the recogniser: user vocabulary, attendees, speaker names, context page titles and recurring
    /// names / acronyms from the context.
    func meetingVocabulary(_ meeting: RecordID, limit: Int = 100) -> [String] {
        guard let info = meetingInfo(meeting) else { return [] }
        var out: [String] = []
        var seen = Set<String>()
        func add(_ w: String) {
            let t = w.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty, t.count <= 60, seen.insert(t.lowercased()).inserted else { return }
            out.append(t)
        }
        (info.vocabulary ?? []).forEach(add)
        (info.attendees ?? []).forEach(add)
        (info.speakers ?? []).filter { !$0.name.hasPrefix("Speaker ") && $0.isMe != true && $0.id != MeetingSpeaker.othersID }
            .map(\.name).forEach(add)
        for item in info.context ?? [] {
            if item.kind == .page, let id = item.pageID { add(title(of: id)) }
        }
        Transcript.vocabulary(fromContext: meetingContextText(meeting)).forEach(add)
        return Array(out.prefix(limit))
    }

    // MARK: Summary

    /// Puts AI-written Markdown into the summary section (replacing what was there).
    func applyMeetingSummary(_ meeting: RecordID, markdown: String, engine: String?) {
        let section = meetingSection(meeting, .summary)
        let items = MarkdownImporter().parse(markdown)
        transact("Meeting summary") { tx in
            for b in contentBlocks(of: section) { removeSubtree(b.id, tx: tx) }
            tx.update(meeting) { b in
                var m = b.props.meeting ?? MeetingInfo()
                m.summary = .done; m.summaryEngine = engine
                b.props.meeting = m
            }
        }
        _ = insertImported(items, in: .block(section), name: "Meeting summary")
    }

    /// Plain text of the notes section, with recording times where a note was stamped.
    func meetingNotesText(_ meeting: RecordID) -> String {
        let section = meetingSection(meeting, .notes)
        return descendants(of: section).compactMap { id -> String? in
            guard let b = blocks[id], b.trashedAt == nil else { return nil }
            let t = b.text.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { return nil }
            return (b.props.meetingTime.map { "[\(Transcript.timecode($0))] " } ?? "") + t
        }.joined(separator: "\n")
    }
}

/// Builds the prompt for the AI summary. The model gets the transcript with timecodes and is asked to cite
/// them as `[m:ss]`, which the meeting view turns into play buttons.
public enum MeetingSummaryPrompt {
    public static let system = """
    You write meeting notes from a transcript. Be accurate and concise; never invent facts, names or numbers \
    that are not in the transcript or the context. Answer in the language most of the meeting was held in.
    """

    public static func build(title: String, transcript: String, notes: String, context: String,
                             instructions: String?) -> String {
        var p = "Meeting: \(title)\n\n"
        if !context.isEmpty { p += "<context>\n\(context)\n</context>\n\n" }
        if !notes.isEmpty { p += "<my_notes>\n\(notes)\n</my_notes>\n\n" }
        p += "<transcript>\n\(transcript)\n</transcript>\n\n"
        p += """
        Write the summary as Markdown with exactly these sections (translated into the meeting's language):
        ## Summary — 2–5 sentences.
        ## Key points — bullets.
        ## Decisions — bullets (omit the section if there were none).
        ## Action items — to-dos as `- [ ] Owner: task (due date if mentioned)`.
        After each bullet, cite where it was said with the transcript timecode in square brackets, e.g. [12:34].
        Treat my notes as the most important signal of what mattered. Do not include the transcript itself.
        """
        if let i = instructions?.trimmingCharacters(in: .whitespacesAndNewlines), !i.isEmpty {
            p += "\n\nAdditional instructions: \(i)"
        }
        return p
    }
}
