import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif
import BasedCore

/// The `/meet` block: record → live transcript → summary, with notes, speakers and context in one place.
struct MeetingBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var tab: Tab?
    @State private var importing = false
    @State private var renaming: MeetingSpeaker?
    @State private var newName = ""
    @State private var editingInstructions = false
    @State private var instructions = ""
    @State private var addingNote = false
    @State private var noteText = ""
    @State private var pickingPage = false
    @State private var pageQuery = ""

    enum Tab: String, CaseIterable { case summary = "Summary", notes = "Notes", transcript = "Transcript" }

    private var store: WorkspaceStore { model.store }
    private var service: MeetingService { MeetingService.shared }
    private var info: MeetingInfo { block.props.meeting ?? MeetingInfo() }
    private var recording: Bool { service.isRecording(block.id) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            controls
            if recording, info.consentNotice != false { consentBanner }
            statusLine
            contextBar
            tabs
            Divider().opacity(0.5)
            content
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.hoverFill.opacity(0.35)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Color(Theme.divider)))
        .fileImporter(isPresented: $importing, allowedContentTypes: [.audio, .movie]) { result in
            if case .success(let url) = result {
                Task { await service.importAudio(block.id, url: url, model: model) }
            }
        }
        .alert("Rename speaker", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } })) {
            TextField("Name", text: $newName)
            Button("Save") {
                if let s = renaming {
                    store.renameSpeaker(block.id, speaker: s.id, to: newName)
                    service.speakerRenamed(block.id, speaker: s.id, to: newName, model: model)
                }
                renaming = nil
            }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
        .alert("Summary instructions", isPresented: $editingInstructions) {
            TextField("e.g. focus on decisions, answer in German", text: $instructions)
            Button("Save") { store.updateMeeting(block.id, name: "Summary instructions") { $0.summaryInstructions = instructions } }
            Button("Cancel", role: .cancel) {}
        }
        .alert("Add context note", isPresented: $addingNote) {
            TextField("Agenda, names, background…", text: $noteText)
            Button("Add") {
                let t = noteText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !t.isEmpty { store.addMeetingContext(block.id, .note(t)) }
                noteText = ""
            }
            Button("Cancel", role: .cancel) { noteText = "" }
        }
        .popover(isPresented: $pickingPage) { pagePicker }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: recording ? "waveform" : "waveform.and.mic")
                .foregroundStyle(recording ? Color.red : Theme.secondary)
            TextField("Meeting notes", text: Binding(
                get: { block.text.plainText },
                set: { v in store.updateBlock(block.id, name: "Rename meeting", coalesce: "meeting-title-\(block.id)") { $0.text = RichText(v) } }))
                .textFieldStyle(.plain)
                .font(.system(size: 17, weight: .semibold))
                .disabled(editor.isLocked)
            Spacer()
            menu
        }
    }

    private var menu: some View {
        Menu {
            Button("Upload a recording…", systemImage: "square.and.arrow.down") { importing = true }
            Button("Transcribe again", systemImage: "arrow.clockwise") {
                Task { await service.finalize(block.id, model: model) }
            }.disabled(info.tracks?.isEmpty != false || service.processing.contains(block.id))
            Divider()
            Button(model.brain.hasEngine ? "Generate summary" : "Summary needs an AI (Settings → AI)", systemImage: "sparkles") {
                Task { await service.summarize(block.id, model: model) }
            }.disabled(!model.brain.hasEngine || service.summarizing.contains(block.id))
            Button("Summary instructions…", systemImage: "text.quote") {
                instructions = info.summaryInstructions ?? ""; editingInstructions = true
            }
            Divider()
            Picker("Language", selection: Binding(get: { info.language ?? "" },
                                                  set: { v in store.updateMeeting(block.id, name: "Meeting language") { $0.language = v.isEmpty ? nil : v } })) {
                Text("Detect automatically").tag("")
                ForEach(Self.languages, id: \.0) { code, name in Text(name).tag(code) }
            }
            Toggle("Show transcription notice", isOn: Binding(get: { info.consentNotice != false },
                                                               set: { v in store.updateMeeting(block.id, name: "Notice") { $0.consentNotice = v } }))
            Divider()
            Button("Copy transcript", systemImage: "doc.on.doc") { copyTranscript() }
        } label: {
            Image(systemName: "ellipsis").frame(width: 24, height: 24)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
    }

    static let languages = [("de", "Deutsch"), ("en", "English"), ("fr", "Français"), ("it", "Italiano"), ("es", "Español"),
                            ("nl", "Nederlands"), ("pl", "Polski"), ("pt", "Português"), ("cs", "Čeština"), ("hu", "Magyar")]

    // MARK: Recording controls

    private var controls: some View {
        HStack(spacing: 8) {
            if recording {
                Button { service.togglePause(model: model) } label: {
                    Label(service.session?.paused == true ? "Resume" : "Pause",
                          systemImage: service.session?.paused == true ? "play.fill" : "pause.fill")
                }
                .buttonStyle(.bordered)
                Button { Task { await service.stop(model: model) } } label: { Label("Stop", systemImage: "stop.fill") }
                    .buttonStyle(.borderedProminent).tint(.red)
                Text(Transcript.timecode(service.elapsed)).monospacedDigit().foregroundStyle(Theme.secondary)
                LevelMeter(level: service.micLevel).help("Microphone")
                #if os(macOS)
                LevelMeter(level: service.systemLevel).help("System audio (other participants)")
                #endif
            } else {
                Button {
                    tab = .notes
                    Task { await service.start(block.id, model: model) }
                } label: {
                    Label((info.tracks?.isEmpty ?? true) ? "Start transcribing" : "Continue recording", systemImage: "record.circle")
                }
                .buttonStyle(.borderedProminent).tint(Theme.accentBlue)
                .disabled(service.session != nil || editor.isLocked)
                .help(service.session != nil ? "Another meeting is recording" : "Records your microphone and the computer's audio")
                if service.player.isPlaying && service.player.meetingID == block.id {
                    Button { service.player.stop() } label: { Label(Transcript.timecode(service.player.position), systemImage: "stop.circle") }
                        .buttonStyle(.bordered)
                }
            }
            Spacer()
        }
    }

    private var consentBanner: some View {
        Label("Let everyone know this conversation is being transcribed.", systemImage: "info.circle")
            .font(.caption).foregroundStyle(Theme.secondary)
    }

    @ViewBuilder
    private var statusLine: some View {
        let parts: [String] = [
            info.startedAt.map { $0.formatted(date: .abbreviated, time: .shortened) },
            info.duration.flatMap { $0 > 0 ? Transcript.timecode($0) : nil },
            speakerCount > 0 ? "\(speakerCount) speaker\(speakerCount == 1 ? "" : "s")" : nil,
        ].compactMap { $0 }
        HStack(spacing: 8) {
            if !parts.isEmpty { Text(parts.joined(separator: " · ")).foregroundStyle(Theme.secondary) }
            switch service.modelState {
            case .loading(let p) where recording || service.processing.contains(block.id):
                ProgressView(value: p).frame(width: 80)
                Text("Downloading speech model (once)…").foregroundStyle(Theme.secondary)
            default: EmptyView()
            }
            if service.processing.contains(block.id) {
                ProgressView().controlSize(.small)
                Text("Transcribing and separating speakers…").foregroundStyle(Theme.secondary)
            } else if service.summarizing.contains(block.id) {
                ProgressView().controlSize(.small)
                Text("Writing summary…").foregroundStyle(Theme.secondary)
            }
            if let e = info.error ?? (service.isRecording(block.id) ? service.lastError : nil) {
                Label(e, systemImage: "exclamationmark.triangle").foregroundStyle(.orange).lineLimit(2)
            }
        }
        .font(.system(size: 12))
    }

    private var speakerCount: Int {
        Set(store.transcript(of: block.id, includePartial: false).compactMap(\.speaker)).count
    }

    // MARK: Context

    private var contextBar: some View {
        HStack(spacing: 6) {
            ForEach(info.context ?? []) { item in
                HStack(spacing: 4) {
                    Image(systemName: Self.symbol(item.kind)).font(.system(size: 10))
                    Text(label(item)).lineLimit(1)
                    Button { store.removeMeetingContext(block.id, item: item.id) } label: { Image(systemName: "xmark").font(.system(size: 9)) }
                        .buttonStyle(.plain)
                }
                .font(.system(size: 12))
                .padding(.horizontal, 7).padding(.vertical, 3)
                .background(Capsule().fill(Theme.hoverFill))
                .onTapGesture { if let p = item.pageID { model.open(p) } }
            }
            Menu {
                Button("Link a page…", systemImage: "doc") { pageQuery = ""; pickingPage = true }
                Button("Add a note…", systemImage: "text.alignleft") { addingNote = true }
            } label: {
                Label((info.context ?? []).isEmpty ? "Add context" : "Add", systemImage: "plus").font(.system(size: 12))
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Slides, agenda, people: improves names in the transcript and the summary")
            Spacer()
        }
    }

    private func label(_ item: MeetingContextItem) -> String {
        switch item.kind {
        case .page: return item.pageID.map { store.title(of: $0) } ?? "Page"
        case .text: return String((item.text ?? "").prefix(40))
        case .url, .file: return item.title ?? item.text ?? "Item"
        }
    }

    static func symbol(_ k: MeetingContextItem.Kind) -> String {
        switch k { case .page: return "doc"; case .text: return "text.alignleft"; case .url: return "link"; case .file: return "paperclip" }
    }

    private var pagePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("Search pages…", text: $pageQuery).textFieldStyle(.roundedBorder)
            let q = pageQuery.lowercased()
            let pages = store.blocks.values
                .filter { $0.type.isPageLike && $0.trashedAt == nil && $0.id != editor.pageID }
                .filter { q.isEmpty || $0.title.lowercased().contains(q) }
                .sorted { $0.updatedAt > $1.updatedAt }
                .prefix(12)
            ForEach(Array(pages), id: \.id) { p in
                Button {
                    store.addMeetingContext(block.id, .page(p.id))
                    pickingPage = false
                } label: {
                    HStack { PageIconView(icon: p.props.icon, size: 14); Text(store.title(of: p.id)).lineLimit(1); Spacer() }
                }
                .buttonStyle(.hoverFill)
            }
        }
        .padding(10)
        .frame(width: 280)
    }

    // MARK: Tabs

    private var currentTab: Tab {
        if let tab { return tab }
        if recording { return .notes }
        if let summary = existingSection(.summary), !store.contentBlocks(of: summary).isEmpty { return .summary }
        return store.transcriptChunks(of: block.id).isEmpty ? .notes : .transcript
    }

    private var tabs: some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button { tab = t } label: {
                    Text(t.rawValue).font(.system(size: 13, weight: currentTab == t ? .semibold : .regular))
                        .foregroundStyle(currentTab == t ? Theme.primary : Theme.secondary)
                        .padding(.horizontal, 8).padding(.vertical, 4)
                }
                .buttonStyle(.quiet(selected: currentTab == t))
            }
            Spacer()
        }
    }

    @ViewBuilder
    private var content: some View {
        switch currentTab {
        case .summary: summaryTab
        case .notes: notesTab
        case .transcript: transcriptTab
        }
    }

    // MARK: Summary

    @ViewBuilder
    private var summaryTab: some View {
        let section = existingSection(.summary)
        let blocks = section.map { store.contentBlocks(of: $0) } ?? []
        if let section, !blocks.isEmpty {
            ChildBlocks(id: section, editor: editor)
            let cited = citations(in: section)
            if !cited.isEmpty {
                HStack(spacing: 4) {
                    Text("Jump to:").font(.caption).foregroundStyle(Theme.secondary)
                    ForEach(cited, id: \.self) { t in timeButton(t) }
                }
            }
            if let engine = info.summaryEngine {
                Text("Written by \(engine)").font(.caption2).foregroundStyle(Theme.secondary)
            }
        } else if info.summary == .unavailable || !model.brain.hasEngine {
            Text("Connect an AI under Settings → AI (an API key, a local model or Claude Code / Codex) to get summaries and action items. Transcription works without it, on this device.")
                .font(.system(size: 13)).foregroundStyle(Theme.secondary)
        } else if service.summarizing.contains(block.id) {
            ProgressView("Writing summary…").controlSize(.small)
        } else {
            Button("Generate summary", systemImage: "sparkles") { Task { await service.summarize(block.id, model: model) } }
                .disabled(store.transcriptChunks(of: block.id).isEmpty && store.meetingNotesText(block.id).isEmpty)
        }
    }

    private func citations(in section: RecordID) -> [Double] {
        var out = Set<Double>()
        for id in store.descendants(of: section) {
            guard let t = store.blocks[id]?.text.plainText else { continue }
            for c in Transcript.citations(in: t) { out.insert(c.seconds) }
        }
        return out.sorted().prefix(16).map { $0 }
    }

    // MARK: Notes

    @ViewBuilder
    private var notesTab: some View {
        let existing = existingSection(.notes)
        if let section = existing, !store.contentBlocks(of: section).isEmpty {
            notesList(section)
        } else {
            Button {
                let section = existing ?? store.meetingSection(block.id, .notes)
                let id = store.insertBlock(.text, in: .block(section))
                editor.focus(FocusTarget(id, 0))
            } label: {
                Text(recording ? "Type notes — each one is linked to the moment in the recording" : "Add notes…")
                    .foregroundStyle(Theme.secondary).frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .disabled(editor.isLocked)
        }
    }

    @ViewBuilder
    private func notesList(_ section: RecordID) -> some View {
        ChildBlocks(id: section, editor: editor)
        let stamped = store.descendants(of: section).compactMap { store.blocks[$0] }
                .filter { $0.props.meetingTime != nil && !$0.text.isEmpty }
                .sorted { ($0.props.meetingTime ?? 0) < ($1.props.meetingTime ?? 0) }
            if !stamped.isEmpty, !(info.tracks ?? []).isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("In the recording").font(.caption).foregroundStyle(Theme.secondary)
                    ForEach(stamped, id: \.id) { b in
                        HStack(spacing: 6) {
                            timeButton(b.props.meetingTime ?? 0)
                            Text(b.text.plainText).font(.system(size: 12)).lineLimit(1).foregroundStyle(Theme.secondary)
                        }
                    }
                }
                .padding(.top, 6)
            }
    }

    private func existingSection(_ kind: MeetingSectionKind) -> RecordID? {
        store.contentBlocks(of: block.id).first { $0.props.meetingSection == kind }?.id
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcriptTab: some View {
        let segments = store.transcript(of: block.id)
        if segments.isEmpty {
            Text(recording ? "Listening… text appears after the first sentence."
                 : "No transcript yet. Start transcribing, or upload a recording from the ••• menu.")
                .font(.system(size: 13)).foregroundStyle(Theme.secondary)
        } else {
            speakerLegend
            LazyVStack(alignment: .leading, spacing: 10) {
                ForEach(Transcript.paragraphs(segments)) { p in paragraph(p) }
            }
        }
    }

    private var speakerLegend: some View {
        HStack(spacing: 6) {
            ForEach(info.speakers ?? []) { s in
                Menu {
                    Button("Rename…") { newName = s.name; renaming = s }
                    let others = (info.speakers ?? []).filter { $0.id != s.id }
                    if !others.isEmpty {
                        Menu("Same person as") {
                            ForEach(others) { o in Button(o.name) { store.mergeSpeakers(block.id, from: s.id, into: o.id) } }
                        }
                    }
                } label: {
                    Text(s.name).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(color(s))
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Capsule().fill(color(s).opacity(0.12)))
                }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            }
            Spacer()
        }
    }

    private func paragraph(_ p: TranscriptParagraph) -> some View {
        let speaker = info.speaker(p.speaker)
        let partial = p.segments.contains(where: \.isPartial)
        return VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(info.speakerName(p.speaker)).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(speaker.map(color) ?? Theme.secondary)
                timeButton(p.start)
            }
            Text(p.text)
                .font(.system(size: 14))
                .foregroundStyle(partial ? Theme.secondary : Theme.primary)
                .italic(partial)
                .textSelection(.enabled)
                .contextMenu {
                    ForEach(info.speakers ?? []) { s in
                        Button("Said by \(s.name)") {
                            for seg in p.segments { store.setSegmentSpeaker(block.id, segment: seg.id, speaker: s.id) }
                        }
                    }
                }
        }
    }

    private func timeButton(_ t: Double) -> some View {
        Button { service.play(block.id, at: t, model: model) } label: {
            Text(Transcript.timecode(t)).font(.system(size: 11).monospacedDigit()).foregroundStyle(Theme.accentBlue)
        }
        .buttonStyle(.plain)
        .clickableCursor()
        .disabled(info.tracks?.isEmpty != false)
        .help("Play from here")
    }

    private func color(_ s: MeetingSpeaker) -> Color {
        guard let c = s.color, c != .default else { return Theme.primary }
        return Theme.color(c)
    }

    private func copyTranscript() {
        let text = Transcript.text(store.transcript(of: block.id, includePartial: false), info: info)
        #if os(macOS)
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #else
        UIPasteboard.general.string = text
        #endif
    }
}

/// A thin live level bar.
struct LevelMeter: View {
    let level: Float
    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Theme.hoverFill)
                Capsule().fill(Color.green.opacity(0.8))
                    .frame(width: g.size.width * CGFloat(min(1, sqrt(Double(level)) * 1.4)))
            }
        }
        .frame(width: 44, height: 5)
        .animation(.linear(duration: 0.15), value: level)
    }
}
