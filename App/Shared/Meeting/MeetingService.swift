import Foundation
import Observation
import AVFoundation
import BasedCore

/// Runs meeting recordings: capture → live transcript → (stop) final pass with speaker separation → AI summary
/// when an engine is set up. One recording at a time per device; it keeps running while the user moves around
/// the app (and, on iPhone, in the background).
@MainActor @Observable
final class MeetingService {
    static let shared = MeetingService()

    struct Session {
        let meetingID: RecordID
        let startedAt: Date
        /// Meeting time at which this recording's tracks start (after earlier recordings of the same meeting).
        let baseOffset: Double
        var paused = false
        let writers: [TrackWriter]
        let transcribers: [LiveTrackTranscriber]
        let stopCaptures: () -> Void
    }

    private(set) var session: Session?
    /// Recorded seconds of the running session, in meeting time.
    private(set) var elapsed: Double = 0
    private(set) var micLevel: Float = 0
    private(set) var systemLevel: Float = 0
    private(set) var modelState: SpeechModelState = .notLoaded
    private(set) var processing: Set<RecordID> = []
    private(set) var summarizing: Set<RecordID> = []
    private(set) var lastError: String?
    let player = MeetingPlayer()

    @ObservationIgnored private var ticker: Timer?
    @ObservationIgnored private var noteObserver: ObservationToken?

    func isRecording(_ id: RecordID) -> Bool { session?.meetingID == id }

    /// Current position in the meeting timeline (while recording).
    var now: Double { elapsed }

    // MARK: Recording

    func start(_ meetingID: RecordID, model: AppModel) async {
        guard session == nil, let info = model.store.meetingInfo(meetingID) else { return }
        lastError = nil
        guard await MicrophoneCapture.requestPermission() else {
            fail(meetingID, model: model, "Microphone access is off. Allow Based under System Settings → Privacy & Security → Microphone.")
            return
        }
        loadModelInBackground()

        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("based-meeting-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let base = info.duration ?? 0
        let language = info.language
        let store = model.store
        let emit: @MainActor ([TranscriptSegment]) -> Void = { [weak store] segs in store?.appendTranscript(meetingID, segs) }

        var writers: [TrackWriter] = []
        var transcribers: [LiveTrackTranscriber] = []
        var stops: [() -> Void] = []
        do {
            #if os(macOS)
            let capturesSystem = true
            #else
            let capturesSystem = false
            #endif
            // Mic: "me" when the other side comes from system audio; in a room (phone) everyone is on the mic,
            // so the speakers are left to the final pass.
            let mic = try TrackWriter(role: .microphone, url: dir.appendingPathComponent("microphone.m4a"))
            let micLive = LiveTrackTranscriber(track: .microphone, speaker: capturesSystem ? MeetingSpeaker.meID : nil,
                                               offset: base, language: language, emit: emit)
            mic.onSamples = { samples, _ in micLive.append(samples) }
            let micCapture = MicrophoneCapture(writer: mic)
            try micCapture.start()
            writers.append(mic); transcribers.append(micLive); stops.append { micCapture.stop() }

            #if os(macOS)
            do {
                let sys = try TrackWriter(role: .system, url: dir.appendingPathComponent("system.m4a"))
                let sysLive = LiveTrackTranscriber(track: .system, speaker: MeetingSpeaker.othersID, offset: base,
                                                   language: language, emit: emit)
                sys.onSamples = { samples, _ in sysLive.append(samples) }
                let sysCapture = SystemAudioCapture(writer: sys)
                try sysCapture.start()
                writers.append(sys); transcribers.append(sysLive); stops.append { sysCapture.stop() }
            } catch {
                // Microphone-only still works (in-person meeting, or permission denied).
                lastError = error.localizedDescription
            }
            #endif
        } catch {
            stops.forEach { $0() }
            fail(meetingID, model: model, error.localizedDescription)
            return
        }

        let all = stops
        session = Session(meetingID: meetingID, startedAt: Date(), baseOffset: base, writers: writers,
                          transcribers: transcribers, stopCaptures: { all.forEach { $0() } })
        elapsed = base
        store.updateMeeting(meetingID, name: "Start recording", undoable: false) { m in
            if m.speakers == nil || m.speakers?.isEmpty == true, writers.count > 1 {
                m.speakers = [MeetingSpeaker(id: MeetingSpeaker.meID, name: "Me", isMe: true, color: .default),
                              MeetingSpeaker(id: MeetingSpeaker.othersID, name: "Others", color: .blue)]
            }
            if m.summary == nil { m.summary = model.brain.hasEngine ? .pending : .unavailable }
        }
        store.setMeetingStatus(meetingID, .recording)
        ticker = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
        // Notes typed while recording get the recording time (click → play from there, cited in the summary).
        noteObserver = store.observe { [weak self] change in
            let ids = change.blockIDs
            // After the current transaction has finished notifying.
            Task { @MainActor in self?.stampNotes(ids, store: store) }
        }
    }

    private func stampNotes(_ ids: [RecordID], store: WorkspaceStore) {
        guard let s = session, !s.paused else { return }
        for id in ids {
            guard let b = store.blocks[id], b.props.meetingTime == nil, b.createdAt >= s.startedAt,
                  b.type.isTextEditable, !b.text.isEmpty,
                  store.meeting(containing: id) == s.meetingID else { continue }
            store.stampNote(id, time: elapsed)
        }
    }

    func togglePause(model: AppModel) {
        guard var s = session else { return }
        s.paused.toggle()
        for w in s.writers { w.setPaused(s.paused) }
        session = s
        model.store.setMeetingStatus(s.meetingID, s.paused ? .paused : .recording)
    }

    func stop(model: AppModel) async {
        guard let s = session else { return }
        session = nil
        ticker?.invalidate(); ticker = nil
        noteObserver = nil
        micLevel = 0; systemLevel = 0
        s.stopCaptures()
        for t in s.transcribers { t.finish() }
        for t in s.transcribers { await t.drain() }

        let store = model.store
        for w in s.writers where w.samplesWritten > 0 {
            do {
                let ref = try model.assets.importFile(at: w.url)
                store.addMeetingTrack(s.meetingID, MeetingTrack(role: w.role, asset: ref, offset: s.baseOffset, duration: w.seconds))
            } catch {
                lastError = "Couldn't save the recording: \(error.localizedDescription)"
            }
        }
        try? FileManager.default.removeItem(at: s.writers.first?.url.deletingLastPathComponent() ?? URL(fileURLWithPath: "/nonexistent"))
        store.setMeetingStatus(s.meetingID, .processing)
        await finalize(s.meetingID, model: model)
    }

    private func tick() {
        guard let s = session, let clock = s.writers.first else { return }
        elapsed = s.baseOffset + clock.seconds
        micLevel = s.writers.first { $0.role == .microphone }?.level ?? 0
        systemLevel = s.writers.first { $0.role == .system }?.level ?? 0
    }

    private func fail(_ meetingID: RecordID, model: AppModel, _ message: String) {
        lastError = message
        model.store.updateMeeting(meetingID, name: "Meeting error", undoable: false) { $0.error = message }
    }

    func loadModelInBackground() {
        guard modelState == .notLoaded || { if case .failed = modelState { return true }; return false }() else { return }
        guard SpeechEngine.isAvailable else { modelState = .failed("On-device transcription isn't part of this build."); return }
        modelState = .loading(0)
        Task {
            do {
                try await SpeechEngine.shared.prepare { p in Task { @MainActor in MeetingService.shared.setLoading(p) } }
                modelState = .ready
            } catch {
                modelState = .failed(error.localizedDescription)
            }
        }
    }

    private func setLoading(_ p: Double) { if case .loading = modelState { modelState = .loading(p) } }

    // MARK: Upload

    /// A recording made elsewhere (phone, Zoom export): added as a track after what's there, then transcribed.
    func importAudio(_ meetingID: RecordID, url: URL, model: AppModel) async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let info = model.store.meetingInfo(meetingID) else { return }
        do {
            let ref = try model.assets.importFile(at: url)
            let duration = (try? await SpeechEngine.audioDuration(url)) ?? nil
            model.store.addMeetingTrack(meetingID, MeetingTrack(role: .upload, asset: ref, offset: info.duration ?? 0, duration: duration))
            model.store.setMeetingStatus(meetingID, .processing)
            await finalize(meetingID, model: model)
        } catch {
            fail(meetingID, model: model, error.localizedDescription)
        }
    }

    // MARK: Voice profiles (opt-in, this device only)

    @ObservationIgnored private var voiceStore: VoiceProfileStore?

    /// Voice profiles live in this device's local database (never synced), next to the workspace.
    func voices(_ model: AppModel) -> VoiceProfileStore {
        if let voiceStore, voiceStore.persistence === model.store.persistence { return voiceStore }
        let s = VoiceProfileStore(persistence: model.store.persistence)
        voiceStore = s
        return s
    }

    private var remembersVoices: Bool { UserDefaults.standard.bool(forKey: Prefs.meetingRememberVoices) }

    /// After the final pass: label speakers whose voice is known. Speakers the user already named keep their name.
    private func recogniseVoices(_ meetingID: RecordID, _ samples: [VoiceSample], model: AppModel) {
        guard remembersVoices, !samples.isEmpty else { return }
        let found = voices(model).recognise(meeting: meetingID, samples: samples)
        guard !found.isEmpty else { return }
        model.store.updateMeeting(meetingID, name: "Recognised speakers", undoable: false) { m in
            m.speakers = (m.speakers ?? []).map { s in
                guard let p = found[s.id], s.name.hasPrefix("Speaker ") else { return s }
                var named = s; named.name = p.name; return named
            }
        }
    }

    /// The user named a speaker: teach that voice (only when the feature is on).
    func speakerRenamed(_ meetingID: RecordID, speaker: String, to name: String, model: AppModel) {
        guard remembersVoices else { return }
        voices(model).learn(meeting: meetingID, speaker: speaker, name: name)
    }

    // MARK: Final pass

    /// Re-transcribes every track from its file and separates the speakers, replacing the live transcript.
    /// Microphone + system recordings: mic = me, the system track is diarized. Mic-only or uploaded audio:
    /// the whole track is diarized (everyone was in the room).
    func finalize(_ meetingID: RecordID, model: AppModel) async {
        let store = model.store
        guard let info = store.meetingInfo(meetingID), let tracks = info.tracks, !tracks.isEmpty, !processing.contains(meetingID) else {
            store.setMeetingStatus(meetingID, .done)
            return
        }
        processing.insert(meetingID)
        defer { processing.remove(meetingID) }
        loadModelInBackground()

        var segments: [TranscriptSegment] = []
        var voiceSamples: [VoiceSample] = []
        var failure: String?
        let sessions = Dictionary(grouping: tracks.enumerated(), by: { $0.element.offset })
        for (_, group) in sessions.sorted(by: { $0.key < $1.key }) {
            let hasSystem = group.contains { $0.element.role == .system }
            for (index, track) in group {
                guard let url = model.assets.url(for: track.asset) else { continue }
                do {
                    let words = try await SpeechEngine.shared.words(file: url, language: info.language)
                    let fixedSpeaker: String? = hasSystem && track.role == .microphone ? MeetingSpeaker.meID : nil
                    var segs = Transcript.segments(words: words, offset: track.offset, speaker: fixedSpeaker,
                                                   track: track.role, idPrefix: "t\(index)-")
                    if fixedSpeaker == nil {
                        // Diarization failing (too short, model missing) still leaves a usable transcript.
                        let separated = (try? await SpeechEngine.shared.speakerSeparation(file: url)) ?? (turns: [], voices: [])
                        let shifted = separated.turns.map { SpeakerTurn(start: $0.start + track.offset, end: $0.end + track.offset,
                                                                        speaker: "t\(index)-\($0.speaker)") }
                        voiceSamples += separated.voices.map { var v = $0; v.speaker = "t\(index)-\(v.speaker)"; return v }
                        segs = Transcript.assignSpeakers(segs, turns: shifted)
                        if shifted.isEmpty && track.role == .system {
                            segs = segs.map { var s = $0; s.speaker = MeetingSpeaker.othersID; return s }
                        }
                    }
                    segments += segs
                } catch {
                    failure = error.localizedDescription
                }
            }
        }

        if segments.isEmpty, let failure {
            store.updateMeeting(meetingID, name: "Transcription failed", undoable: false) { $0.error = failure }
            store.setMeetingStatus(meetingID, .failed)
            return
        }
        store.replaceTranscript(meetingID, segments, engine: SpeechEngine.engineID)
        store.updateMeeting(meetingID, name: "Speakers", undoable: false) { m in
            m.speakers = WorkspaceStore.mergedSpeakers(m.speakers ?? [], used: segments.sorted { $0.start < $1.start }.compactMap(\.speaker))
            m.error = failure
        }
        recogniseVoices(meetingID, voiceSamples, model: model)
        store.setMeetingStatus(meetingID, .done)

        if model.brain.hasEngine, store.meetingInfo(meetingID)?.summary != .done {
            await summarize(meetingID, model: model)
        } else if !model.brain.hasEngine {
            store.updateMeeting(meetingID, name: "Summary", undoable: false) { $0.summary = .unavailable }
        }
    }

    // MARK: Summary

    func summarize(_ meetingID: RecordID, model: AppModel) async {
        let store = model.store
        guard let block = store.blocks[meetingID], let info = block.props.meeting, !summarizing.contains(meetingID) else { return }
        guard model.brain.hasEngine else {
            store.updateMeeting(meetingID, name: "Summary", undoable: false) { $0.summary = .unavailable }
            return
        }
        let transcript = Transcript.text(store.transcript(of: meetingID, includePartial: false), info: info)
        let notes = store.meetingNotesText(meetingID)
        guard !transcript.isEmpty || !notes.isEmpty else { return }
        summarizing.insert(meetingID)
        defer { summarizing.remove(meetingID) }
        store.updateMeeting(meetingID, name: "Summary", undoable: false) { $0.summary = .running }

        var context = store.meetingContextText(meetingID, limit: 24_000)
        let vocabulary = store.meetingVocabulary(meetingID, limit: 60)
        if !vocabulary.isEmpty {
            context += "\n\nCorrect spellings of names and terms (the transcript may have misheard them): " + vocabulary.joined(separator: ", ")
        }
        // Keep the prompt inside small context windows: the start and end of very long transcripts matter most.
        let maxTranscript = 120_000
        let clipped = transcript.count > maxTranscript
            ? String(transcript.prefix(maxTranscript / 2)) + "\n[…]\n" + String(transcript.suffix(maxTranscript / 2))
            : transcript
        let prompt = MeetingSummaryPrompt.build(title: block.text.plainText, transcript: clipped, notes: notes,
                                                context: context, instructions: info.summaryInstructions)
        do {
            let md = try await model.brain.complete(system: MeetingSummaryPrompt.system, prompt: prompt)
            store.applyMeetingSummary(meetingID, markdown: Self.stripFence(md), engine: model.brain.chatEngine)
        } catch {
            store.updateMeeting(meetingID, name: "Summary", undoable: false) { m in
                m.summary = .failed; m.error = "Summary failed: \(error.localizedDescription)"
            }
        }
    }

    /// Models sometimes wrap the whole answer in ```markdown fences.
    static func stripFence(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if t.hasPrefix("```") {
            if let nl = t.firstIndex(of: "\n") { t = String(t[t.index(after: nl)...]) }
            if t.hasSuffix("```") { t = String(t.dropLast(3)) }
        }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: Playback

    func play(_ meetingID: RecordID, at seconds: Double, model: AppModel) {
        guard let tracks = model.store.meetingInfo(meetingID)?.tracks, !tracks.isEmpty else { return }
        player.play(meeting: meetingID, tracks: tracks, from: seconds, assets: model.assets)
    }
}

extension SpeechEngine {
    /// Length of an audio file in seconds.
    nonisolated static func audioDuration(_ url: URL) async throws -> Double? {
        let file = try AVAudioFile(forReading: url)
        return Double(file.length) / file.processingFormat.sampleRate
    }
}
