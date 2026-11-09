// Type-check stub of Apple's AVFoundation / AVFAudio (subset used by meeting capture). Signatures only.
import Foundation
@_exported import CoreAudio

public enum AVAudioCommonFormat: UInt { case otherFormat, pcmFormatFloat32, pcmFormatFloat64, pcmFormatInt16, pcmFormatInt32 }
public typealias AVAudioFrameCount = UInt32
public typealias NSErrorPointer = UnsafeMutablePointer<NSError?>?   // AutoreleasingUnsafeMutablePointer in the SDK
public typealias AVAudioPacketCount = UInt32
public typealias AVAudioFramePosition = Int64
public let AVFormatIDKey = "AVFormatIDKey", AVSampleRateKey = "AVSampleRateKey", AVNumberOfChannelsKey = "AVNumberOfChannelsKey", AVEncoderBitRateKey = "AVEncoderBitRateKey"

open class AVAudioFormat: NSObject, @unchecked Sendable {
    public init?(commonFormat: AVAudioCommonFormat, sampleRate: Double, channels: UInt32, interleaved: Bool) {}
    public init?(streamDescription asbd: UnsafePointer<AudioStreamBasicDescription>) {}
    open var sampleRate: Double { 0 }
    open var channelCount: UInt32 { 0 }
}
open class AVAudioBuffer: NSObject, @unchecked Sendable {}
open class AVAudioPCMBuffer: AVAudioBuffer, @unchecked Sendable {
    public init?(pcmFormat: AVAudioFormat, frameCapacity: AVAudioFrameCount) {}
    public init?(pcmFormat: AVAudioFormat, bufferListNoCopy: UnsafePointer<AudioBufferList>, deallocator: ((UnsafePointer<AudioBufferList>) -> Void)?) {}
    open var frameLength: AVAudioFrameCount = 0
    open var format: AVAudioFormat { fatalError() }
    open var floatChannelData: UnsafePointer<UnsafeMutablePointer<Float>>? { nil }
}
open class AVAudioTime: NSObject, @unchecked Sendable {}
public enum AVAudioConverterInputStatus: Int { case haveData, noDataNow, endOfStream }
public enum AVAudioConverterOutputStatus: Int { case haveData, inputRanDry, endOfStream, error }
public typealias AVAudioConverterInputBlock = (AVAudioPacketCount, UnsafeMutablePointer<AVAudioConverterInputStatus>) -> AVAudioBuffer?
open class AVAudioConverter: NSObject {
    public init?(from: AVAudioFormat, to: AVAudioFormat) {}
    open func convert(to outputBuffer: AVAudioBuffer, error outError: NSErrorPointer, withInputFrom inputBlock: AVAudioConverterInputBlock) -> AVAudioConverterOutputStatus { .error }
}
open class AVAudioFile: NSObject {
    public init(forWriting fileURL: URL, settings: [String: Any], commonFormat format: AVAudioCommonFormat, interleaved: Bool) throws {}
    public init(forReading fileURL: URL) throws {}
    open func write(from buffer: AVAudioPCMBuffer) throws {}
    open var length: AVAudioFramePosition { 0 }
    open var processingFormat: AVAudioFormat { fatalError() }
}
public typealias AVAudioNodeTapBlock = (AVAudioPCMBuffer, AVAudioTime) -> Void
open class AVAudioNode: NSObject {
    open func installTap(onBus bus: Int, bufferSize: AVAudioFrameCount, format: AVAudioFormat?, block: @escaping AVAudioNodeTapBlock) {}
    open func removeTap(onBus bus: Int) {}
    open func outputFormat(forBus bus: Int) -> AVAudioFormat { fatalError() }
}
open class AVAudioInputNode: AVAudioNode {}
open class AVAudioEngine: NSObject {
    public override init() {}
    open var inputNode: AVAudioInputNode { fatalError() }
    open func prepare() {}
    open func start() throws {}
    open func stop() {}
}
open class AVAudioPlayer: NSObject {
    public init(contentsOf url: URL) throws {}
    open var currentTime: TimeInterval = 0
    open var deviceCurrentTime: TimeInterval { 0 }
    open var duration: TimeInterval { 0 }
    open var isPlaying: Bool { false }
    @discardableResult open func prepareToPlay() -> Bool { true }
    @discardableResult open func play() -> Bool { true }
    @discardableResult open func play(atTime time: TimeInterval) -> Bool { true }
    open func pause() {}
    open func stop() {}
}
public struct AVMediaType: Hashable { public static let audio = AVMediaType(), video = AVMediaType() }
open class AVCaptureDevice: NSObject {
    open class func requestAccess(for mediaType: AVMediaType) async -> Bool { true }
}

#if STUB_IOS
/// iOS audio session (AVFAudio), BSD-95.
open class AVAudioSession: NSObject, @unchecked Sendable {
    open class func sharedInstance() -> AVAudioSession { AVAudioSession() }
    public struct Category: Hashable, Sendable { public static let playAndRecord = Category(), record = Category(), playback = Category(), ambient = Category() }
    public struct Mode: Hashable, Sendable { public static let `default` = Mode(), measurement = Mode(), voiceChat = Mode(), videoRecording = Mode(), spokenAudio = Mode() }
    public struct CategoryOptions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let mixWithOthers = CategoryOptions(rawValue: 1), duckOthers = CategoryOptions(rawValue: 2), allowBluetooth = CategoryOptions(rawValue: 4), defaultToSpeaker = CategoryOptions(rawValue: 8), allowBluetoothA2DP = CategoryOptions(rawValue: 32) }
    public struct SetActiveOptions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let notifyOthersOnDeactivation = SetActiveOptions(rawValue: 1) }
    open func setCategory(_ c: Category, mode: Mode, options: CategoryOptions = []) throws {}
    open func setCategory(_ c: Category, options: CategoryOptions = []) throws {}
    open func setActive(_ a: Bool, options: SetActiveOptions = []) throws {}
    open func requestRecordPermission(_ h: @escaping (Bool) -> Void) {}
}
#endif
