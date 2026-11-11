// Type-check stub of UIKit (subset used by Based's iOS branches, BSD-95). Signatures mirror Apple's API;
// bodies are dummies. Shares the Objective-C/Foundation pieces with the AppKit stub through StubBase.
@_exported import StubBase

public typealias _PlatformView = UIView
public typealias _PlatformColor = UIColor
public typealias _PlatformFont = UIFont

@preconcurrency @MainActor open class UIResponder: NSObject {
    public override init() {}
    open var next: UIResponder? { nil }
    open var isFirstResponder: Bool { false }
    open func becomeFirstResponder() -> Bool { true }
    open func resignFirstResponder() -> Bool { true }
    open var undoManager: UndoManager? { nil }
    open var keyCommands: [UIKeyCommand]? { nil }
    open func paste(_ sender: Any?) {}
    open func copy(_ sender: Any?) {}
    open func cut(_ sender: Any?) {}
    open func toggleBoldface(_ sender: Any?) {}
    open func toggleItalics(_ sender: Any?) {}
    open func toggleUnderline(_ sender: Any?) {}
    open func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool { false }
}
public struct UIEdgeInsets: Hashable, Sendable {
    public var top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat
    public init(top: CGFloat, left: CGFloat, bottom: CGFloat, right: CGFloat) { self.top = top; self.left = left; self.bottom = bottom; self.right = right }
    public static let zero = UIEdgeInsets(top: 0, left: 0, bottom: 0, right: 0)
}
@preconcurrency @MainActor open class UIView: UIResponder {
    public override init() {}
    public init(frame: CGRect) {}
    public required init?(coder: NSCoder) {}
    open var frame: CGRect = .zero
    open var bounds: CGRect = .zero
    open var backgroundColor: UIColor?
    open var isOpaque = true
    open var isHidden = false
    open var alpha: CGFloat = 1
    open var tintColor: UIColor!
    open var isUserInteractionEnabled = true
    open var translatesAutoresizingMaskIntoConstraints = true
    open var intrinsicContentSize: CGSize { .zero }
    open var superview: UIView? { nil }
    open var subviews: [UIView] { [] }
    open var window: UIWindow? { nil }
    open var layer: CALayer { CALayer() }
    open func addSubview(_ v: UIView) {}
    open func removeFromSuperview() {}
    open func setNeedsLayout() {}
    open func layoutIfNeeded() {}
    open func layoutSubviews() {}
    open func setNeedsDisplay() {}
    open func invalidateIntrinsicContentSize() {}
    open func sizeThatFits(_ size: CGSize) -> CGSize { .zero }
    open func sizeToFit() {}
    open func didMoveToWindow() {}
    open func convert(_ r: CGRect, to v: UIView?) -> CGRect { r }
    open func convert(_ p: CGPoint, from v: UIView?) -> CGPoint { p }
    open var leadingAnchor: NSLayoutXAxisAnchor { NSLayoutXAxisAnchor() }
    open var trailingAnchor: NSLayoutXAxisAnchor { NSLayoutXAxisAnchor() }
    open var topAnchor: NSLayoutYAxisAnchor { NSLayoutYAxisAnchor() }
    open var bottomAnchor: NSLayoutYAxisAnchor { NSLayoutYAxisAnchor() }
    open var widthAnchor: NSLayoutDimension { NSLayoutDimension() }
    open var heightAnchor: NSLayoutDimension { NSLayoutDimension() }
    open func addInteraction(_ i: UIInteraction) {}
    public struct AutoresizingMask: OptionSet, Sendable {
        public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }
        public static let flexibleWidth = AutoresizingMask(rawValue: 2), flexibleHeight = AutoresizingMask(rawValue: 16)
    }
    open var autoresizingMask: AutoresizingMask = []
    open func setContentCompressionResistancePriority(_ p: UILayoutPriority, for axis: NSLayoutConstraint.Axis) {}
    open func setContentHuggingPriority(_ p: UILayoutPriority, for axis: NSLayoutConstraint.Axis) {}
}
@preconcurrency @MainActor open class CALayer: NSObject { open var cornerRadius: CGFloat = 0; open var masksToBounds = false }
@preconcurrency @MainActor open class UIWindow: UIView {}
@preconcurrency @MainActor public protocol UIInteraction: NSObjectProtocol {}
@preconcurrency @MainActor open class NSLayoutAnchor<T: AnyObject>: NSObject {
    open func constraint(equalTo a: NSLayoutAnchor<T>, constant: CGFloat = 0) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(greaterThanOrEqualTo a: NSLayoutAnchor<T>, constant: CGFloat = 0) -> NSLayoutConstraint { NSLayoutConstraint() }
    open func constraint(lessThanOrEqualTo a: NSLayoutAnchor<T>, constant: CGFloat = 0) -> NSLayoutConstraint { NSLayoutConstraint() }
}
@preconcurrency @MainActor open class NSLayoutXAxisAnchor: NSLayoutAnchor<NSLayoutXAxisAnchor> {}
@preconcurrency @MainActor open class NSLayoutYAxisAnchor: NSLayoutAnchor<NSLayoutYAxisAnchor> {}
@preconcurrency @MainActor open class NSLayoutDimension: NSLayoutAnchor<NSLayoutDimension> { open func constraint(equalToConstant c: CGFloat) -> NSLayoutConstraint { NSLayoutConstraint() } }
@preconcurrency @MainActor open class NSLayoutConstraint: NSObject {
    public enum Axis: Int, Sendable { case horizontal, vertical }
    open var constant: CGFloat = 0
    open var isActive = false
    open var priority: UILayoutPriority = .required
    open class func activate(_ c: [NSLayoutConstraint]) {}
    open class func deactivate(_ c: [NSLayoutConstraint]) {}
}
public struct UILayoutPriority: RawRepresentable, Hashable, Sendable, ExpressibleByFloatLiteral {
    public var rawValue: Float; public init(rawValue: Float) { self.rawValue = rawValue }; public init(_ v: Float) { rawValue = v }; public init(floatLiteral v: Float) { rawValue = v }
    public static let required = UILayoutPriority(1000), defaultHigh = UILayoutPriority(750), defaultLow = UILayoutPriority(250)
}
@preconcurrency @MainActor open class UIViewController: UIResponder {
    open var view: UIView! { nil }
    open func viewDidLoad() {}
    /// BSD-131: share extension host context.
    open var extensionContext: NSExtensionContext? { nil }
    open func present(_ vc: UIViewController, animated: Bool, completion: (() -> Void)? = nil) {}
    open func dismiss(animated: Bool, completion: (() -> Void)? = nil) {}
}
@preconcurrency @MainActor open class UILabel: UIView {
    open var text: String?
    open var attributedText: NSAttributedString?
    open var font: UIFont!
    open var textColor: UIColor!
    open var numberOfLines = 1
    open var textAlignment: NSTextAlignment = .natural
}
@preconcurrency @MainActor open class UIScrollView: UIView {
    open var isScrollEnabled = true
    open var contentInset: UIEdgeInsets = .zero
    open var contentOffset: CGPoint = .zero
    open var contentSize: CGSize = .zero
    open var showsVerticalScrollIndicator = true
    open var showsHorizontalScrollIndicator = true
    open var bounces = true
    open var keyboardDismissMode: KeyboardDismissMode = .none
    public enum KeyboardDismissMode: Int, Sendable { case none, onDrag, interactive }
}
open class UITextPosition: NSObject {}
open class UITextRange: NSObject { open var start: UITextPosition { UITextPosition() }; open var end: UITextPosition { UITextPosition() }; open var isEmpty: Bool { true } }
public enum UITextLayoutDirection: Int, Sendable { case right = 2, left, up, down }
public enum UITextAutocorrectionType: Int, Sendable { case `default`, no, yes }
public enum UITextAutocapitalizationType: Int, Sendable { case none, words, sentences, allCharacters }
public enum UITextSpellCheckingType: Int, Sendable { case `default`, no, yes }
public enum UITextSmartQuotesType: Int, Sendable { case `default`, no, yes }
public enum UITextSmartDashesType: Int, Sendable { case `default`, no, yes }
public enum UIReturnKeyType: Int, Sendable { case `default`, go, next, done, send }
public enum UIKeyboardType: Int, Sendable { case `default`, asciiCapable, URL, numberPad, emailAddress, decimalPad, webSearch }
@preconcurrency @MainActor public protocol UITextViewDelegate: NSObjectProtocol {}
extension UITextViewDelegate {
    public func textViewDidChange(_ tv: UITextView) {}
    public func textViewDidChangeSelection(_ tv: UITextView) {}
    public func textViewDidBeginEditing(_ tv: UITextView) {}
    public func textViewDidEndEditing(_ tv: UITextView) {}
    public func textView(_ tv: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool { true }
}
@preconcurrency @MainActor open class UITextView: UIScrollView {
    public init(frame: CGRect, textContainer: NSTextContainer?) { super.init(frame: frame) }
    public init(usingTextLayoutManager: Bool) { super.init(frame: .zero) }
    public override init(frame: CGRect) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    open weak var delegate: (any UITextViewDelegate)?
    open var text: String!
    open var attributedText: NSAttributedString!
    open var font: UIFont?
    open var textColor: UIColor?
    open var textAlignment: NSTextAlignment = .natural
    open var isEditable = true
    open var isSelectable = true
    open var allowsEditingTextAttributes = false
    open var selectedRange = NSRange(location: 0, length: 0)
    open var typingAttributes: [NSAttributedString.Key: Any] = [:]
    open var linkTextAttributes: [NSAttributedString.Key: Any]! = [:]
    open var textContainerInset: UIEdgeInsets = .zero
    open var textStorage: NSTextStorage { fatalError() }
    open var layoutManager: NSLayoutManager { NSLayoutManager() }
    open var textContainer: NSTextContainer { NSTextContainer() }
    open var inputAccessoryView: UIView?
    open var autocorrectionType: UITextAutocorrectionType = .default
    open var autocapitalizationType: UITextAutocapitalizationType = .sentences
    open var spellCheckingType: UITextSpellCheckingType = .default
    open var smartQuotesType: UITextSmartQuotesType = .default
    open var smartDashesType: UITextSmartDashesType = .default
    open var returnKeyType: UIReturnKeyType = .default
    open var keyboardType: UIKeyboardType = .default
    open var dataDetectorTypes: UIDataDetectorTypes = []
    open var markedTextRange: UITextRange? { nil }
    open var selectedTextRange: UITextRange?
    open var beginningOfDocument: UITextPosition { UITextPosition() }
    open var endOfDocument: UITextPosition { UITextPosition() }
    open func textRange(from a: UITextPosition, to b: UITextPosition) -> UITextRange? { nil }
    open func position(from p: UITextPosition, offset: Int) -> UITextPosition? { nil }
    open func position(from p: UITextPosition, in d: UITextLayoutDirection, offset: Int) -> UITextPosition? { nil }
    open func offset(from a: UITextPosition, to b: UITextPosition) -> Int { 0 }
    open func caretRect(for p: UITextPosition) -> CGRect { .zero }
    open func firstRect(for r: UITextRange) -> CGRect { .zero }
    open func insertText(_ s: String) {}
    open func deleteBackward() {}
    open func scrollRangeToVisible(_ r: NSRange) {}
}
public struct UIDataDetectorTypes: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let link = UIDataDetectorTypes(rawValue: 2) }
public struct UIKeyModifierFlags: OptionSet, Sendable, Hashable { public let rawValue: Int; public init(rawValue: Int) { self.rawValue = rawValue }
    public static let alphaShift = UIKeyModifierFlags(rawValue: 1 << 16), shift = UIKeyModifierFlags(rawValue: 1 << 17), control = UIKeyModifierFlags(rawValue: 1 << 18), alternate = UIKeyModifierFlags(rawValue: 1 << 19), command = UIKeyModifierFlags(rawValue: 1 << 20) }
open class UIMenuElement: NSObject, @unchecked Sendable {}
open class UICommand: UIMenuElement, @unchecked Sendable {}
open class UIKeyCommand: UICommand, @unchecked Sendable {
    public init(input: String, modifierFlags: UIKeyModifierFlags, action: Selector) {}
    public init(title: String, image: UIImage? = nil, action: Selector, input: String, modifierFlags: UIKeyModifierFlags = [], propertyList: Any? = nil) {}
    open var wantsPriorityOverSystemBehavior = false
    open var input: String? { nil }
    open var modifierFlags: UIKeyModifierFlags { [] }
    public static let inputUpArrow = "UIKeyInputUpArrow", inputDownArrow = "UIKeyInputDownArrow", inputLeftArrow = "UIKeyInputLeftArrow", inputRightArrow = "UIKeyInputRightArrow", inputEscape = "UIKeyInputEscape"
}
open class UIAction: UIMenuElement, @unchecked Sendable {
    public struct Identifier: Hashable, Sendable { public init(_ s: String) {} }
    public struct Attributes: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let destructive = Attributes(rawValue: 2), disabled = Attributes(rawValue: 1) }
    public enum State: Int, Sendable { case off, on, mixed }
    public convenience init(title: String = "", image: UIImage? = nil, identifier: Identifier? = nil, discoverabilityTitle: String? = nil, attributes: Attributes = [], state: State = .off, handler: @escaping @MainActor (UIAction) -> Void) { self.init() }
}
open class UIMenu: UIMenuElement, @unchecked Sendable {
    public struct Options: OptionSet, Sendable { public let rawValue: UInt; public init(rawValue: UInt) { self.rawValue = rawValue }; public static let displayInline = Options(rawValue: 1), destructive = Options(rawValue: 2) }
    public convenience init(title: String = "", image: UIImage? = nil, identifier: String? = nil, options: Options = [], children: [UIMenuElement] = []) { self.init() }
    open var children: [UIMenuElement] { [] }
}
@preconcurrency @MainActor open class UIBarItem: NSObject {}
@preconcurrency @MainActor open class UIBarButtonItem: UIBarItem {
    public enum Style: Int, Sendable { case plain, done }
    public enum SystemItem: Int, Sendable { case done, cancel, flexibleSpace, fixedSpace, add }
    public init(image: UIImage?, style: Style, target: Any?, action: Selector?) {}
    public init(title: String?, style: Style, target: Any?, action: Selector?) {}
    public init(barButtonSystemItem: SystemItem, target: Any?, action: Selector?) {}
    public init(image: UIImage?, menu: UIMenu?) {}
    open var isEnabled = true
    open var tintColor: UIColor?
}
@preconcurrency @MainActor open class UIToolbar: UIView {
    open var items: [UIBarButtonItem]?
    open func setItems(_ items: [UIBarButtonItem]?, animated: Bool) {}
}
@preconcurrency @MainActor open class UIApplication: UIResponder {
    open class var shared: UIApplication { UIApplication() }
    public enum State: Int, Sendable { case active, inactive, background }
    open var applicationState: State { .active }
    open func open(_ url: URL, options: [OpenExternalURLOptionsKey: Any] = [:], completionHandler: (@MainActor @Sendable (Bool) -> Void)? = nil) {}
    open func canOpenURL(_ url: URL) -> Bool { true }
    public struct OpenExternalURLOptionsKey: Hashable, Sendable { public init(rawValue: String) {} }
    nonisolated public static let didEnterBackgroundNotification = Notification.Name("UIApplicationDidEnterBackgroundNotification")
    nonisolated public static let willEnterForegroundNotification = Notification.Name("UIApplicationWillEnterForegroundNotification")
    nonisolated public static let willTerminateNotification = Notification.Name("UIApplicationWillTerminateNotification")
    nonisolated public static let didBecomeActiveNotification = Notification.Name("UIApplicationDidBecomeActiveNotification")
    nonisolated public static let willResignActiveNotification = Notification.Name("UIApplicationWillResignActiveNotification")
    nonisolated public static let didReceiveMemoryWarningNotification = Notification.Name("UIApplicationDidReceiveMemoryWarningNotification")
}
@preconcurrency @MainActor open class UIDevice: NSObject {
    open class var current: UIDevice { UIDevice() }
    open var name: String { "" }
    open var model: String { "" }
    open var systemName: String { "" }
    open var systemVersion: String { "" }
    public enum UserInterfaceIdiom: Int, Sendable { case unspecified = -1, phone, pad, tv, carPlay, mac = 5, vision = 6 }
    open var userInterfaceIdiom: UserInterfaceIdiom { .phone }
}
open class UIPasteboard: NSObject, @unchecked Sendable {
    open class var general: UIPasteboard { UIPasteboard() }
    open var string: String?
    open var strings: [String]?
    open var url: URL?
    open var image: UIImage?
    open var hasStrings: Bool { false }
    open func setValue(_ v: Any, forPasteboardType t: String) {}
    open func data(forPasteboardType t: String) -> Data? { nil }
    open var items: [[String: Any]] = []
    open func setItems(_ items: [[String: Any]], options: [String: Any] = [:]) {}
}
open class UIColor: NSObject, @unchecked Sendable {
    public override init() {}
    public init(red: CGFloat, green: CGFloat, blue: CGFloat, alpha: CGFloat) {}
    public init(white: CGFloat, alpha: CGFloat) {}
    public init(dynamicProvider: @escaping (UITraitCollection) -> UIColor) {}
    open class var clear: UIColor { UIColor() }
    open class var black: UIColor { UIColor() }
    open class var white: UIColor { UIColor() }
    open class var label: UIColor { UIColor() }
    open class var secondaryLabel: UIColor { UIColor() }
    open class var systemBackground: UIColor { UIColor() }
    open class var secondarySystemBackground: UIColor { UIColor() }
    open class var separator: UIColor { UIColor() }
    open class var tintColor: UIColor { UIColor() }
    open class var placeholderText: UIColor { UIColor() }
    open class var systemBlue: UIColor { UIColor() }
    open class var systemRed: UIColor { UIColor() }
    open class var systemGray: UIColor { UIColor() }
    open class var link: UIColor { UIColor() }
    open var cgColor: CGColor { fatalError() }
    open func withAlphaComponent(_ a: CGFloat) -> UIColor { self }
    open func getRed(_ r: UnsafeMutablePointer<CGFloat>?, green: UnsafeMutablePointer<CGFloat>?, blue: UnsafeMutablePointer<CGFloat>?, alpha: UnsafeMutablePointer<CGFloat>?) -> Bool { false }
}
public enum UIUserInterfaceStyle: Int, Sendable { case unspecified, light, dark }
open class UITraitCollection: NSObject, @unchecked Sendable { open var userInterfaceStyle: UIUserInterfaceStyle { .light } }
open class UIFont: NSObject, @unchecked Sendable {
    public override init() {}
    public struct Weight: Hashable, Sendable { public init(_ v: CGFloat) {}; public static let ultraLight = Weight(0), thin = Weight(0), light = Weight(0), regular = Weight(0), medium = Weight(0), semibold = Weight(0), bold = Weight(0), heavy = Weight(0), black = Weight(0) }
    public enum TextStyle: Sendable { case largeTitle, title1, title2, title3, headline, subheadline, body, callout, footnote, caption1, caption2 }
    public init?(name: String, size: CGFloat) {}
    open class func systemFont(ofSize s: CGFloat) -> UIFont { UIFont() }
    open class func systemFont(ofSize s: CGFloat, weight: Weight) -> UIFont { UIFont() }
    open class func boldSystemFont(ofSize s: CGFloat) -> UIFont { UIFont() }
    open class func italicSystemFont(ofSize s: CGFloat) -> UIFont { UIFont() }
    open class func monospacedSystemFont(ofSize s: CGFloat, weight: Weight) -> UIFont { UIFont() }
    open class func preferredFont(forTextStyle s: TextStyle) -> UIFont { UIFont() }
    open var pointSize: CGFloat { 0 }
    open var lineHeight: CGFloat { 0 }
    open var fontDescriptor: UIFontDescriptor { UIFontDescriptor() }
    public init(descriptor: UIFontDescriptor, size: CGFloat) {}
    open func withSize(_ s: CGFloat) -> UIFont { self }
}
open class UIFontDescriptor: NSObject, @unchecked Sendable {
    public struct SymbolicTraits: OptionSet, Sendable { public let rawValue: UInt32; public init(rawValue: UInt32) { self.rawValue = rawValue }; public static let traitItalic = SymbolicTraits(rawValue: 1), traitBold = SymbolicTraits(rawValue: 2), traitMonoSpace = SymbolicTraits(rawValue: 1 << 10) }
    open var symbolicTraits: SymbolicTraits { [] }
    open func withSymbolicTraits(_ t: SymbolicTraits) -> UIFontDescriptor? { self }
    public enum SystemDesign: Sendable { case `default`, serif, rounded, monospaced }
    open func withDesign(_ d: SystemDesign) -> UIFontDescriptor? { self }
}
open class UIImage: NSObject, @unchecked Sendable {
    public override init() {}
    public init?(data: Data) {}
    public init?(contentsOfFile path: String) {}
    public init?(systemName: String) {}
    public init?(named: String) {}
    public init(cgImage: CGImage) {}
    open var size: CGSize { .zero }
    open var cgImage: CGImage? { nil }
    open func pngData() -> Data? { nil }
    open func jpegData(compressionQuality: CGFloat) -> Data? { nil }
}
extension NSTextAttachment { public var image: UIImage? { get { nil } set {} } }
