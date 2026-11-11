// Type-check stub of CoreGraphics / QuartzCore (subset used by Based). Signatures mirror Apple's API; bodies are dummies.
// Re-exported by the AppKit stub (as the real AppKit does). CF types are aliases so `data as CFData` / `url as CFURL`
// type-check on Linux, where toll-free bridging does not exist.
@_exported import Foundation
#if canImport(FoundationNetworking)
@_exported import FoundationNetworking
#endif

public typealias CFData = Data
public typealias CFURL = URL
public typealias CFString = String

public final class CGColor: @unchecked Sendable { public init() {}; public static let clear = CGColor() }
public final class CGImage: @unchecked Sendable { public init() {}; public var width: Int { 0 }; public var height: Int { 0 } }

public enum CGPDFBox: Int32, Sendable { case mediaBox = 0, cropBox, bleedBox, trimBox, artBox }
public final class CGDataProvider: @unchecked Sendable { public init?(data: CFData) {} }
public final class CGPDFPage: @unchecked Sendable { public func getBoxRect(_ box: CGPDFBox) -> CGRect { .zero } }
public final class CGPDFDocument: @unchecked Sendable {
    public init?(_ provider: CGDataProvider) {}
    public var numberOfPages: Int { 0 }
    public func page(at n: Int) -> CGPDFPage? { nil }
}
public final class CGContext: @unchecked Sendable {
    public init?(_ url: CFURL, mediaBox: UnsafePointer<CGRect>?, _ auxiliaryInfo: [AnyHashable: Any]?) {}
    public func beginPDFPage(_ pageInfo: [AnyHashable: Any]?) {}
    public func endPDFPage() {}
    public func closePDF() {}
    public func saveGState() {}
    public func restoreGState() {}
    public func clip(to rect: CGRect) {}
    public func translateBy(x: CGFloat, y: CGFloat) {}
    public func scaleBy(x: CGFloat, y: CGFloat) {}
    public func drawPDFPage(_ page: CGPDFPage) {}
}

public enum CATransaction { public static func flush() {}; public static func begin() {}; public static func commit() {}; public static func setDisableActions(_ b: Bool) {} }
