// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import SwiftUI
import Observation
import AVFoundation
import WatchConnectivity
import WatchKit

// BSD-66: the Apple Watch app does one thing — hold a thought. One big button records a voice note (AAC, mono,
// 32 kHz); "Dictate or type" takes a short text note. Either goes to the iPhone with `WCSession.transferFile`
// (metadata: `WatchCaptureMeta`) and waits in an outbox on the watch until the iPhone has it. On the iPhone the
// Based app (apps/mobile) turns it into a page.
// Taken over from legacy/App/watchOS/BasedWatchApp.swift; new: text notes, haptics, recording continues with the
// wrist down (background mode "audio"), the count of the day lives on the watch.

@main
struct BasedWatchApp: App {
    @State private var model = WatchCaptureModel.shared

    var body: some Scene {
        WindowGroup {
            WatchRecordView()
                .environment(model)
                // The complication and the Action Button open basedwatch://record.
                .onOpenURL { url in if url.host == "record", !model.isRecording { model.toggle() } }
        }
    }
}

struct WatchRecordView: View {
    @Environment(WatchCaptureModel.self) private var model

    var body: some View {
        VStack(spacing: 8) {
            Button { model.toggle() } label: {
                ZStack {
                    Circle().fill(model.isRecording ? Color.red : Color.accentColor)
                    VStack(spacing: 4) {
                        Image(systemName: model.isRecording ? "stop.fill" : "mic.fill").font(.system(size: 34))
                        if let start = model.startedAt {
                            Text(start, style: .timer).font(.footnote).monospacedDigit()
                        } else {
                            Text("Hold a thought").font(.footnote)
                        }
                    }
                    // Based Default: Papier und Tinte; Rot nur, solange aufgenommen wird.
                    .foregroundStyle(model.isRecording ? Color.white : Color.black)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isRecording ? "Stop and send" : "Record a thought")

            if !model.isRecording {
                TextFieldLink(prompt: Text("Note")) {
                    Label("Dictate or type", systemImage: "keyboard").font(.footnote)
                } onSubmit: { text in
                    model.keep(text: text)
                }
                .buttonStyle(.borderless)
            }

            Text(model.error ?? model.statusLine)
                .font(.caption2)
                .foregroundStyle(model.error == nil ? Color.secondary : Color.red)
                .multilineTextAlignment(.center)
                .lineLimit(2)
                .minimumScaleFactor(0.8)
        }
        .padding(.horizontal, 6)
        .onAppear { model.link.activate() }
    }
}

@MainActor
@Observable
final class WatchCaptureModel {
    static let shared = WatchCaptureModel()
    private static let countKey = "watch.dayCount"

    private(set) var isRecording = false
    private(set) var startedAt: Date?
    private(set) var waiting = 0
    private(set) var dayCount = WatchDayCount()
    private(set) var error: String?

    @ObservationIgnored let outbox: WatchOutbox
    @ObservationIgnored let link: WatchLink
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var fileURL: URL?

    var statusLine: String { watchStatusLine(today: dayCount.today(), waiting: waiting) }

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        outbox = WatchOutbox(directory: docs.appendingPathComponent("outbox"))
        link = WatchLink(outbox: outbox)
        waiting = outbox.pending.count
        if let data = UserDefaults.standard.data(forKey: Self.countKey), let saved = try? JSONDecoder().decode(WatchDayCount.self, from: data) {
            dayCount = saved
        }
        link.onDelivered = { [weak self] in
            guard let self else { return }
            self.waiting = self.outbox.pending.count
        }
    }

    func toggle() { isRecording ? stop() : start() }

    /// A dictated or typed note.
    func keep(text: String) {
        error = nil
        do {
            if try outbox.enqueue(text: text) != nil { counted() }
        } catch {
            self.error = "Couldn't keep the note: \(error.localizedDescription)"
        }
        waiting = outbox.pending.count
        link.flush()
    }

    private func counted() {
        dayCount.add()
        if let data = try? JSONEncoder().encode(dayCount) { UserDefaults.standard.set(data, forKey: Self.countKey) }
        WKInterfaceDevice.current().play(.success)
    }

    private func start() {
        error = nil
        AVAudioSession.sharedInstance().requestRecordPermission { granted in
            Task { @MainActor in
                guard granted else { self.error = "Allow the microphone for Based in Settings on your watch."; return }
                self.beginRecording()
            }
        }
    }

    private func beginRecording() {
        guard !isRecording else { return }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default, options: [])
            try session.setActive(true)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("thought-\(UUID().uuidString).m4a")
            let settings: [String: Any] = [AVFormatIDKey: Int(kAudioFormatMPEG4AAC), AVSampleRateKey: 32_000, AVNumberOfChannelsKey: 1,
                                           AVEncoderBitRateKey: 48_000]
            let r = try AVAudioRecorder(url: url, settings: settings)
            guard r.record() else { error = "Recording didn't start."; return }
            recorder = r
            fileURL = url
            startedAt = Date()
            isRecording = true
            WKInterfaceDevice.current().play(.start)
        } catch {
            self.error = "Recording failed: \(error.localizedDescription)"
        }
    }

    private func stop() {
        guard let r = recorder, let url = fileURL, let start = startedAt else { return }
        let duration = r.currentTime
        r.stop()
        recorder = nil; fileURL = nil; startedAt = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false)
        do {
            if try outbox.enqueue(recording: url, meta: WatchCaptureMeta(capturedAt: start, duration: duration)) != nil {
                counted()
            } else {
                WKInterfaceDevice.current().play(.stop)
            }
        } catch {
            self.error = "Couldn't keep the recording: \(error.localizedDescription)"
        }
        waiting = outbox.pending.count
        link.flush()
    }
}

/// The watch end of WatchConnectivity: sends the outbox and deletes what the iPhone confirmed.
final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    let outbox: WatchOutbox
    @MainActor var onDelivered: (() -> Void)?

    init(outbox: WatchOutbox) {
        self.outbox = outbox
        super.init()
    }

    func activate() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        if s.delegate == nil { s.delegate = self }
        if s.activationState == .activated { flush() } else { s.activate() }
    }

    /// Starts a transfer for every note that isn't on its way yet.
    func flush() {
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { activate(); return }
        let inFlight = Set(s.outstandingFileTransfers.compactMap { $0.file.metadata?["id"] as? String })
        for item in outbox.toSend(inFlight: inFlight) {
            s.transferFile(outbox.url(of: item), metadata: item.meta.dictionary)
            outbox.markStarted(item.meta.id)
        }
    }

    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        guard activationState == .activated else { return }
        flush()
    }

    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let id = fileTransfer.file.metadata?["id"] as? String else { return }
        if error == nil {
            outbox.markDelivered(id)
            Task { @MainActor in self.onDelivered?() }
        }
        // On error the item stays in the outbox and goes again with the next flush (next note or launch).
    }
}
