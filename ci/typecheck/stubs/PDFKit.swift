import AppKit
open class PDFDocument: NSObject, @unchecked Sendable { public init?(url: URL) {}; public init?(data: Data) {}; open var documentURL: URL? { nil }; open var pageCount: Int { 0 }; open func page(at i: Int) -> PDFPage? { nil }; open var string: String? { nil } }
open class PDFPage: NSObject, @unchecked Sendable { open var string: String? { nil } }
public enum PDFDisplayMode: Int { case singlePage, singlePageContinuous, twoUp, twoUpContinuous }
@preconcurrency @MainActor open class PDFView: NSView {
    public override init(frame: NSRect) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    public override init() { super.init() }
    open var document: PDFDocument?
    open var autoScales = false
    open var displayMode: PDFDisplayMode = .singlePageContinuous
    open var displaysPageBreaks = true
    open var backgroundColor: NSColor = .clear
    open var displayDirection: Int = 0
}
