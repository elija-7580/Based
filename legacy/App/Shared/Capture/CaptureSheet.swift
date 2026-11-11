import SwiftUI
import BasedCore
import BasedBrain

/// BSD-65: presents the capture sheet for `AppModel.captureRoute` (from App Intents or `based://capture…`) and sends
/// `askMainAgent` routes to the main agent's thread.
struct CaptureRoutePresenter: ViewModifier {
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: Binding(get: { model.captureRoute.map(Self.isSheet) ?? false },
                                        set: { if !$0 { model.captureRoute = nil } })) {
                if let route = model.captureRoute { CaptureSheet(route: route).environment(model) }
            }
            .onChange(of: model.captureRoute) { _, route in
                guard case .askMainAgent(let text)? = route else { return }
                model.captureRoute = nil
                model.openChat(model.brain.mainThreadID(), fullPage: false)
                model.brain.ask(text)
            }
    }

    static func isSheet(_ r: CaptureRoute) -> Bool {
        if case .askMainAgent = r { return false }
        return true
    }
}

/// Type a thought or record a voice note; both land in Captures and are sorted tonight.
struct CaptureSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let route: CaptureRoute
    @State private var text = ""
    @State private var voice = VoiceCaptureService.shared
    @State private var error: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                TextField("What's on your mind?", text: $text, axis: .vertical)
                    .lineLimit(3...10)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("capture.text")
                recordButton
                if let e = error ?? voice.lastError {
                    Text(e).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                }
                Spacer(minLength: 0)
            }
            .padding()
            .navigationTitle("Capture")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { voice.cancel(); close() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !voice.isRecording)
                        .accessibilityIdentifier("capture.save")
                }
            }
        }
        .frame(minWidth: 360, minHeight: 320)
        .onAppear {
            switch route {
            case .compose(let t): text = t
            case .record: Task { await voice.start() }
            case .askMainAgent: break
            }
        }
    }

    private var recordButton: some View {
        Button {
            if voice.isRecording { save() } else { Task { await voice.start() } }
        } label: {
            VStack(spacing: 8) {
                ZStack {
                    Circle().fill(voice.isRecording ? Color.red : Color.accentColor).frame(width: 96, height: 96)
                    Image(systemName: voice.isRecording ? "stop.fill" : "mic.fill").font(.system(size: 36)).foregroundStyle(.white)
                }
                .scaleEffect(voice.isRecording ? 1 + CGFloat(min(voice.level, 1)) * 0.15 : 1)
                Text(voice.isRecording ? Self.clock(voice.elapsed) : "Record a voice note")
                    .font(.callout).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(voice.isRecording ? "Stop and save" : "Record a voice note")
        .accessibilityIdentifier("capture.record")
    }

    private func save() {
        error = nil
        var saved = 0
        if voice.isRecording {
            switch voice.stopAndSave(model: model) {
            case .saved?: saved += 1
            case .failed(let m)?: error = m
            default: break
            }
        }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty {
            switch CaptureIntentLogic.capture(text: t, source: .thisDevice, brain: model.brain.brain) {
            case .saved: saved += 1; text = ""
            case .failed(let m): error = m
            case .needsInput: break
            }
        }
        if error == nil {
            if saved > 0 { model.showToast(saved == 1 ? "Saved to Captures" : "Saved \(saved) captures") }
            close()
        }
    }

    private func close() {
        model.captureRoute = nil
        dismiss()
    }

    static func clock(_ s: Double) -> String {
        let t = Int(s)
        return String(format: "%d:%02d", t / 60, t % 60)
    }
}
