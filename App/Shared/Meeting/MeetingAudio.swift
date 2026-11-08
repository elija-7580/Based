import Foundation
import Observation
import AVFoundation
#if os(macOS)
import CoreAudio
#endif
import BasedCore

// Audio capture for meeting notes. Every source (microphone, system audio) becomes its own track:
//   source buffers → 16 kHz mono Float32 → (a) AAC file on disk, (b) live recogniser.
// Separate tracks give "me vs. the others" for free and let the final pass diarize only the remote side.

/// 16 kHz mono Float32, what the speech models expect.
enum MeetingAudioFormat {
    static let sampleRate: Double = 16_000
    static let pcm = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: sampleRate, channels: 1, interleaved: false)!
    /// AAC in .m4a: ~10 MB per hour and track instead of ~230 MB as PCM.
    static let fileSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: sampleRate,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000,
    ]
}

/// Converts arbitrary PCM buffers to 16 kHz mono and writes them to a file; reports the samples to `onSamples`.
/// Called on the capture thread. Pausing drops buffers, so the file and the sample clock contain recorded time only.
final class TrackWriter: @unchecked Sendable {
    let role: AudioTrackRole
    let url: URL
    private let file: AVAudioFile
    private var converter: AVAudioConverter?
    private var converterInput: AVAudioFormat?
    private let lock = NSLock()
    private var paused = false
    /// Samples written so far (the track's clock).
    private(set) var samplesWritten = 0
    /// Peak level of the last buffer, 0…1, for the level meter.
    private(set) var level: Float = 0
    var onSamples: (@Sendable ([Float], Int) -> Void)?

    init(role: AudioTrackRole, url: URL) throws {
        self.role = role
        self.url = url
        file = try AVAudioFile(forWriting: url, settings: MeetingAudioFormat.fileSettings,
                               commonFormat: .pcmFormatFloat32, interleaved: false)
    }

    func setPaused(_ p: Bool) { lock.lock(); paused = p; lock.unlock() }

    var seconds: Double { Double(samplesWritten) / MeetingAudioFormat.sampleRate }

    func append(_ buffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard !paused, buffer.frameLength > 0, let out = convert(buffer) else { return }
        do { try file.write(from: out) } catch { Log.warning("Meeting audio write failed: \(error)", category: "meeting") }
        let n = Int(out.frameLength)
        guard n > 0, let ch = out.floatChannelData else { return }
        let samples = Array(UnsafeBufferPointer(start: ch[0], count: n))
        var peak: Float = 0
        for s in samples { peak = max(peak, abs(s)) }
        level = peak
        let start = samplesWritten
        samplesWritten += n
        onSamples?(samples, start)
    }

    private func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let target = MeetingAudioFormat.pcm
        if converter == nil || converterInput != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: target)
            converterInput = buffer.format
        }
        guard let converter else { return nil }
        let ratio = target.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 64)
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: capacity) else { return nil }
        var fed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, inputStatus in
            if fed { inputStatus.pointee = .noDataNow; return nil }
            fed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        if status == .error { Log.warning("Meeting audio convert failed: \(error?.localizedDescription ?? "?")", category: "meeting"); return nil }
        return out
    }
}

/// Microphone through AVAudioEngine.
final class MicrophoneCapture: @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let writer: TrackWriter

    init(writer: TrackWriter) { self.writer = writer }

    static func requestPermission() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .audio)
    }

    func start() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        // Recording keeps running in the background (UIBackgroundModes: audio) once started in the foreground.
        try session.setCategory(.playAndRecord, mode: .default, options: [.allowBluetooth, .defaultToSpeaker, .mixWithOthers])
        try session.setActive(true)
        #endif
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        let writer = self.writer
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in writer.append(buffer) }
        engine.prepare()
        try engine.start()
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
    }
}

#if os(macOS)
/// Everything the Mac plays (Zoom, Meet in the browser, Teams …) through a Core Audio process tap
/// (macOS 14.2+, no virtual driver). The first use asks for the "System Audio Recording" permission.
final class SystemAudioCapture: @unchecked Sendable {
    enum CaptureError: LocalizedError {
        case unsupported, status(String, OSStatus)
        var errorDescription: String? {
            switch self {
            case .unsupported: return "System audio needs macOS 14.2 or later."
            case .status(let what, let s): return "\(what) failed (\(s)). Allow Based under System Settings → Privacy & Security → Screen & System Audio Recording."
            }
        }
    }

    private let writer: TrackWriter
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "based.meeting.system-audio", qos: .userInitiated)

    init(writer: TrackWriter) { self.writer = writer }

    func start() throws {
        guard #available(macOS 14.2, *) else { throw CaptureError.unsupported }
        let description = CATapDescription(monoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        var err = AudioHardwareCreateProcessTap(description, &tapID)
        guard err == noErr else { throw CaptureError.status("Creating the audio tap", err) }

        let outputUID = try Self.defaultOutputDeviceUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Based meeting capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true,
                                              kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        err = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        guard err == noErr else { stop(); throw CaptureError.status("Creating the capture device", err) }

        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal,
                                                 mElement: kAudioObjectPropertyElementMain)
        err = AudioObjectGetPropertyData(tapID, &address, 0, nil, &size, &asbd)
        guard err == noErr, let format = AVAudioFormat(streamDescription: &asbd) else {
            stop(); throw CaptureError.status("Reading the tap format", err)
        }
        let writer = self.writer
        err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { _, input, _, _, _ in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: format, bufferListNoCopy: input, deallocator: nil) else { return }
            writer.append(buffer)
        }
        guard err == noErr else { stop(); throw CaptureError.status("Starting the capture", err) }
        err = AudioDeviceStart(aggregateID, procID)
        guard err == noErr else { stop(); throw CaptureError.status("Starting the capture", err) }
    }

    func stop() {
        if aggregateID != AudioObjectID(kAudioObjectUnknown) {
            if let procID {
                _ = AudioDeviceStop(aggregateID, procID)
                _ = AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            _ = AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        procID = nil
        if tapID != AudioObjectID(kAudioObjectUnknown) {
            if #available(macOS 14.2, *) { _ = AudioHardwareDestroyProcessTap(tapID) }
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private static func defaultOutputDeviceUID() throws -> String {
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var err = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
        guard err == noErr else { throw CaptureError.status("Finding the output device", err) }
        var uid: CFString = "" as CFString
        size = UInt32(MemoryLayout<CFString>.size)
        address.mSelector = kAudioDevicePropertyDeviceUID
        err = withUnsafeMutablePointer(to: &uid) { AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0) }
        guard err == noErr else { throw CaptureError.status("Reading the output device", err) }
        return uid as String
    }
}
#endif

/// Plays a meeting's recording from any second. Tracks of one recording play together (mic + system).
@MainActor @Observable
final class MeetingPlayer {
    private(set) var meetingID: RecordID?
    private(set) var isPlaying = false
    private var players: [(AVAudioPlayer, Double)] = []   // player, track offset
    private var ticker: Timer?
    var position: Double = 0

    func play(meeting: RecordID, tracks: [MeetingTrack], from seconds: Double, assets: FileAssetStore) {
        stop()
        meetingID = meeting
        // The recording session that covers `seconds`: tracks starting at the latest offset ≤ seconds.
        let sessionOffset = tracks.map(\.offset).filter { $0 <= seconds + 0.01 }.max() ?? 0
        let session = tracks.filter { $0.offset == sessionOffset }
        players = session.compactMap { t in
            guard let url = assets.url(for: t.asset), let p = try? AVAudioPlayer(contentsOf: url) else { return nil }
            p.prepareToPlay()
            p.currentTime = max(0, seconds - t.offset)
            return (p, t.offset)
        }
        guard let first = players.first?.0 else { return }
        let start = first.deviceCurrentTime + 0.05
        for (p, _) in players { p.play(atTime: start) }
        isPlaying = true
        position = seconds
        ticker = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.tick() }
        }
    }

    private func tick() {
        guard let (p, offset) = players.first else { return }
        position = offset + p.currentTime
        if !p.isPlaying { stop() }
    }

    func stop() {
        for (p, _) in players { p.stop() }
        players = []
        ticker?.invalidate(); ticker = nil
        isPlaying = false
    }
}
