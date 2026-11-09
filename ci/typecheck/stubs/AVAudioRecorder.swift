// Signature-only stub of AVAudioRecorder, compiled into the AVFoundation stub module by run-watch.sh (BSD-66).
import Foundation

open class AVAudioRecorder: NSObject {
    public init(url: URL, settings: [String: Any]) throws {}
    @discardableResult open func prepareToRecord() -> Bool { true }
    @discardableResult open func record() -> Bool { true }
    open func stop() {}
    open func deleteRecording() -> Bool { true }
    open var isRecording: Bool { false }
    open var currentTime: TimeInterval { 0 }
    open var url: URL { URL(fileURLWithPath: "/") }
    open var isMeteringEnabled = false
    open func updateMeters() {}
    open func averagePower(forChannel n: Int) -> Float { 0 }
}
/// From CoreAudioTypes (re-exported by AVFoundation on watchOS).
public var kAudioFormatMPEG4AAC: UInt32 { 0x61616320 }
