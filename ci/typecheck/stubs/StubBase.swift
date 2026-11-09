// Type-check stub: Objective-C runtime / Foundation-on-Apple pieces shared by the AppKit and UIKit stubs
// (BSD-95). Both re-export this module, so the iOS run sees no AppKit symbol.
@_exported import CoreGraphics

public struct Selector: Hashable, ExpressibleByStringLiteral, @unchecked Sendable {
    public init(_ s: String) {}
    public init(stringLiteral s: String) {}
}
public func NSSelectorFromString(_ s: String) -> Selector { Selector(s) }
public func NSSetUncaughtExceptionHandler(_ h: ((NSException) -> Void)?) {}
open class UndoManager: NSObject, @unchecked Sendable { public override init() {}; open func registerUndo<T: AnyObject>(withTarget t: T, handler: @escaping (T) -> Void) {}; open func undo() {}; open func redo() {}; open var canUndo: Bool { false }; open var canRedo: Bool { false }; open func setActionName(_ s: String) {}; open func beginUndoGrouping() {}; open func endUndoGrouping() {}; open func removeAllActions() {} }
open class NSException: NSObject, @unchecked Sendable {
    open var name: NSExceptionName { NSExceptionName("") }
    open var reason: String? { nil }
    open var callStackSymbols: [String] { [] }
    open var userInfo: [AnyHashable: Any]? { nil }
}
public struct NSExceptionName: RawRepresentable, Hashable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public init(_ s: String) { rawValue = s } }
extension NSObject {
    public func responds(to s: Selector!) -> Bool { false }
    public func value(forKey key: String) -> Any? { nil }
    public var className: String { "" }
}

extension URL {
    public func startAccessingSecurityScopedResource() -> Bool { true }
    public func stopAccessingSecurityScopedResource() {}
    public func bookmarkData(options: Int = 0, includingResourceValuesForKeys: Set<URLResourceKey>? = nil, relativeTo: URL? = nil) throws -> Data { Data() }
}
open class NSItemProvider: NSObject, @unchecked Sendable {
    public override init() {}
    public init(object: Any) {}
    public init(item: Any?, typeIdentifier: String?) {}
    public init?(contentsOf url: URL) {}
    open var registeredTypeIdentifiers: [String] { [] }
    open var suggestedName: String?
    open func hasItemConformingToTypeIdentifier(_ t: String) -> Bool { false }
    open func loadItem(forTypeIdentifier: String, options: [AnyHashable: Any]? = nil, completionHandler: ((Any?, Error?) -> Void)? = nil) {}
    open func loadDataRepresentation(forTypeIdentifier: String, completionHandler: @escaping @Sendable (Data?, Error?) -> Void) -> Progress { Progress(totalUnitCount: 1) }
    open func loadFileRepresentation(forTypeIdentifier: String, completionHandler: @escaping @Sendable (URL?, Error?) -> Void) -> Progress { Progress(totalUnitCount: 1) }
    open func loadObject<T>(ofClass: T.Type, completionHandler: @escaping @Sendable (Any?, Error?) -> Void) -> Progress { Progress(totalUnitCount: 1) }
    open func canLoadObject(ofClass: Any.Type) -> Bool { false }
    open func registerDataRepresentation(forTypeIdentifier: String, visibility: Int = 0, loadHandler: @escaping @Sendable (@escaping (Data?, Error?) -> Void) -> Progress?) {}
    open func registerObject(_ o: Any, visibility: Int) {}
}
extension NSString { public static var readableTypeIdentifiersForItemProvider: [String] { [] } }
extension NSURL { public static var readableTypeIdentifiersForItemProvider: [String] { [] } }
extension AttributedString {
    public struct _MarkdownOptions { public enum InterpretedSyntax { case full, inlineOnly, inlineOnlyPreservingWhitespace }; public init(allowsExtendedAttributes: Bool = false, interpretedSyntax: InterpretedSyntax = .full, languageCode: String? = nil) {} }
    public init(markdown: String, options: _MarkdownOptions, baseURL: URL? = nil) throws { self.init(markdown) }
}

// Text system (TextKit 1): the same classes exist in AppKit and UIKit.
@preconcurrency @MainActor open class NSTextContainer: NSObject {
    public override init() {}
    public init(size: NSSize) {}
    open var widthTracksTextView = false
    open var heightTracksTextView = false
    open var containerSize: NSSize = .zero
    open var size: NSSize = .zero
    open var lineFragmentPadding: CGFloat = 5
    open var maximumNumberOfLines = 0
    open var lineBreakMode: NSLineBreakMode = .byWordWrapping
}
@preconcurrency @MainActor open class NSLayoutManager: NSObject {
    public override init() {}
    open func addTextContainer(_ c: NSTextContainer) {}
    open func glyphRange(forCharacterRange r: NSRange, actualCharacterRange: NSRangePointer?) -> NSRange { r }
    open func characterRange(forGlyphRange r: NSRange, actualGlyphRange: NSRangePointer?) -> NSRange { r }
    open func boundingRect(forGlyphRange r: NSRange, in c: NSTextContainer) -> NSRect { .zero }
    open func usedRect(for c: NSTextContainer) -> NSRect { .zero }
    open func ensureLayout(for c: NSTextContainer) {}
    open func glyphIndex(for p: NSPoint, in c: NSTextContainer, fractionOfDistanceThroughGlyph: UnsafeMutablePointer<CGFloat>?) -> Int { 0 }
    open func glyphIndex(for p: NSPoint, in c: NSTextContainer) -> Int { 0 }
    open func characterIndex(for p: NSPoint, in c: NSTextContainer, fractionOfDistanceBetweenInsertionPoints: UnsafeMutablePointer<CGFloat>?) -> Int { 0 }
    open func lineFragmentRect(forGlyphAt i: Int, effectiveRange: NSRangePointer?) -> NSRect { .zero }
    open func lineFragmentUsedRect(forGlyphAt i: Int, effectiveRange: NSRangePointer?) -> NSRect { .zero }
    open var numberOfGlyphs: Int { 0 }
    open func glyphIndexForCharacter(at i: Int) -> Int { i }
    open func characterIndexForGlyph(at i: Int) -> Int { i }
    open func enumerateLineFragments(forGlyphRange r: NSRange, using: (NSRect, NSRect, NSTextContainer, NSRange, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    open var extraLineFragmentRect: NSRect { .zero }
}
open class NSTextStorage: NSMutableAttributedString {
    @MainActor open var layoutManagers: [NSLayoutManager] { [] }
    @MainActor open func addLayoutManager(_ m: NSLayoutManager) {}
}
public enum NSTextAlignment: Int, Sendable { case left = 0, right = 1, center = 2, justified = 3, natural = 4 }
public enum NSLineBreakMode: Int, Sendable { case byWordWrapping = 0, byCharWrapping, byClipping, byTruncatingHead, byTruncatingTail, byTruncatingMiddle }
public enum NSWritingDirection: Int { case natural = -1, leftToRight = 0, rightToLeft = 1 }
open class NSParagraphStyle: NSObject, NSCopying, NSMutableCopying, @unchecked Sendable {
    public override init() {}
    open class var `default`: NSParagraphStyle { NSParagraphStyle() }
    open var lineSpacing: CGFloat { 0 }
    open var paragraphSpacing: CGFloat { 0 }
    open var paragraphSpacingBefore: CGFloat { 0 }
    open var headIndent: CGFloat { 0 }
    open var firstLineHeadIndent: CGFloat { 0 }
    open var tailIndent: CGFloat { 0 }
    open var lineHeightMultiple: CGFloat { 0 }
    open var minimumLineHeight: CGFloat { 0 }
    open var maximumLineHeight: CGFloat { 0 }
    open var alignment: NSTextAlignment { .natural }
    open var lineBreakMode: NSLineBreakMode { .byWordWrapping }
    public func copy(with zone: NSZone? = nil) -> Any { self }
    public func mutableCopy(with zone: NSZone? = nil) -> Any { NSMutableParagraphStyle() }
}
open class NSMutableParagraphStyle: NSParagraphStyle, @unchecked Sendable {
    private var _v: CGFloat = 0
    open override var lineSpacing: CGFloat { get { _v } set {} }
    open override var paragraphSpacing: CGFloat { get { _v } set {} }
    open override var paragraphSpacingBefore: CGFloat { get { _v } set {} }
    open override var headIndent: CGFloat { get { _v } set {} }
    open override var firstLineHeadIndent: CGFloat { get { _v } set {} }
    open override var tailIndent: CGFloat { get { _v } set {} }
    open override var lineHeightMultiple: CGFloat { get { _v } set {} }
    open override var minimumLineHeight: CGFloat { get { _v } set {} }
    open override var maximumLineHeight: CGFloat { get { _v } set {} }
    open override var alignment: NSTextAlignment { get { .natural } set {} }
    open override var lineBreakMode: NSLineBreakMode { get { .byWordWrapping } set {} }
    open func setParagraphStyle(_ p: NSParagraphStyle) {}
}
public struct NSUnderlineStyle: OptionSet, Sendable, Hashable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let single = NSUnderlineStyle(rawValue: 1), thick = NSUnderlineStyle(rawValue: 2), double = NSUnderlineStyle(rawValue: 9), patternDot = NSUnderlineStyle(rawValue: 0x100), byWord = NSUnderlineStyle(rawValue: 0x8000) }
open class NSTextAttachment: NSObject, @unchecked Sendable { public override init() {}; open var bounds: CGRect = .zero }
extension NSAttributedString.Key {
    public static let font = NSAttributedString.Key("NSFont"), foregroundColor = NSAttributedString.Key("NSColor"), backgroundColor = NSAttributedString.Key("NSBackgroundColor"), underlineStyle = NSAttributedString.Key("NSUnderline"), strikethroughStyle = NSAttributedString.Key("NSStrikethrough"), link = NSAttributedString.Key("NSLink"), paragraphStyle = NSAttributedString.Key("NSParagraphStyle"), baselineOffset = NSAttributedString.Key("NSBaselineOffset"), kern = NSAttributedString.Key("NSKern"), underlineColor = NSAttributedString.Key("NSUnderlineColor"), strikethroughColor = NSAttributedString.Key("NSStrikethroughColor"), superscript = NSAttributedString.Key("NSSuperScript"), toolTip = NSAttributedString.Key("NSToolTip"), cursor = NSAttributedString.Key("NSCursor"), attachment = NSAttributedString.Key("NSAttachment"), shadow = NSAttributedString.Key("NSShadow"), obliqueness = NSAttributedString.Key("NSObliqueness"), expansion = NSAttributedString.Key("NSExpansion"), ligature = NSAttributedString.Key("NSLigature"), markedClauseSegment = NSAttributedString.Key("NSMarkedClauseSegment")
}
extension NSAttributedString {
    public func boundingRect(with size: NSSize, options: NSString.DrawingOptions = [], context: Any? = nil) -> NSRect { .zero }
    public func size() -> NSSize { .zero }
    public func draw(at p: NSPoint) {}
    public func draw(in r: NSRect) {}
    public convenience init(html: Data, documentAttributes: UnsafeMutablePointer<NSDictionary?>?) { self.init(string: "") }
}
extension NSString {
    public struct DrawingOptions: OptionSet, Sendable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let usesLineFragmentOrigin = DrawingOptions(rawValue: 1), usesFontLeading = DrawingOptions(rawValue: 2) }
    public func size(withAttributes a: [NSAttributedString.Key: Any]?) -> NSSize { .zero }
    public func draw(at p: NSPoint, withAttributes a: [NSAttributedString.Key: Any]?) {}
    public func draw(in r: NSRect, withAttributes a: [NSAttributedString.Key: Any]?) {}
    public func boundingRect(with size: NSSize, options: DrawingOptions = [], attributes: [NSAttributedString.Key: Any]?, context: Any? = nil) -> NSRect { .zero }
}
extension String {
    public func size(withAttributes a: [NSAttributedString.Key: Any]?) -> NSSize { .zero }
    public func draw(at p: NSPoint, withAttributes a: [NSAttributedString.Key: Any]?) {}
    public func draw(in r: NSRect, withAttributes a: [NSAttributedString.Key: Any]?) {}
}

