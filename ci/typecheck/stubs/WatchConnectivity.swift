// Signature-only stub of WatchConnectivity (BSD-66: Apple Watch voice notes → iPhone).
import Foundation

public enum WCSessionActivationState: Int, Sendable { case notActivated = 0, inactive = 1, activated = 2 }

open class WCSessionFile: NSObject {
    open var fileURL: URL { URL(fileURLWithPath: "/") }
    open var metadata: [String: Any]? { nil }
}

open class WCSessionFileTransfer: NSObject {
    open var file: WCSessionFile { WCSessionFile() }
    open var isTransferring: Bool { false }
    open func cancel() {}
}

public protocol WCSessionDelegate: NSObjectProtocol {
    func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?)
    #if STUB_IOS && !STUB_WATCH
    func sessionDidBecomeInactive(_ session: WCSession)
    func sessionDidDeactivate(_ session: WCSession)
    #endif
    func session(_ session: WCSession, didReceive file: WCSessionFile)
    func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?)
    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any])
}
extension WCSessionDelegate {
    public func session(_ session: WCSession, didReceive file: WCSessionFile) {}
    public func session(_ session: WCSession, didFinish fileTransfer: WCSessionFileTransfer, error: Error?) {}
    public func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {}
}

open class WCSession: NSObject {
    open class func isSupported() -> Bool { false }
    open class var `default`: WCSession { WCSession() }
    open weak var delegate: WCSessionDelegate?
    open func activate() {}
    open var activationState: WCSessionActivationState { .notActivated }
    open var isReachable: Bool { false }
    #if STUB_IOS && !STUB_WATCH
    open var isPaired: Bool { false }
    open var isWatchAppInstalled: Bool { false }
    #endif
    #if STUB_WATCH
    open var isCompanionAppInstalled: Bool { false }
    #endif
    open var outstandingFileTransfers: [WCSessionFileTransfer] { [] }
    @discardableResult open func transferFile(_ file: URL, metadata: [String: Any]?) -> WCSessionFileTransfer { WCSessionFileTransfer() }
    open var applicationContext: [String: Any] { [:] }
    open var receivedApplicationContext: [String: Any] { [:] }
    open func updateApplicationContext(_ applicationContext: [String: Any]) throws {}
}
