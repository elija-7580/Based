import SwiftUI
import Observation
import AVFoundation
import WatchConnectivity

// BSD-66: the Apple Watch app does one thing — hold a thought. One big button records a voice note (AAC, mono,
// 32 kHz); the note goes to the iPhone with `WCSession.transferFile` (metadata: `WatchCaptureMeta`) and waits in an
// outbox on the watch until the iPhone has it. The iPhone files it in Captures and transcribes it.
// Compiled only into the Based-watchOS target (project.yml), together with
// Packages/BasedCore/Sources/BasedCore/Watch/WatchCaptureTransfer.swift (no BasedCore dependency on the watch).

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
        VStack(spacing: 10) {
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
                    .foregroundStyle(.white)
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isRecording ? "Stop and send" : "Record a thought")
            Text(model.error ?? model.status.line)
                .font(.footnote)
                .foregroundStyle(model.error == nil ? Color.secondary : Color.red)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 6)
        .onAppear { model.link.activate() }
    }
}

@MainActor
@Observable
final class WatchCaptureModel {
    static let shared = WatchCaptureModel()

    private(set) var isRecording = false
    private(set) var startedAt: Date?
    var status = WatchStatus(capturedToday: 0, sortTime: nil)
    private(set) var error: String?

    @ObservationIgnored let outbox: WatchOutbox
    @ObservationIgnored let link: WatchLink
    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var fileURL: URL?

    init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        outbox = WatchOutbox(directory: docs.appendingPathComponent("outbox"))
        link = WatchLink(outbox: outbox)
        status.waiting = outbox.pending.count
        link.onStatus = { [weak self] s in
            guard let self else { return }
            var s = s
            s.waiting = self.outbox.pending.count
            self.status = s
        }
        link.onDelivered = { [weak self] in
            guard let self else { return }
            self.status.waiting = self.outbox.pending.count
        }
    }

    func toggle() { isRecording ? stop() : start() }

    private func start() {
        error = nil
        let session = AVAudioSession.sharedInstance()
        session.requestRecordPermission { granted in
            Task { @MainActor in
                guard granted else { self.error = "Allow the microphone for Based in the Watch app on your iPhone."; return }
                self.beginRecording()
            }
        }
    }

    private func beginRecording() {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, options: [])
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
                status.capturedToday += 1
            }
        } catch {
            self.error = "Couldn't keep the recording: \(error.localizedDescription)"
        }
        status.waiting = outbox.pending.count
        link.flush()
    }
}

/// The watch end of WatchConnectivity: sends the outbox, deletes what the iPhone confirmed, receives the status.
final class WatchLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    let outbox: WatchOutbox
    @MainActor var onStatus: ((WatchStatus) -> Void)?
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

    /// Starts a transfer for every recording that isn't on its way yet.
    func flush() {
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
        let context = session.receivedApplicationContext
        Task { @MainActor in
            if !context.isEmpty { self.onStatus?(WatchStatus(context: context)) }
        }
        flush()
    }

    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {
        guard let id = fileTransfer.file.metadata?["id"] as? String else { return }
        if error == nil {
            outbox.markDelivered(id)
            Task { @MainActor in self.onDelivered?() }
        }
        // On error the item stays in the outbox and goes again with the next flush (next recording or launch).
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.onStatus?(WatchStatus(context: applicationContext)) }
    }
}
