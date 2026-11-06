// Type-check stub of AppKit (subset used by Based). Signatures mirror Apple's API; bodies are dummies.
@_exported import Foundation
#if canImport(FoundationNetworking)
@_exported import FoundationNetworking
#endif

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

public typealias NSEdgeInsets = (top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat)
public func NSEdgeInsetsMake(_ t: CGFloat, _ l: CGFloat, _ b: CGFloat, _ r: CGFloat) -> NSEdgeInsets { (t, l, b, r) }

@preconcurrency @MainActor open class NSResponder: NSObject {
    public override init() {}
    open var nextResponder: NSResponder?
    open var acceptsFirstResponder: Bool { true }
    open func becomeFirstResponder() -> Bool { true }
    open func resignFirstResponder() -> Bool { true }
    open func keyDown(with event: NSEvent) {}
    open func keyUp(with event: NSEvent) {}
    open func flagsChanged(with event: NSEvent) {}
    open func mouseDown(with event: NSEvent) {}
    open func mouseUp(with event: NSEvent) {}
    open func mouseDragged(with event: NSEvent) {}
    open func mouseMoved(with event: NSEvent) {}
    open func mouseEntered(with event: NSEvent) {}
    open func mouseExited(with event: NSEvent) {}
    open func rightMouseDown(with event: NSEvent) {}
    open func scrollWheel(with event: NSEvent) {}
    open func doCommand(by selector: Selector) {}
    open func performKeyEquivalent(with event: NSEvent) -> Bool { false }
    open func insertNewline(_ sender: Any?) {}
    open func insertTab(_ sender: Any?) {}
    open func insertBacktab(_ sender: Any?) {}
    open func deleteBackward(_ sender: Any?) {}
    open func deleteForward(_ sender: Any?) {}
    open func moveUp(_ sender: Any?) {}
    open func moveDown(_ sender: Any?) {}
    open func moveLeft(_ sender: Any?) {}
    open func moveRight(_ sender: Any?) {}
    open func cancelOperation(_ sender: Any?) {}
    open var undoManager: UndoManager? { nil }
    open var menu: NSMenu?
}
@preconcurrency @MainActor open class NSMenu: NSObject { public init(title: String) {}; open func addItem(_ i: NSMenuItem) {}; open var items: [NSMenuItem] = [] }
@preconcurrency @MainActor open class NSMenuItem: NSObject { public init(title: String, action: Selector?, keyEquivalent: String) {}; open var target: AnyObject?; open var representedObject: Any?; open class func separator() -> NSMenuItem { fatalError() } }

public struct NSAutoresizingMaskOptions: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let width = NSAutoresizingMaskOptions(rawValue: 2), height = NSAutoresizingMaskOptions(rawValue: 16), none = NSAutoresizingMaskOptions([]) }
extension NSView { public typealias AutoresizingMask = NSAutoresizingMaskOptions }

@preconcurrency @MainActor open class CALayer: NSObject { open var cornerRadius: CGFloat = 0; open var backgroundColor: CGColor?; open var masksToBounds = false; open var borderWidth: CGFloat = 0; open var borderColor: CGColor? }
public final class CGColor: @unchecked Sendable { public static let clear = CGColor() }

public struct NSLayoutPriority: RawRepresentable, Hashable, Sendable, ExpressibleByFloatLiteral { public var rawValue: Float; public init(rawValue: Float) { self.rawValue = rawValue }; public init(_ v: Float) { rawValue = v }; public init(floatLiteral v: Float) { rawValue = v }
    public static let required = NSLayoutPriority(1000), defaultHigh = NSLayoutPriority(750), defaultLow = NSLayoutPriority(250), fittingSizeCompression = NSLayoutPriority(50) }
extension NSLayoutConstraint { public enum Orientation: Int, Sendable { case horizontal, vertical }; public typealias Priority = NSLayoutPriority }

public struct NSDragOperation: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let copy = NSDragOperation(rawValue: 1), link = NSDragOperation(rawValue: 2), generic = NSDragOperation(rawValue: 4), move = NSDragOperation(rawValue: 16), every = NSDragOperation(rawValue: .max) }
@MainActor public protocol NSDraggingInfo { var draggingPasteboard: NSPasteboard { get }; var draggingLocation: NSPoint { get } }
@preconcurrency @MainActor open class NSView: NSResponder {
    @discardableResult open func autoscroll(with event: NSEvent) -> Bool { false }
    open func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
    open func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { [] }
    open func performDragOperation(_ sender: NSDraggingInfo) -> Bool { false }
    public override init() {}
    public init(frame: NSRect) {}
    public required init?(coder: NSCoder) {}
    open var frame: NSRect = .zero
    open var bounds: NSRect = .zero
    open var window: NSWindow? { nil }
    open var superview: NSView? { nil }
    open var subviews: [NSView] = []
    open func addSubview(_ v: NSView) {}
    open func removeFromSuperview() {}
    open var translatesAutoresizingMaskIntoConstraints = true
    open var autoresizingMask: NSAutoresizingMaskOptions = []
    open var needsDisplay = false
    open var needsLayout = false
    open var wantsLayer = false
    open var layer: CALayer?
    open var isHidden = false
    open var alphaValue: CGFloat = 1
    open var toolTip: String?
    open var intrinsicContentSize: NSSize { .zero }
    open var fittingSize: NSSize { .zero }
    open func invalidateIntrinsicContentSize() {}
    public static let noIntrinsicMetric: CGFloat = -1
    open func setContentHuggingPriority(_ p: NSLayoutConstraint.Priority, for o: NSLayoutConstraint.Orientation) {}
    open func setContentCompressionResistancePriority(_ p: NSLayoutConstraint.Priority, for o: NSLayoutConstraint.Orientation) {}
    open func viewDidMoveToWindow() {}
    open func viewWillMove(toWindow w: NSWindow?) {}
    open func viewDidMoveToSuperview() {}
    open func layout() {}
    open func layoutSubtreeIfNeeded() {}
    open func draw(_ dirtyRect: NSRect) {}
    open func convert(_ p: NSPoint, from v: NSView?) -> NSPoint { p }
    open func convert(_ p: NSPoint, to v: NSView?) -> NSPoint { p }
    open func convert(_ r: NSRect, to v: NSView?) -> NSRect { r }
    open func convert(_ r: NSRect, from v: NSView?) -> NSRect { r }
    open var enclosingScrollView: NSScrollView? { nil }
    open func setAccessibilityIdentifier(_ s: String?) {}
    open func accessibilityIdentifier() -> String { "" }
    open func updateTrackingAreas() {}
    open func addTrackingArea(_ t: NSTrackingArea) {}
    open func removeTrackingArea(_ t: NSTrackingArea) {}
    open var trackingAreas: [NSTrackingArea] { [] }
    open var isFlipped: Bool { false }
    open var mouseDownCanMoveWindow: Bool { false }
    open func setFrameOrigin(_ p: NSPoint) {}
    open func scrollToVisible(_ r: NSRect) -> Bool { true }
    open var visibleRect: NSRect { .zero }
    open var topAnchor: NSLayoutYAxisAnchor { .init() }
    open var bottomAnchor: NSLayoutYAxisAnchor { .init() }
    open var leadingAnchor: NSLayoutXAxisAnchor { .init() }
    open var trailingAnchor: NSLayoutXAxisAnchor { .init() }
    open var leftAnchor: NSLayoutXAxisAnchor { .init() }
    open var rightAnchor: NSLayoutXAxisAnchor { .init() }
    open var centerXAnchor: NSLayoutXAxisAnchor { .init() }
    open var centerYAnchor: NSLayoutYAxisAnchor { .init() }
    open var widthAnchor: NSLayoutDimension { .init() }
    open var heightAnchor: NSLayoutDimension { .init() }
    open func hitTest(_ p: NSPoint) -> NSView? { nil }
    open var effectiveAppearance: NSAppearance { NSAppearance() }
    open var appearance: NSAppearance?
    open func isDescendant(of v: NSView) -> Bool { false }
}
@preconcurrency @MainActor open class NSTrackingArea: NSObject {
    public struct Options: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
        public static let mouseEnteredAndExited = Options(rawValue: 1), mouseMoved = Options(rawValue: 2), activeInKeyWindow = Options(rawValue: 4), activeAlways = Options(rawValue: 8), inVisibleRect = Options(rawValue: 16), cursorUpdate = Options(rawValue: 32) }
    public init(rect: NSRect, options: Options, owner: Any?, userInfo: [AnyHashable: Any]?) {}
}
@preconcurrency @MainActor open class NSLayoutAnchor<T: AnyObject>: NSObject {
    public override init() {}
    open func constraint(equalTo a: NSLayoutAnchor<T>) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(equalTo a: NSLayoutAnchor<T>, constant: CGFloat) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(greaterThanOrEqualTo a: NSLayoutAnchor<T>, constant: CGFloat = 0) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(lessThanOrEqualTo a: NSLayoutAnchor<T>, constant: CGFloat = 0) -> NSLayoutConstraint { NSLayoutConstraint() }
}
@preconcurrency @MainActor open class NSLayoutXAxisAnchor: NSLayoutAnchor<NSLayoutXAxisAnchor> {}
@preconcurrency @MainActor open class NSLayoutYAxisAnchor: NSLayoutAnchor<NSLayoutYAxisAnchor> {}
@preconcurrency @MainActor open class NSLayoutDimension: NSLayoutAnchor<NSLayoutDimension> {
    open func constraint(equalToConstant c: CGFloat) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(greaterThanOrEqualToConstant c: CGFloat) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(lessThanOrEqualToConstant c: CGFloat) -> NSLayoutConstraint { NSLayoutConstraint() }
}
@preconcurrency @MainActor open class NSLayoutConstraint: NSObject {
    public override init() {}
    open class func activate(_ c: [NSLayoutConstraint]) {}
    open class func deactivate(_ c: [NSLayoutConstraint]) {}
    open var isActive = false
    open var constant: CGFloat = 0
    open var priority: NSLayoutPriority = .required
}

@preconcurrency @MainActor open class NSClipView: NSView { open var documentVisibleRect: NSRect { .zero }; open func scroll(to p: NSPoint) {}; open var drawsBackground = true }
@preconcurrency @MainActor open class NSScroller: NSView {}
@preconcurrency @MainActor open class NSScrollView: NSView {
    open var documentView: NSView?
    open var contentView: NSClipView { NSClipView() }
    open var hasVerticalScroller = false
    open var hasHorizontalScroller = false
    open var autohidesScrollers = false
    open var drawsBackground = true
    open var backgroundColor: NSColor = .clear
    open var borderType: Int = 0
    open var scrollerStyle: Int = 0
    open var automaticallyAdjustsContentInsets = true
    open var contentSize: NSSize { .zero }
    open func reflectScrolledClipView(_ c: NSClipView) {}
}

@preconcurrency @MainActor open class NSText: NSView {
    open var string: String = ""
    open var font: NSFont?
    open var textColor: NSColor?
    open var backgroundColor: NSColor = .clear
    open var drawsBackground = true
    open var isEditable = true
    open var isSelectable = true
    open var isRichText = true
    open var isFieldEditor = false
    open var isVerticallyResizable = false
    open var isHorizontallyResizable = false
    open var maxSize: NSSize = .zero
    open var minSize: NSSize = .zero
    open var alignment: NSTextAlignment = .natural
    open var selectedRange: NSRange = NSRange(location: 0, length: 0)
    open func scrollRangeToVisible(_ r: NSRange) {}
    open func selectAll(_ s: Any?) {}
    open func copy(_ s: Any?) {}
    open func paste(_ s: Any?) {}
    open func cut(_ s: Any?) {}
    open func delete(_ s: Any?) {}
    open func sizeToFit() {}
}
@preconcurrency @MainActor public protocol NSTextDelegate: NSObjectProtocol {}
@preconcurrency @MainActor public protocol NSTextViewDelegate: NSTextDelegate {}
extension NSTextViewDelegate {
    public func textDidChange(_ n: Notification) {}
    public func textDidBeginEditing(_ n: Notification) {}
    public func textDidEndEditing(_ n: Notification) {}
    public func textViewDidChangeSelection(_ n: Notification) {}
    public func textView(_ tv: NSTextView, doCommandBy s: Selector) -> Bool { false }
    public func textView(_ tv: NSTextView, shouldChangeTextIn r: NSRange, replacementString s: String?) -> Bool { true }
    public func textView(_ tv: NSTextView, clickedOnLink link: Any, at i: Int) -> Bool { false }
    public func textView(_ tv: NSTextView, menu: NSMenu, for e: NSEvent, at i: Int) -> NSMenu? { menu }
}
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
    open var textView: NSTextView? { nil }
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
    open func defaultLineHeight(for f: NSFont) -> CGFloat { 16 }
    open func characterIndexForGlyph(at i: Int) -> Int { i }
    open func enumerateLineFragments(forGlyphRange r: NSRange, using: (NSRect, NSRect, NSTextContainer, NSRange, UnsafeMutablePointer<ObjCBool>) -> Void) {}
    open var extraLineFragmentRect: NSRect { .zero }
}
open class NSTextStorage: NSMutableAttributedString {
    @MainActor open var layoutManagers: [NSLayoutManager] { [] }
    @MainActor open func addLayoutManager(_ m: NSLayoutManager) {}
}
public struct NSTextFinder { public enum Action: Int { case showFindInterface = 1, nextMatch, previousMatch } }
public enum NSFocusRingType: UInt { case `default`, none, exterior }

@preconcurrency @MainActor open class NSTextView: NSText {
    public override init(frame: NSRect) { super.init(frame: frame) }
    public init(frame: NSRect, textContainer: NSTextContainer?) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    public override init() { super.init() }
    open class func scrollableTextView() -> NSScrollView { NSScrollView() }
    open weak var delegate: (any NSTextViewDelegate)?
    open var textStorage: NSTextStorage? { nil }
    open var layoutManager: NSLayoutManager? { nil }
    open var textContainer: NSTextContainer?
    open var textContainerInset: NSSize = .zero
    open var textContainerOrigin: NSPoint { .zero }
    open var typingAttributes: [NSAttributedString.Key: Any] = [:]
    open var defaultParagraphStyle: NSParagraphStyle?
    open var linkTextAttributes: [NSAttributedString.Key: Any]?
    open var selectedTextAttributes: [NSAttributedString.Key: Any] = [:]
    open var markedTextAttributes: [NSAttributedString.Key: Any]?
    open var insertionPointColor: NSColor = .black
    open var allowsUndo = false
    open var usesFindBar = false
    open var isIncrementalSearchingEnabled = false
    open var usesFontPanel = true
    open var usesRuler = false
    open var importsGraphics = false
    open var allowsImageEditing = false
    open var displaysLinkToolTips = true
    open var isAutomaticQuoteSubstitutionEnabled = false
    open var isAutomaticDashSubstitutionEnabled = false
    open var isAutomaticTextReplacementEnabled = false
    open var isAutomaticSpellingCorrectionEnabled = false
    open var isAutomaticLinkDetectionEnabled = false
    open var isAutomaticDataDetectionEnabled = false
    open var isContinuousSpellCheckingEnabled = false
    open var isGrammarCheckingEnabled = false
    open var smartInsertDeleteEnabled = false
    open var focusRingType: NSFocusRingType = .default
    open var isAutomaticTextCompletionEnabled = false
    open func selectedRange() -> NSRange { NSRange(location: 0, length: 0) }
    open var selectedRanges: [NSValue] = []
    open func setSelectedRange(_ r: NSRange) {}
    open func setSelectedRange(_ r: NSRange, affinity: Int, stillSelecting: Bool) {}
    open func insertText(_ s: Any, replacementRange: NSRange) {}
    open func insertText(_ s: Any) {}
    open func shouldChangeText(in r: NSRange, replacementString s: String?) -> Bool { true }
    open func didChangeText() {}
    open func firstRect(forCharacterRange r: NSRange, actualRange: NSRangePointer?) -> NSRect { .zero }
    open func characterIndex(for p: NSPoint) -> Int { 0 }
    open func characterIndexForInsertion(at p: NSPoint) -> Int { 0 }
    open func performFindPanelAction(_ s: Any?) {}
    open func performTextFinderAction(_ s: Any?) {}
    open func setMarkedText(_ s: Any, selectedRange: NSRange, replacementRange: NSRange) {}
    open func hasMarkedText() -> Bool { false }
    open func unmarkText() {}
    open func markedRange() -> NSRange { NSRange(location: NSNotFound, length: 0) }
    open func drawInsertionPoint(in r: NSRect, color: NSColor, turnedOn: Bool) {}
    open func updateInsertionPointStateAndRestartTimer(_ b: Bool) {}
    open func readSelection(from pb: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { false }
    open func writeSelection(to pb: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool { false }
    open var readablePasteboardTypes: [NSPasteboard.PasteboardType] { [] }
    open func pasteAsPlainText(_ s: Any?) {}
    open func pasteAsRichText(_ s: Any?) {}
    public init(usingTextLayoutManager: Bool) { super.init(frame: .zero) }
    open func breakUndoCoalescing() {}
    open func setNeedsDisplay(_ r: NSRect) {}
    open func complete(_ s: Any?) {}
    open func toggleContinuousSpellChecking(_ s: Any?) {}
    open func underline(_ s: Any?) {}
    open func moveToBeginningOfDocument(_ s: Any?) {}
    open func moveToEndOfDocument(_ s: Any?) {}
    open func moveToBeginningOfLine(_ s: Any?) {}
    open func moveToEndOfLine(_ s: Any?) {}
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
open class NSTextAttachment: NSObject, @unchecked Sendable { public override init() {}; open var image: NSImage?; open var bounds: CGRect = .zero }
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

open class NSFontDescriptor: NSObject, @unchecked Sendable {
    public struct SymbolicTraits: OptionSet, Sendable { public let rawValue: UInt32; public init(rawValue: UInt32) { self.rawValue = rawValue }; public static let bold = SymbolicTraits(rawValue: 2), italic = SymbolicTraits(rawValue: 1), monoSpace = SymbolicTraits(rawValue: 1024), condensed = SymbolicTraits(rawValue: 64) }
    public enum SystemDesign: Sendable { case `default`, serif, rounded, monospaced }
    open var symbolicTraits: SymbolicTraits { [] }
    open func withSymbolicTraits(_ t: SymbolicTraits) -> NSFontDescriptor { self }
    open func withDesign(_ d: SystemDesign) -> NSFontDescriptor? { self }
    open func addingAttributes(_ a: [AttributeName: Any]) -> NSFontDescriptor { self }
    public struct AttributeName: RawRepresentable, Hashable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public static let traits = AttributeName(rawValue: "t"), family = AttributeName(rawValue: "f") }
    public struct TraitKey: RawRepresentable, Hashable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public static let weight = TraitKey(rawValue: "w") }
}
open class NSFont: NSObject, @unchecked Sendable {
    public struct Weight: RawRepresentable, Hashable, Sendable { public var rawValue: CGFloat; public init(rawValue: CGFloat) { self.rawValue = rawValue }
        public static let ultraLight = Weight(rawValue: -0.8), thin = Weight(rawValue: -0.6), light = Weight(rawValue: -0.4), regular = Weight(rawValue: 0), medium = Weight(rawValue: 0.23), semibold = Weight(rawValue: 0.3), bold = Weight(rawValue: 0.4), heavy = Weight(rawValue: 0.56), black = Weight(rawValue: 0.62) }
    public enum TextStyle: String, Sendable { case largeTitle, title1, title2, title3, headline, subheadline, body, callout, footnote, caption1, caption2 }
    public init?(name: String, size: CGFloat) {}
    public init?(descriptor: NSFontDescriptor, size: CGFloat) {}
    open class func systemFont(ofSize s: CGFloat) -> NSFont { NSFont() }
    open class func systemFont(ofSize s: CGFloat, weight: Weight) -> NSFont { NSFont() }
    open class func boldSystemFont(ofSize s: CGFloat) -> NSFont { NSFont() }
    open class func monospacedSystemFont(ofSize s: CGFloat, weight: Weight) -> NSFont { NSFont() }
    open class func monospacedDigitSystemFont(ofSize s: CGFloat, weight: Weight) -> NSFont { NSFont() }
    open class func userFixedPitchFont(ofSize s: CGFloat) -> NSFont? { nil }
    open class func preferredFont(forTextStyle s: TextStyle, options: [AnyHashable: Any] = [:]) -> NSFont { NSFont() }
    open class var systemFontSize: CGFloat { 13 }
    open class var smallSystemFontSize: CGFloat { 11 }
    open var pointSize: CGFloat { 13 }
    open var fontDescriptor: NSFontDescriptor { NSFontDescriptor() }
    open var fontName: String { "" }
    open var familyName: String? { nil }
    open var ascender: CGFloat { 0 }
    open var descender: CGFloat { 0 }
    open var leading: CGFloat { 0 }
    open var capHeight: CGFloat { 0 }
    open var xHeight: CGFloat { 0 }
    open func withSize(_ s: CGFloat) -> NSFont { self }
    public override init() {}
}
public struct NSFontTraitMask: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let boldFontMask = NSFontTraitMask(rawValue: 2), italicFontMask = NSFontTraitMask(rawValue: 1), unboldFontMask = NSFontTraitMask(rawValue: 4), unitalicFontMask = NSFontTraitMask(rawValue: 0x1000000), fixedPitchFontMask = NSFontTraitMask(rawValue: 0x400) }
@preconcurrency @MainActor open class NSFontManager: NSObject {
    public static let shared = NSFontManager()
    open func convert(_ f: NSFont, toHaveTrait t: NSFontTraitMask) -> NSFont { f }
    open func convert(_ f: NSFont, toNotHaveTrait t: NSFontTraitMask) -> NSFont { f }
    open func traits(of f: NSFont) -> NSFontTraitMask { [] }
    open func convert(_ f: NSFont, toSize s: CGFloat) -> NSFont { f }
}

open class NSAppearance: NSObject, @unchecked Sendable {
    public struct Name: RawRepresentable, Hashable, Sendable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public init(_ s: String) { rawValue = s }
        public static let aqua = Name("aqua"), darkAqua = Name("darkAqua"), vibrantLight = Name("vl"), vibrantDark = Name("vd") }
    public init?(named: Name) {}
    public override init() {}
    open var name: Name { .aqua }
    open func bestMatch(from names: [Name]) -> Name? { nil }
    open class var current: NSAppearance! { get { nil } set {} }
    open class var currentDrawing: NSAppearance { NSAppearance() }
    open func performAsCurrentDrawingAppearance(_ b: () -> Void) {}
}
open class NSColor: NSObject, @unchecked Sendable {
    public override init() {}
    public init(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {}
    public init(srgbRed: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {}
    public init(calibratedRed: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {}
    public init(deviceRed: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {}
    public init(white: CGFloat, alpha: CGFloat) {}
    public init(calibratedWhite: CGFloat, alpha: CGFloat) {}
    public init(hue: CGFloat, saturation: CGFloat, brightness: CGFloat, alpha: CGFloat) {}
    public init(name: NSColor.Name?, dynamicProvider: @escaping @Sendable (NSAppearance) -> NSColor) {}
    public init?(named: String) {}
    public init(cgColor: CGColor) {}
    public typealias Name = String
    open func withAlphaComponent(_ a: CGFloat) -> NSColor { self }
    open func usingColorSpace(_ s: NSColorSpace) -> NSColor? { self }
    open func blended(withFraction f: CGFloat, of c: NSColor) -> NSColor? { self }
    open var redComponent: CGFloat { 0 }
    open var greenComponent: CGFloat { 0 }
    open var blueComponent: CGFloat { 0 }
    open var alphaComponent: CGFloat { 1 }
    open var cgColor: CGColor { CGColor() }
    open func getRed(_ r: UnsafeMutablePointer<CGFloat>?, green: UnsafeMutablePointer<CGFloat>?, blue: UnsafeMutablePointer<CGFloat>?, alpha: UnsafeMutablePointer<CGFloat>?) {}
    open func set() {}
    open func setFill() {}
    open func setStroke() {}
    open class var clear: NSColor { NSColor() }
    open class var black: NSColor { NSColor() }
    open class var white: NSColor { NSColor() }
    open class var gray: NSColor { NSColor() }
    open class var red: NSColor { NSColor() }
    open class var blue: NSColor { NSColor() }
    open class var labelColor: NSColor { NSColor() }
    open class var secondaryLabelColor: NSColor { NSColor() }
    open class var tertiaryLabelColor: NSColor { NSColor() }
    open class var quaternaryLabelColor: NSColor { NSColor() }
    open class var textColor: NSColor { NSColor() }
    open class var textBackgroundColor: NSColor { NSColor() }
    open class var placeholderTextColor: NSColor { NSColor() }
    open class var selectedTextBackgroundColor: NSColor { NSColor() }
    open class var controlAccentColor: NSColor { NSColor() }
    open class var controlBackgroundColor: NSColor { NSColor() }
    open class var windowBackgroundColor: NSColor { NSColor() }
    open class var underPageBackgroundColor: NSColor { NSColor() }
    open class var separatorColor: NSColor { NSColor() }
    open class var gridColor: NSColor { NSColor() }
    open class var linkColor: NSColor { NSColor() }
    open class var systemBlue: NSColor { NSColor() }
    open class var systemRed: NSColor { NSColor() }
    open class var systemGreen: NSColor { NSColor() }
    open class var systemOrange: NSColor { NSColor() }
    open class var systemYellow: NSColor { NSColor() }
    open class var systemPurple: NSColor { NSColor() }
    open class var systemPink: NSColor { NSColor() }
    open class var systemGray: NSColor { NSColor() }
    open class var systemBrown: NSColor { NSColor() }
    open class var systemTeal: NSColor { NSColor() }
    open class var systemIndigo: NSColor { NSColor() }
    open class var systemFill: NSColor { NSColor() }
    open class var unemphasizedSelectedContentBackgroundColor: NSColor { NSColor() }
    open class var alternatingContentBackgroundColors: [NSColor] { [] }
}
open class NSColorSpace: NSObject, @unchecked Sendable { open class var sRGB: NSColorSpace { NSColorSpace() }; open class var deviceRGB: NSColorSpace { NSColorSpace() }; open class var genericRGB: NSColorSpace { NSColorSpace() } }

open class NSImage: NSObject, @unchecked Sendable {
    public override init() {}
    public init(size: NSSize) {}
    public init?(contentsOf url: URL) {}
    public init?(contentsOfFile: String) {}
    public init?(data: Data) {}
    public init?(named: String) {}
    public init?(systemSymbolName: String, accessibilityDescription: String?) {}
    open var size: NSSize = .zero
    open var tiffRepresentation: Data? { nil }
    open var isTemplate = false
    open func lockFocus() {}
    open func unlockFocus() {}
    open func draw(in r: NSRect) {}
    open func cgImage(forProposedRect: UnsafeMutablePointer<NSRect>?, context: Any?, hints: [AnyHashable: Any]?) -> CGImage? { nil }
}
public final class CGImage: @unchecked Sendable { public var width: Int { 0 }; public var height: Int { 0 } }
open class NSBitmapImageRep: NSObject, @unchecked Sendable {
    public enum FileType: UInt { case tiff, bmp, gif, jpeg, png, jpeg2000 }
    public struct PropertyKey: RawRepresentable, Hashable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public static let compressionFactor = PropertyKey(rawValue: "c") }
    public init?(data: Data) {}
    public init(cgImage: CGImage) {}
    open func representation(using t: FileType, properties: [PropertyKey: Any]) -> Data? { nil }
}

public struct NSEventModifierFlags: OptionSet, Sendable, Hashable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let capsLock = NSEventModifierFlags(rawValue: 1 << 16), shift = NSEventModifierFlags(rawValue: 1 << 17), control = NSEventModifierFlags(rawValue: 1 << 18), option = NSEventModifierFlags(rawValue: 1 << 19), command = NSEventModifierFlags(rawValue: 1 << 20), numericPad = NSEventModifierFlags(rawValue: 1 << 21), help = NSEventModifierFlags(rawValue: 1 << 22), function = NSEventModifierFlags(rawValue: 1 << 23), deviceIndependentFlagsMask = NSEventModifierFlags(rawValue: 0xffff0000) }
open class NSEvent: NSObject, @unchecked Sendable {
    public typealias ModifierFlags = NSEventModifierFlags
    public enum EventType: UInt, Sendable { case leftMouseDown = 1, leftMouseUp, rightMouseDown, rightMouseUp, mouseMoved, leftMouseDragged, rightMouseDragged, mouseEntered, mouseExited, keyDown, keyUp, flagsChanged, scrollWheel = 22, otherMouseDown = 25, swipe = 31 }
    public struct EventTypeMask: OptionSet, Sendable { public let rawValue: UInt64; public init(rawValue: UInt64) { self.rawValue = rawValue }
        public static let keyDown = EventTypeMask(rawValue: 1 << 10), keyUp = EventTypeMask(rawValue: 1 << 11), flagsChanged = EventTypeMask(rawValue: 1 << 12), leftMouseDown = EventTypeMask(rawValue: 2), leftMouseUp = EventTypeMask(rawValue: 4), rightMouseDown = EventTypeMask(rawValue: 8), mouseMoved = EventTypeMask(rawValue: 32), scrollWheel = EventTypeMask(rawValue: 1 << 22), leftMouseDragged = EventTypeMask(rawValue: 64), otherMouseDown = EventTypeMask(rawValue: 1 << 25), swipe = EventTypeMask(rawValue: 1 << 31), any = EventTypeMask(rawValue: .max) }
    open var modifierFlags: ModifierFlags { [] }
    open class var modifierFlags: ModifierFlags { [] }
    open class var pressedMouseButtons: Int { 0 }
    open class var mouseLocation: NSPoint { .zero }
    open var keyCode: UInt16 { 0 }
    open var characters: String? { nil }
    open var charactersIgnoringModifiers: String? { nil }
    open var locationInWindow: NSPoint { .zero }
    open var type: EventType { .keyDown }
    open var clickCount: Int { 1 }
    open var isARepeat: Bool { false }
    open var window: NSWindow? { nil }
    open var timestamp: TimeInterval { 0 }
    open var scrollingDeltaY: CGFloat { 0 }
    open var deltaY: CGFloat { 0 }
    open var deltaX: CGFloat { 0 }
    open var buttonNumber: Int { 0 }
    open class func addLocalMonitorForEvents(matching m: EventTypeMask, handler: @escaping (NSEvent) -> NSEvent?) -> Any? { nil }
    open class func addGlobalMonitorForEvents(matching m: EventTypeMask, handler: @escaping (NSEvent) -> Void) -> Any? { nil }
    open class func removeMonitor(_ m: Any) {}
}

@preconcurrency @MainActor open class NSCursor: NSObject {
    open class var arrow: NSCursor { NSCursor() }
    open class var iBeam: NSCursor { NSCursor() }
    open class var pointingHand: NSCursor { NSCursor() }
    open class var openHand: NSCursor { NSCursor() }
    open class var closedHand: NSCursor { NSCursor() }
    open class var resizeLeftRight: NSCursor { NSCursor() }
    open class var resizeUpDown: NSCursor { NSCursor() }
    open class var crosshair: NSCursor { NSCursor() }
    open class var operationNotAllowed: NSCursor { NSCursor() }
    open class var dragCopy: NSCursor { NSCursor() }
    open class func pop() {}
    open class func hide() {}
    open class func unhide() {}
    open class func setHiddenUntilMouseMoves(_ b: Bool) {}
    open func push() {}
    open func pop() {}
    open func set() {}
}

open class NSPasteboard: NSObject {
    public struct PasteboardType: RawRepresentable, Hashable, Sendable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public init(_ s: String) { rawValue = s }
        public static let string = PasteboardType("public.utf8-plain-text"), html = PasteboardType("public.html"), rtf = PasteboardType("public.rtf"), URL = PasteboardType("public.url"), fileURL = PasteboardType("public.file-url"), png = PasteboardType("public.png"), tiff = PasteboardType("public.tiff"), pdf = PasteboardType("com.adobe.pdf"), tabularText = PasteboardType("public.utf8-tab-separated-values-text"), multipleTextSelection = PasteboardType("m"), color = PasteboardType("c"), sound = PasteboardType("s"), textFinderOptions = PasteboardType("t") }
    public struct Name: RawRepresentable, Hashable, Sendable { public var rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }; public static let general = Name(rawValue: "g"), drag = Name(rawValue: "d"), find = Name(rawValue: "f") }
    public struct ReadingOptionKey: Hashable, RawRepresentable, Sendable { public let rawValue: String; public init(rawValue: String) { self.rawValue = rawValue }
        public static let urlReadingFileURLsOnly = ReadingOptionKey(rawValue: "f") }
    open class var general: NSPasteboard { NSPasteboard() }
    public init(name: Name) {}
    public override init() {}
    @discardableResult open func clearContents() -> Int { 0 }
    @discardableResult open func setString(_ s: String, forType t: PasteboardType) -> Bool { true }
    @discardableResult open func setData(_ d: Data?, forType t: PasteboardType) -> Bool { true }
    open func string(forType t: PasteboardType) -> String? { nil }
    open func data(forType t: PasteboardType) -> Data? { nil }
    open var types: [PasteboardType]? { nil }
    open var changeCount: Int { 0 }
    open func availableType(from types: [PasteboardType]) -> PasteboardType? { nil }
    open func readObjects(forClasses c: [AnyClass], options: [ReadingOptionKey: Any]?) -> [Any]? { nil }
    @discardableResult open func writeObjects(_ o: [Any]) -> Bool { true }
    @discardableResult open func declareTypes(_ t: [PasteboardType], owner: Any?) -> Int { 0 }
    open var pasteboardItems: [NSPasteboardItem]? { nil }
    open func canReadObject(forClasses c: [AnyClass], options: [ReadingOptionKey: Any]?) -> Bool { false }
}
open class NSPasteboardItem: NSObject { open func string(forType t: NSPasteboard.PasteboardType) -> String? { nil }; open func data(forType t: NSPasteboard.PasteboardType) -> Data? { nil }; open var types: [NSPasteboard.PasteboardType] { [] } }

open class NSWorkspace: NSObject {
    public static let shared = NSWorkspace()
    @discardableResult open func open(_ url: URL) -> Bool { true }
    open func open(_ url: URL, configuration: OpenConfiguration, completionHandler: ((NSRunningApplication?, Error?) -> Void)? = nil) {}
    open func open(_ urls: [URL], withApplicationAt: URL, configuration: OpenConfiguration, completionHandler: ((NSRunningApplication?, Error?) -> Void)? = nil) {}
    open func activateFileViewerSelecting(_ urls: [URL]) {}
    @discardableResult open func selectFile(_ path: String?, inFileViewerRootedAtPath: String) -> Bool { true }
    open func urlForApplication(withBundleIdentifier: String) -> URL? { nil }
    open func urlForApplication(toOpen url: URL) -> URL? { nil }
    open func icon(forFile: String) -> NSImage { NSImage() }
    open var runningApplications: [NSRunningApplication] { [] }
    open var frontmostApplication: NSRunningApplication? { nil }
    open var notificationCenter: NotificationCenter { .default }
    public class OpenConfiguration: NSObject { public override init() {}; open var activates = true; open var arguments: [String] = [] }
}
open class NSRunningApplication: NSObject { open class var current: NSRunningApplication { NSRunningApplication() }; open var bundleIdentifier: String? { nil }; open var localizedName: String? { nil }; open var processIdentifier: Int32 { 0 }; @discardableResult open func activate(options: Int = 0) -> Bool { true } }

public struct NSWindowStyleMask: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
    public static let borderless = NSWindowStyleMask([]), titled = NSWindowStyleMask(rawValue: 1), closable = NSWindowStyleMask(rawValue: 2), miniaturizable = NSWindowStyleMask(rawValue: 4), resizable = NSWindowStyleMask(rawValue: 8), fullSizeContentView = NSWindowStyleMask(rawValue: 1 << 15), fullScreen = NSWindowStyleMask(rawValue: 1 << 14), unifiedTitleAndToolbar = NSWindowStyleMask(rawValue: 1 << 12) }
@preconcurrency @MainActor open class NSToolbar: NSObject { open var isVisible = true; open var showsBaselineSeparator = true; open var displayMode: Int = 0 }
@preconcurrency @MainActor open class NSButton: NSView { open var isEnabled = true; open var title = ""; open var target: AnyObject?; open var action: Selector? }
@preconcurrency @MainActor open class NSWindow: NSResponder {
    open func nextEvent(matching mask: NSEvent.EventTypeMask) -> NSEvent? { nil }
    open func performMiniaturize(_ sender: Any?) {}
    open func performZoom(_ sender: Any?) {}
    open func performDrag(with event: NSEvent) {}
    public static let didResizeNotification = Notification.Name("NSWindowDidResizeNotification")
    public static let didEndLiveResizeNotification = Notification.Name("NSWindowDidEndLiveResizeNotification")
    public static let didBecomeKeyNotification = Notification.Name("NSWindowDidBecomeKeyNotification")
    public static let didResignKeyNotification = Notification.Name("NSWindowDidResignKeyNotification")
    public static let didExitFullScreenNotification = Notification.Name("NSWindowDidExitFullScreenNotification")
    public enum TitleVisibility: Int, Sendable { case visible = 0, hidden = 1 }
    public enum ButtonType: UInt, Sendable { case closeButton, miniaturizeButton, zoomButton, toolbarButton, documentIconButton, documentVersionsButton }
    public enum TabbingMode: Int, Sendable { case automatic, preferred, disallowed }
    public enum ToolbarStyle: Int, Sendable { case automatic, expanded, preference, unified, unifiedCompact }
    public typealias StyleMask = NSWindowStyleMask
    public struct CollectionBehavior: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let fullScreenPrimary = CollectionBehavior(rawValue: 128) }
    public struct Level: RawRepresentable, Hashable, Sendable { public var rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let normal = Level(rawValue: 0), floating = Level(rawValue: 3) }
    public override init() {}
    public init(contentRect: NSRect, styleMask: StyleMask, backing: Int, defer: Bool) {}
    open var title: String = ""
    open var subtitle: String = ""
    open var titleVisibility: TitleVisibility = .visible
    open var titlebarAppearsTransparent = false
    open var titlebarSeparatorStyle: Int = 0
    open var styleMask: StyleMask = []
    open var toolbar: NSToolbar?
    open var toolbarStyle: ToolbarStyle = .automatic
    open var isMovableByWindowBackground = false
    open var isMovable = true
    open var contentView: NSView?
    open var contentViewController: AnyObject?
    open var firstResponder: NSResponder? { nil }
    @discardableResult open func makeFirstResponder(_ r: NSResponder?) -> Bool { true }
    open func standardWindowButton(_ b: ButtonType) -> NSButton? { nil }
    open var frame: NSRect { .zero }
    open func setFrame(_ r: NSRect, display: Bool) {}
    open func setFrameAutosaveName(_ n: String) -> Bool { true }
    open var tabbingMode: TabbingMode = .automatic
    open var tabbingIdentifier: String = ""
    open func toggleFullScreen(_ s: Any?) {}
    open func performClose(_ s: Any?) {}
    open func close() {}
    open func makeKeyAndOrderFront(_ s: Any?) {}
    open func orderOut(_ s: Any?) {}
    open var isVisible: Bool { true }
    open var isKeyWindow: Bool { true }
    open var isMainWindow: Bool { true }
    open var backgroundColor: NSColor = .clear
    open var isOpaque = true
    open var hasShadow = true
    open var collectionBehavior: CollectionBehavior = []
    open var level: Level = .normal
    open var effectiveAppearance: NSAppearance { NSAppearance() }
    open var appearance: NSAppearance?
    open var windowNumber: Int { 0 }
    open var identifier: String?
    open var screen: NSScreen? { nil }
    open var minSize: NSSize = .zero
    open var contentLayoutRect: NSRect { .zero }
    open func convertPoint(fromScreen p: NSPoint) -> NSPoint { p }
    open func convertToScreen(_ r: NSRect) -> NSRect { r }
    open func convertFromScreen(_ r: NSRect) -> NSRect { r }
    open var mouseLocationOutsideOfEventStream: NSPoint { .zero }
    open func center() {}
    open var attachedSheet: NSWindow? { nil }
    open var sheets: [NSWindow] { [] }
}
@preconcurrency @MainActor open class NSPanel: NSWindow {}
@preconcurrency @MainActor open class NSScreen: NSObject { open class var main: NSScreen? { nil }; open var frame: NSRect { .zero }; open var visibleFrame: NSRect { .zero }; open var backingScaleFactor: CGFloat { 2 } }
@preconcurrency @MainActor open class NSViewController: NSResponder { open var view: NSView = NSView() }
@preconcurrency @MainActor open class NSSplitViewController: NSViewController { open func toggleSidebar(_ s: Any?) {} }

@preconcurrency @MainActor open class NSApplication: NSResponder {
    public static var shared: NSApplication { NSApplication() }
    public enum ActivationPolicy: Int { case regular, accessory, prohibited }
    public struct ModalResponse: RawRepresentable, Hashable, Sendable { public var rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }; public static let OK = ModalResponse(rawValue: 1), cancel = ModalResponse(rawValue: 0), alertFirstButtonReturn = ModalResponse(rawValue: 1000), alertSecondButtonReturn = ModalResponse(rawValue: 1001), stop = ModalResponse(rawValue: -1000) }
    public static let didBecomeActiveNotification = Notification.Name("a"), willTerminateNotification = Notification.Name("b"), didResignActiveNotification = Notification.Name("c"), willResignActiveNotification = Notification.Name("d")
    @discardableResult open func sendAction(_ a: Selector, to: Any?, from: Any?) -> Bool { true }
    open var keyWindow: NSWindow? { nil }
    open var mainWindow: NSWindow? { nil }
    open var windows: [NSWindow] { [] }
    open var currentEvent: NSEvent? { nil }
    open var isActive: Bool { true }
    open var appearance: NSAppearance?
    open var effectiveAppearance: NSAppearance { NSAppearance() }
    open var mainMenu: NSMenu?
    open var dockTile: NSDockTile { NSDockTile() }
    open func activate(ignoringOtherApps: Bool) {}
    open func activate() {}
    open func terminate(_ s: Any?) {}
    open func hide(_ s: Any?) {}
    open func orderFrontStandardAboutPanel(_ s: Any?) {}
    open func orderFrontStandardAboutPanel(options: [AnyHashable: Any]) {}
    open func setActivationPolicy(_ p: ActivationPolicy) -> Bool { true }
    open func requestUserAttention(_ t: Int) -> Int { 0 }
    open func runModal(for w: NSWindow) -> ModalResponse { .OK }
    open func beginSheet(_ s: NSWindow, completionHandler: ((ModalResponse) -> Void)?) {}
}
@preconcurrency @MainActor open class NSDockTile: NSObject { open var badgeLabel: String? }
@preconcurrency @MainActor public var NSApp: NSApplication! = NSApplication.shared

@preconcurrency @MainActor open class NSSavePanel: NSWindow {
    open var canCreateDirectories = true
    open var allowedContentTypes: [Any] = []
    open var nameFieldStringValue: String = ""
    open var message: String = ""
    open var prompt: String = ""
    open var directoryURL: URL?
    open var url: URL? { nil }
    open var showsTagField = true
    open func runModal() -> NSApplication.ModalResponse { .OK }
    open func begin(completionHandler: @escaping (NSApplication.ModalResponse) -> Void) {}
    open func beginSheetModal(for w: NSWindow, completionHandler: @escaping (NSApplication.ModalResponse) -> Void) {}
}
@preconcurrency @MainActor open class NSOpenPanel: NSSavePanel {
    open var canChooseFiles = true
    open var canChooseDirectories = false
    open var allowsMultipleSelection = false
    open var resolvesAliases = true
    open var urls: [URL] { [] }
}
@preconcurrency @MainActor open class NSAlert: NSObject {
    public enum Style: UInt { case warning, informational, critical }
    open var messageText = ""
    open var informativeText = ""
    open var alertStyle: Style = .warning
    @discardableResult open func addButton(withTitle t: String) -> NSButton { NSButton() }
    open func runModal() -> NSApplication.ModalResponse { .OK }
}
@preconcurrency @MainActor open class NSSound: NSObject { open class func beep() {} }
public func NSBeep() {}

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
