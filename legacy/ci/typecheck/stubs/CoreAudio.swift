// Type-check stub of Apple's CoreAudio / CoreAudioTypes (subset used by meeting capture). Signatures only.
import Foundation
@_exported import Security   // OSStatus, CFString, CFDictionary

public typealias AudioObjectID = UInt32
public typealias AudioDeviceID = AudioObjectID
public typealias AudioObjectPropertySelector = UInt32
public typealias AudioObjectPropertyScope = UInt32
public typealias AudioObjectPropertyElement = UInt32
public typealias AudioFormatID = UInt32
public let noErr: OSStatus = 0
public var kAudioObjectUnknown: Int { 0 }
public var kAudioObjectSystemObject: Int { 1 }
public var kAudioObjectPropertyScopeGlobal: AudioObjectPropertyScope { 0 }
public var kAudioObjectPropertyElementMain: AudioObjectPropertyElement { 0 }
public var kAudioHardwarePropertyDefaultOutputDevice: AudioObjectPropertySelector { 0 }
public var kAudioDevicePropertyDeviceUID: AudioObjectPropertySelector { 0 }
public var kAudioTapPropertyFormat: AudioObjectPropertySelector { 0 }
public var kAudioFormatMPEG4AAC: AudioFormatID { 0 }
public var kAudioAggregateDeviceNameKey: String { "name" }
public var kAudioAggregateDeviceUIDKey: String { "uid" }
public var kAudioAggregateDeviceMainSubDeviceKey: String { "master" }
public var kAudioAggregateDeviceIsPrivateKey: String { "private" }
public var kAudioAggregateDeviceIsStackedKey: String { "stacked" }
public var kAudioAggregateDeviceTapAutoStartKey: String { "tapautostart" }
public var kAudioAggregateDeviceSubDeviceListKey: String { "subdevices" }
public var kAudioAggregateDeviceTapListKey: String { "taps" }
public var kAudioSubDeviceUIDKey: String { "uid" }
public var kAudioSubTapUIDKey: String { "uid" }
public var kAudioSubTapDriftCompensationKey: String { "drift" }

public struct AudioObjectPropertyAddress {
    public var mSelector: AudioObjectPropertySelector
    public var mScope: AudioObjectPropertyScope
    public var mElement: AudioObjectPropertyElement
    public init(mSelector: AudioObjectPropertySelector, mScope: AudioObjectPropertyScope, mElement: AudioObjectPropertyElement) {
        self.mSelector = mSelector; self.mScope = mScope; self.mElement = mElement
    }
}
public struct AudioStreamBasicDescription { public init() {} }
public struct AudioBufferList {}
public struct AudioTimeStamp {}
public struct AudioDeviceIOProc {}   // a C function pointer in the SDK
public typealias AudioDeviceIOProcID = AudioDeviceIOProc
public typealias AudioDeviceIOBlock = (UnsafePointer<AudioTimeStamp>, UnsafePointer<AudioBufferList>, UnsafePointer<AudioTimeStamp>, UnsafeMutablePointer<AudioBufferList>, UnsafePointer<AudioTimeStamp>) -> Void

open class CATapDescription: NSObject {
    public init(monoGlobalTapButExcludeProcesses processes: [NSNumber]) {}
    public init(stereoGlobalTapButExcludeProcesses processes: [NSNumber]) {}
    open var uuid: UUID = UUID()
}

public func AudioObjectGetPropertyData(_ inObjectID: AudioObjectID, _ inAddress: UnsafePointer<AudioObjectPropertyAddress>, _ inQualifierDataSize: UInt32,
                                       _ inQualifierData: UnsafeRawPointer?, _ ioDataSize: UnsafeMutablePointer<UInt32>, _ outData: UnsafeMutableRawPointer) -> OSStatus { 0 }
@available(macOS 14.2, *)
public func AudioHardwareCreateProcessTap(_ inDescription: CATapDescription?, _ outTapID: UnsafeMutablePointer<AudioObjectID>?) -> OSStatus { 0 }
@available(macOS 14.2, *)
public func AudioHardwareDestroyProcessTap(_ inTapID: AudioObjectID) -> OSStatus { 0 }
public func AudioHardwareCreateAggregateDevice(_ inDescription: CFDictionary, _ outDeviceID: UnsafeMutablePointer<AudioObjectID>) -> OSStatus { 0 }
public func AudioHardwareDestroyAggregateDevice(_ inDeviceID: AudioObjectID) -> OSStatus { 0 }
public func AudioDeviceCreateIOProcIDWithBlock(_ outIOProcID: UnsafeMutablePointer<AudioDeviceIOProcID?>, _ inDevice: AudioObjectID,
                                               _ inDispatchQueue: DispatchQueue?, _ inIOBlock: @escaping AudioDeviceIOBlock) -> OSStatus { 0 }
public func AudioDeviceStart(_ inDevice: AudioObjectID, _ inProcID: AudioDeviceIOProcID?) -> OSStatus { 0 }
public func AudioDeviceStop(_ inDevice: AudioObjectID, _ inProcID: AudioDeviceIOProcID?) -> OSStatus { 0 }
public func AudioDeviceDestroyIOProcID(_ inDevice: AudioObjectID, _ inIOProcID: AudioDeviceIOProcID) -> OSStatus { 0 }
