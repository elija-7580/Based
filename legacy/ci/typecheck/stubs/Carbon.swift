// Signature-only stub of the parts of Carbon (HIToolbox) Based uses: system-wide hot keys (BSD-64).
import Foundation

public typealias OSStatus = Int32
public typealias OSType = UInt32
public typealias OptionBits = UInt32
public typealias EventTargetRef = OpaquePointer
public typealias EventHotKeyRef = OpaquePointer
public typealias EventHandlerRef = OpaquePointer
public typealias EventHandlerCallRef = OpaquePointer
public typealias EventRef = OpaquePointer
public typealias EventHandlerUPP = @convention(c) (EventHandlerCallRef?, EventRef?, UnsafeMutableRawPointer?) -> OSStatus

public struct EventHotKeyID { public var signature: OSType; public var id: UInt32
    public init() { signature = 0; id = 0 }
    public init(signature: OSType, id: UInt32) { self.signature = signature; self.id = id } }
public struct EventTypeSpec { public var eventClass: OSType; public var eventKind: UInt32
    public init() { eventClass = 0; eventKind = 0 }
    public init(eventClass: OSType, eventKind: UInt32) { self.eventClass = eventClass; self.eventKind = eventKind } }

public var noErr: Int { 0 }
public var kEventClassKeyboard: Int { 0x6B657962 }
public var kEventHotKeyPressed: Int { 5 }
public var cmdKey: Int { 0x100 }
public var shiftKey: Int { 0x200 }
public var optionKey: Int { 0x800 }
public var controlKey: Int { 0x1000 }

public func GetApplicationEventTarget() -> EventTargetRef! { nil }
public func RegisterEventHotKey(_ inHotKeyCode: UInt32, _ inHotKeyModifiers: UInt32, _ inHotKeyID: EventHotKeyID, _ inTarget: EventTargetRef!,
                                _ inOptions: OptionBits, _ outRef: UnsafeMutablePointer<EventHotKeyRef?>!) -> OSStatus { 0 }
public func UnregisterEventHotKey(_ inHotKey: EventHotKeyRef!) -> OSStatus { 0 }
public func InstallEventHandler(_ inTarget: EventTargetRef!, _ inHandler: EventHandlerUPP!, _ inNumTypes: Int, _ inList: UnsafePointer<EventTypeSpec>!,
                                _ inUserData: UnsafeMutableRawPointer!, _ outRef: UnsafeMutablePointer<EventHandlerRef?>!) -> OSStatus { 0 }
public func RemoveEventHandler(_ inHandlerRef: EventHandlerRef!) -> OSStatus { 0 }
