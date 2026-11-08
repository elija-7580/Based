import Foundation

// Meeting notes: a `.meeting` block records audio, transcribes it in the background and keeps
// notes, an AI summary and the transcript together (like Notion's /meet block, plus RemNote's
// click-to-play transcript and context attachments).
//
// Layout of a meeting in the block tree:
//
//   meeting (.meeting, props.meeting = MeetingInfo, text = title)
//   ├─ notes   (.meetingSection, props.meetingSection = .notes)   ← ordinary blocks the user types
//   ├─ summary (.meetingSection, props.meetingSection = .summary) ← blocks written by the AI
//   └─ transcript chunks (.transcript, props.segments = [TranscriptSegment])
//
// The transcript is split into chunks of a few dozen segments so live transcription rewrites (and
// syncs) one small record instead of the whole meeting.

public enum MeetingStatus: String, Codable, Sendable {
    /// Created, nothing recorded yet.
    case ready
    case recording
    case paused
    /// Recording stopped; the final pass (full-file transcription + speaker separation) is running.
    case processing
    case done
    case failed
}

/// Where an audio track came from. Microphone and system audio are recorded as separate tracks, which
/// already separates "me" from "the others" before any model runs.
public enum AudioTrackRole: String, Codable, Sendable, CaseIterable {
    case microphone
    case system
    /// A file the user uploaded (or a recording made on another device).
    case upload
    /// One mixed track (web recorder, phone).
    case mixed
}

public struct MeetingTrack: Codable, Hashable, Sendable {
    public var role: AudioTrackRole
    public var asset: AssetRef
    /// Seconds after the meeting start at which this track begins (tracks of one recording start together,
    /// a resumed recording appends new tracks with a later offset).
    public var offset: Double
    public var duration: Double?

    public init(role: AudioTrackRole, asset: AssetRef, offset: Double = 0, duration: Double? = nil) {
        self.role = role; self.asset = asset; self.offset = offset; self.duration = duration
    }
}

public struct MeetingSpeaker: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// The person recording (the microphone track).
    public var isMe: Bool?
    public var color: TColor?

    public init(id: String, name: String, isMe: Bool? = nil, color: TColor? = nil) {
        self.id = id; self.name = name; self.isMe = isMe; self.color = color
    }

    /// Speaker id used for the microphone track.
    public static let meID = "me"
    /// Speaker id for system audio before speaker separation has run.
    public static let othersID = "others"
}

/// Something attached to a meeting as context: it biases the transcription (names, jargon) and is given to
/// the AI when it writes the summary.
public struct MeetingContextItem: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable { case page, file, text, url }
    public var id: String
    public var kind: Kind
    /// `.page`: the page id.
    public var pageID: RecordID?
    /// `.file`: slides, PDF, document.
    public var asset: AssetRef?
    /// `.text`: a note; `.url`: the address. Files may carry their extracted text here too.
    public var text: String?
    public var title: String?

    public init(id: String = RecordIDs.make(), kind: Kind, pageID: RecordID? = nil, asset: AssetRef? = nil,
                text: String? = nil, title: String? = nil) {
        self.id = id; self.kind = kind; self.pageID = pageID; self.asset = asset; self.text = text; self.title = title
    }

    public static func page(_ id: RecordID) -> MeetingContextItem { .init(kind: .page, pageID: id) }
    public static func note(_ text: String) -> MeetingContextItem { .init(kind: .text, text: text) }
    public static func url(_ u: String, title: String? = nil) -> MeetingContextItem { .init(kind: .url, text: u, title: title) }
    public static func file(_ a: AssetRef, text: String? = nil) -> MeetingContextItem { .init(kind: .file, asset: a, text: text, title: a.name) }
}

public enum MeetingSummaryState: String, Codable, Sendable {
    /// No AI is configured (no API key, no CLI engine): the meeting keeps the transcript only.
    case unavailable
    case pending
    case running
    case done
    case failed
}

public struct MeetingInfo: Codable, Hashable, Sendable {
    public var status: MeetingStatus
    public var startedAt: Date?
    public var endedAt: Date?
    /// Recorded seconds (pauses excluded).
    public var duration: Double?
    public var tracks: [MeetingTrack]?
    public var speakers: [MeetingSpeaker]?
    public var context: [MeetingContextItem]?
    public var attendees: [String]?
    /// Extra terms typed by the user (product names, people) that the recogniser should prefer.
    public var vocabulary: [String]?
    /// BCP-47 language hint ("de-AT", "en"); nil = detect.
    public var language: String?
    /// Transcription engine that produced the current transcript ("apple.speech", "fluid.parakeet-v3", …).
    public var engine: String?
    public var summary: MeetingSummaryState?
    /// Engine / model that wrote the summary.
    public var summaryEngine: String?
    /// Extra instructions for the summary ("focus on decisions", "in German").
    public var summaryInstructions: String?
    /// Play a short notice / show a banner that this conversation is transcribed.
    public var consentNotice: Bool?
    public var error: String?

    public init(status: MeetingStatus = .ready) { self.status = status }

    public func speaker(_ id: String?) -> MeetingSpeaker? {
        guard let id else { return nil }
        return speakers?.first { $0.id == id }
    }

    public func speakerName(_ id: String?) -> String {
        guard let id else { return "Unknown" }
        if let s = speaker(id) { return s.name }
        if id == MeetingSpeaker.meID { return "Me" }
        if id == MeetingSpeaker.othersID { return "Others" }
        return id
    }
}

public enum MeetingSectionKind: String, Codable, Sendable, CaseIterable {
    case notes, summary
}

/// One recognised utterance. Times are seconds from the meeting start.
public struct TranscriptSegment: Codable, Hashable, Sendable, Identifiable {
    public var id: String
    public var start: Double
    public var end: Double
    public var speaker: String?
    public var track: AudioTrackRole?
    public var text: String
    /// Live hypothesis that may still change (replaced by id when the recogniser finalises it).
    public var partial: Bool?

    public init(id: String = RecordIDs.make(), start: Double, end: Double, speaker: String? = nil,
                track: AudioTrackRole? = nil, text: String, partial: Bool? = nil) {
        self.id = id; self.start = start; self.end = end; self.speaker = speaker; self.track = track
        self.text = text; self.partial = partial
    }

    public var isPartial: Bool { partial == true }
    public var duration: Double { max(0, end - start) }

    enum CodingKeys: String, CodingKey { case id, start = "s", end = "e", speaker = "sp", track = "tr", text = "t", partial = "p" }
}

/// Consecutive segments of one speaker, for display and export.
public struct TranscriptParagraph: Hashable, Sendable, Identifiable {
    public var id: String { segments.first?.id ?? "" }
    public var speaker: String?
    public var segments: [TranscriptSegment]
    public var start: Double { segments.first?.start ?? 0 }
    public var end: Double { segments.last?.end ?? 0 }
    public var text: String { segments.map(\.text).joined(separator: " ") }
}

/// A stretch of time attributed to one speaker by speaker separation (diarization).
public struct SpeakerTurn: Hashable, Sendable {
    public var start: Double
    public var end: Double
    public var speaker: String
    public init(start: Double, end: Double, speaker: String) { self.start = start; self.end = end; self.speaker = speaker }
}

// MARK: - Pure transcript helpers

public enum Transcript {
    /// Segments per `.transcript` chunk record.
    public static let chunkSize = 40

    /// `m:ss`, or `h:mm:ss` from one hour.
    public static func timecode(_ seconds: Double) -> String {
        let t = max(0, Int(seconds.rounded(.down)))
        let h = t / 3600, m = (t % 3600) / 60, s = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, s) : String(format: "%d:%02d", m, s)
    }

    /// Parses `12:34`, `1:02:03` or `[12:34]` into seconds.
    public static func seconds(fromTimecode s: String) -> Double? {
        let t = s.trimmingCharacters(in: CharacterSet(charactersIn: "[] "))
        let parts = t.split(separator: ":").map { Int($0) }
        guard (2...3).contains(parts.count), parts.allSatisfy({ $0 != nil }) else { return nil }
        let p = parts.map { $0! }
        guard p.dropFirst().allSatisfy({ $0 < 60 }) else { return nil }
        return Double(p.reduce(0) { $0 * 60 + $1 })
    }

    /// Timecodes like `[12:34]` in a text, with their range — the summary cites the transcript this way.
    public static func citations(in text: String) -> [(range: Range<String.Index>, seconds: Double)] {
        var out: [(Range<String.Index>, Double)] = []
        var i = text.startIndex
        while let open = text[i...].firstIndex(of: "[") {
            guard let close = text[open...].firstIndex(of: "]") else { break }
            let inner = String(text[text.index(after: open)..<close])
            if let s = seconds(fromTimecode: inner) { out.append((open..<text.index(after: close), s)) }
            i = text.index(after: open)
        }
        return out
    }

    /// Groups consecutive segments of the same speaker (a gap over `maxGap` seconds starts a new paragraph).
    public static func paragraphs(_ segments: [TranscriptSegment], maxGap: Double = 8) -> [TranscriptParagraph] {
        var out: [TranscriptParagraph] = []
        for s in segments.sorted(by: order) {
            if var last = out.last, last.speaker == s.speaker, s.start - last.end <= maxGap {
                last.segments.append(s)
                out[out.count - 1] = last
            } else {
                out.append(TranscriptParagraph(speaker: s.speaker, segments: [s]))
            }
        }
        return out
    }

    static func order(_ a: TranscriptSegment, _ b: TranscriptSegment) -> Bool {
        a.start != b.start ? a.start < b.start : a.id < b.id
    }

    /// Gives every segment the speaker whose turn overlaps it most (diarization result → transcript).
    /// Segments with no overlapping turn take the nearest turn within `snap` seconds, else keep their speaker.
    /// Only segments of `tracks` are touched (nil = all), so the microphone track can stay "me".
    public static func assignSpeakers(_ segments: [TranscriptSegment], turns: [SpeakerTurn],
                                      tracks: Set<AudioTrackRole>? = nil, snap: Double = 1.5) -> [TranscriptSegment] {
        guard !turns.isEmpty else { return segments }
        let sorted = turns.sorted { $0.start < $1.start }
        return segments.map { seg in
            if let tracks, let tr = seg.track, !tracks.contains(tr) { return seg }
            var overlap: [String: Double] = [:]
            for t in sorted where t.end > seg.start && t.start < seg.end {
                overlap[t.speaker, default: 0] += min(t.end, seg.end) - max(t.start, seg.start)
            }
            var s = seg
            if let best = overlap.max(by: { $0.value != $1.value ? $0.value < $1.value : $0.key > $1.key }) {
                s.speaker = best.key
            } else {
                let mid = (seg.start + seg.end) / 2
                let nearest = sorted.min { distance($0, mid) < distance($1, mid) }
                if let n = nearest, distance(n, mid) <= snap { s.speaker = n.speaker }
            }
            return s
        }
    }

    static func distance(_ t: SpeakerTurn, _ x: Double) -> Double {
        x < t.start ? t.start - x : (x > t.end ? x - t.end : 0)
    }

    /// Plain text for prompts and export: `[0:12] Anna: …`, one paragraph per line.
    public static func text(_ segments: [TranscriptSegment], info: MeetingInfo?, timecodes: Bool = true) -> String {
        paragraphs(segments.filter { !$0.isPartial }).map { p in
            let name = info?.speakerName(p.speaker) ?? (p.speaker ?? "Unknown")
            return (timecodes ? "[\(timecode(p.start))] " : "") + "\(name): \(p.text)"
        }.joined(separator: "\n")
    }

    /// Words worth biasing the recogniser towards: proper names, acronyms and product names that recur in
    /// the context text (capitalised words that don't start a sentence, ALL-CAPS tokens, CamelCase).
    public static func vocabulary(fromContext text: String, limit: Int = 60) -> [String] {
        var counts: [String: Int] = [:]
        var firstSeen: [String: Int] = [:]
        var sentenceStart = true
        var n = 0
        let separators = CharacterSet.whitespacesAndNewlines
        for raw in text.components(separatedBy: separators) where !raw.isEmpty {
            let endsSentence = raw.last.map { ".!?:\n".contains($0) } ?? false
            let word = raw.trimmingCharacters(in: CharacterSet.punctuationCharacters.union(.symbols))
            defer { sentenceStart = endsSentence }
            guard word.count >= 2, let first = word.unicodeScalars.first else { continue }
            let upper = word.uppercased() == word && word.rangeOfCharacter(from: .letters) != nil
            let capitalised = CharacterSet.uppercaseLetters.contains(first)
            let inner = word.dropFirst().contains { $0.isUppercase } && word.contains { $0.isLowercase }
            let keep = (upper && word.count <= 8) || inner || (capitalised && !sentenceStart)
            guard keep else { continue }
            counts[word, default: 0] += 1
            if firstSeen[word] == nil { firstSeen[word] = n; n += 1 }
        }
        // German capitalises every noun, so a single capitalised word is weak evidence; acronyms and
        // CamelCase count from the first sighting, plain capitalised words from the second.
        let picked = counts.filter { w, c in
            let strong = w.uppercased() == w || (w.dropFirst().contains { $0.isUppercase } && w.contains { $0.isLowercase })
            return strong || c >= 2
        }
        return picked.keys.sorted { (counts[$0]!, -firstSeen[$0]!) > (counts[$1]!, -firstSeen[$1]!) }
            .prefix(limit).map { $0 }
    }

    /// A recognised word with its time (seconds from the start of the audio that was transcribed).
    public struct Word: Hashable, Sendable {
        public var text: String
        public var start: Double
        public var end: Double
        public init(_ text: String, _ start: Double, _ end: Double) { self.text = text; self.start = start; self.end = end }
    }

    /// Splits recognised words into utterance segments: a pause of `pause` seconds always splits, a sentence end
    /// splits once the segment is `sentenceMin` long, and nothing grows past `maxLength`. Times are shifted by
    /// `offset` (where the track starts in the meeting).
    public static func segments(words: [Word], offset: Double = 0, speaker: String? = nil, track: AudioTrackRole? = nil,
                                pause: Double = 0.9, sentenceMin: Double = 4, maxLength: Double = 25,
                                idPrefix: String = "") -> [TranscriptSegment] {
        var out: [TranscriptSegment] = []
        var cur: [Word] = []
        func flush() {
            guard let f = cur.first, let l = cur.last else { return }
            let text = cur.map(\.text).joined(separator: " ")
                .replacingOccurrences(of: " ,", with: ",").replacingOccurrences(of: " .", with: ".")
            out.append(TranscriptSegment(id: idPrefix + String(format: "%.2f", f.start + offset), start: f.start + offset,
                                         end: l.end + offset, speaker: speaker, track: track, text: text))
            cur = []
        }
        for w in words where !w.text.trimmingCharacters(in: .whitespaces).isEmpty {
            if let last = cur.last, let first = cur.first {
                let gap = w.start - last.end
                let sentenceEnd = last.text.last.map { ".!?".contains($0) } ?? false
                if gap >= pause || (sentenceEnd && last.end - first.start >= sentenceMin) || w.end - first.start > maxLength {
                    flush()
                }
            }
            cur.append(w)
        }
        flush()
        return out
    }
}
