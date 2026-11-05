import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// How a block's text view looks and behaves.
struct RichTextConfig: Equatable {
    var style: TextStyle
    var placeholder: String = ""
    /// Show the placeholder even when the view is not focused (headings, titles).
    var alwaysShowPlaceholder = false
    /// Plain text editing (code blocks).
    var plain = false
    var editable = true
}

/// Bridges one platform text view to the page's `EditorController`.
@MainActor
final class TextCoordinator: NSObject, TextHost {
    let id: RecordID
    var controller: EditorController
    var config: RichTextConfig
    /// The rich text currently shown in the view (what we last loaded or read back).
    var applied = RichText()
    var lastWasInsert = false
    var isApplying = false
    private var normalizedOnce = false
    #if os(macOS)
    weak var view: BasedNSTextView?
    #else
    weak var view: BasedUITextView?
    #endif

    init(id: RecordID, controller: EditorController, config: RichTextConfig) {
        self.id = id
        self.controller = controller
        self.config = config
    }

    var hostBlockID: RecordID { id }
    var store: WorkspaceStore { controller.store }

    // MARK: Loading

    func update(text: RichText, config newConfig: RichTextConfig, controller: EditorController) {
        self.controller = controller
        let styleChanged = newConfig != config
        config = newConfig
        applyConfig()
        if styleChanged || text != applied {
            load(text, selection: currentSelection())
        }
    }

    func applyConfig() {
        guard let v = view else { return }
        #if os(macOS)
        if v.isEditable != config.editable { v.isEditable = config.editable }
        v.placeholder = config.placeholder
        v.showsPlaceholderAlways = config.alwaysShowPlaceholder
        v.needsDisplay = true
        #else
        if v.isEditable != config.editable { v.isEditable = config.editable }
        v.placeholderLabel.text = config.placeholder
        v.placeholderLabel.font = Theme.baseFont(for: config.style.type, format: config.style.format)
        v.updatePlaceholder()
        #endif
    }

    func currentSelection() -> NSRange? {
        guard view != nil else { return nil }
        return viewSelection
    }

    /// Selected range of the platform view (NSTextView exposes it as a method, UITextView as a property).
    var viewSelection: NSRange {
        #if os(macOS)
        return view?.selectedRange() ?? NSRange(location: 0, length: 0)
        #else
        return view?.selectedRange ?? NSRange(location: 0, length: 0)
        #endif
    }

    func load(_ rt: RichText, selection: NSRange?) {
        guard let v = view else { return }
        isApplying = true
        let attr = AttributedBridge.attributed(rt, style: config.style, store: store)
        #if os(macOS)
        v.textStorage?.setAttributedString(attr)
        #else
        v.textStorage.setAttributedString(attr)
        #endif
        applied = AttributedBridge.richText(attr, plain: config.plain)
        let len = attr.length
        if let s = selection {
            let loc = max(0, min(s.location, len))
            let r = NSRange(location: loc, length: max(0, min(s.length, len - loc)))
            #if os(macOS)
            v.setSelectedRange(r)
            #else
            v.selectedRange = r
            #endif
        }
        resetTypingAttributes()
        isApplying = false
        #if os(macOS)
        v.invalidateIntrinsicContentSize()
        v.needsDisplay = true
        #else
        v.updatePlaceholder()
        v.invalidateIntrinsicContentSize()
        #endif
        // Mentions display the current page title; persist it once so offsets match the view.
        if !config.plain, applied.plainText != rt.plainText, !normalizedOnce {
            normalizedOnce = true
            let fixed = applied
            let bid = id
            let s = store
            DispatchQueue.main.async {
                s.transact("Update mentions", undoable: false) { tx in tx.update(bid) { $0.text = fixed } }
            }
        }
    }

    func resetTypingAttributes() {
        guard let v = view else { return }
        let loc = viewSelection.location
        let marks = config.plain ? Marks.plain : applied.marks(at: loc)
        v.typingAttributes = AttributedBridge.typingAttributes(marks, style: config.style)
    }

    // MARK: TextHost

    func focus(at offset: Int?) {
        guard let v = view else { return }
        #if os(macOS)
        guard let window = v.window else { return }
        if window.firstResponder !== v { window.makeFirstResponder(v) }
        let len = v.textStorage?.length ?? 0
        let o = max(0, min(offset ?? len, len))
        v.setSelectedRange(NSRange(location: o, length: 0))
        v.scrollRangeToVisible(NSRange(location: o, length: 0))
        #else
        if !v.isFirstResponder { _ = v.becomeFirstResponder() }
        let len = v.textStorage.length
        let o = max(0, min(offset ?? len, len))
        v.selectedRange = NSRange(location: o, length: 0)
        #endif
        resetTypingAttributes()
    }

    func selectedRange() -> NSRange { viewSelection }

    func reload(selection: NSRange?) {
        let text = store.blocks[id]?.text ?? RichText()
        load(config.plain ? RichText(text.plainText) : text, selection: selection ?? currentSelection())
    }

    func endEditing() {
        guard let v = view else { return }
        #if os(macOS)
        if v.window?.firstResponder === v { v.window?.makeFirstResponder(nil) }
        #else
        _ = v.resignFirstResponder()
        #endif
    }

    func setTypingMarks(_ marks: Marks) {
        view?.typingAttributes = AttributedBridge.typingAttributes(marks, style: config.style)
    }

    func currentTypingMarks() -> Marks {
        guard let key = view?.typingAttributes[.basedMarks] as? String else { return .plain }
        return Marks(key: key)
    }

    // MARK: Events

    func didBegin() {
        controller.didBeginEditing(id)
        #if os(macOS)
        view?.needsDisplay = true
        #else
        view?.updatePlaceholder()
        #endif
    }

    func didEnd() {
        controller.didEndEditing(id)
        #if os(macOS)
        view?.needsDisplay = true
        #else
        view?.updatePlaceholder()
        #endif
    }

    var hasMarkedText: Bool {
        #if os(macOS)
        return view?.hasMarkedText() ?? false
        #else
        return view?.markedTextRange != nil
        #endif
    }

    func handleChange() {
        guard !isApplying, let v = view, !hasMarkedText else { return }
        #if os(macOS)
        guard let storage = v.textStorage else { return }
        #else
        let storage = v.textStorage
        #endif
        let rt = AttributedBridge.richText(storage, plain: config.plain)
        applied = rt
        let sel = viewSelection
        let inserted = lastWasInsert
        lastWasInsert = false
        if let r = controller.textDidChange(id, rt, selection: sel, inserted: inserted) {
            load(r.text, selection: r.selection)
        }
        v.invalidateIntrinsicContentSize()
        #if os(macOS)
        v.needsDisplay = true
        #else
        v.updatePlaceholder()
        #endif
    }

    func handleSelectionChange() {
        guard !isApplying, let v = view else { return }
        controller.selectionChanged(id, viewSelection)
        #if os(iOS)
        var ta = v.typingAttributes
        if ta[.basedMention] != nil || ta[.basedEquation] != nil || ta[.link] != nil {
            ta[.basedMention] = nil; ta[.basedEquation] = nil; ta[.link] = nil
            v.typingAttributes = ta
        }
        #endif
    }

    func paste(_ string: String) -> Bool {
        guard view != nil else { return false }
        return controller.paste(string, into: id, selection: viewSelection)
    }

    /// Opens `based://page/<id>` mentions and web links.
    func openLink(_ url: URL) {
        if url.scheme == "based", url.host == "page" {
            let pid = url.lastPathComponent
            controller.model.open(pid)
        } else {
            #if os(macOS)
            NSWorkspace.shared.open(url)
            #else
            UIApplication.shared.open(url)
            #endif
        }
    }

    /// Link or page mention under the current selection.
    func linkAtSelection() -> URL? {
        guard let v = view else { return nil }
        #if os(macOS)
        guard let storage = v.textStorage else { return nil }
        #else
        let storage = v.textStorage
        #endif
        let r = viewSelection
        guard storage.length > 0 else { return nil }
        let loc = min(max(0, r.location), storage.length - 1)
        if let m = (storage.attribute(.basedMention, at: loc, effectiveRange: nil) as? String).flatMap({ Mention(key: $0) }) {
            switch m {
            case .page(let pid): return URL(string: "based://page/" + pid)
            case .link(let u): return URL(string: u)
            default: break
            }
        }
        if let key = storage.attribute(.basedMarks, at: loc, effectiveRange: nil) as? String, let l = Marks(key: key).link {
            return URL(string: l)
        }
        return nil
    }

    // MARK: Keys (shared)

    func handleReturn(shift: Bool) -> Bool {
        guard view != nil else { return false }
        return controller.handleReturn(id, selection: viewSelection, shift: shift)
    }

    func handleBackspaceAtStart() -> Bool { controller.handleBackspaceAtStart(id) }

    func handleVertical(up: Bool) -> Bool {
        guard let v = view else { return false }
        if controller.menu?.blockID == id { return controller.handleVertical(id, up: up) }
        let r = viewSelection
        guard r.length == 0 else { return false }
        let (first, last) = v.caretLineInfo()
        if up, first { return controller.handleVertical(id, up: true) }
        if !up, last { return controller.handleVertical(id, up: false) }
        return false
    }
}

// MARK: - Line geometry (TextKit 1)

extension NSLayoutManager {
    /// Whether the caret at `loc` sits on the first / last visual line of the text.
    func caretLineInfo(location loc: Int, length: Int, endsWithNewline: Bool) -> (Bool, Bool) {
        guard length > 0, numberOfGlyphs > 0 else { return (true, true) }
        let firstRect = lineFragmentRect(forGlyphAt: 0, effectiveRange: nil)
        var lastRect = lineFragmentRect(forGlyphAt: glyphIndexForCharacter(at: length - 1), effectiveRange: nil)
        if endsWithNewline, extraLineFragmentRect.height > 0 { lastRect = extraLineFragmentRect }
        var caretRect: CGRect
        if loc >= length {
            caretRect = (endsWithNewline && extraLineFragmentRect.height > 0)
                ? extraLineFragmentRect
                : lineFragmentRect(forGlyphAt: glyphIndexForCharacter(at: length - 1), effectiveRange: nil)
        } else {
            caretRect = lineFragmentRect(forGlyphAt: glyphIndexForCharacter(at: loc), effectiveRange: nil)
        }
        return (caretRect.minY <= firstRect.minY + 0.5, caretRect.minY >= lastRect.minY - 0.5)
    }
}

#if os(macOS)

// MARK: - macOS

final class BasedNSTextView: NSTextView {
    weak var coordinator: TextCoordinator?
    var placeholder = ""
    var showsPlaceholderAlways = false

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        if ok { coordinator?.didBegin() }
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        if ok { coordinator?.didEnd() }
        return ok
    }

    var isFocused: Bool { window?.firstResponder === self }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard string.isEmpty, !placeholder.isEmpty, showsPlaceholderAlways || isFocused else { return }
        let font = (typingAttributes[.font] as? NSFont) ?? NSFont.systemFont(ofSize: Theme.bodySize)
        let x = textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0)
        (placeholder as NSString).draw(at: NSPoint(x: x, y: textContainerInset.height),
                                       withAttributes: [.font: font, .foregroundColor: NSColor.placeholderTextColor])
    }

    override func paste(_ sender: Any?) {
        guard let s = NSPasteboard.general.string(forType: .string) else { super.paste(sender); return }
        if coordinator?.paste(s) == true { return }
        insertText(s, replacementRange: selectedRange())
    }

    override func pasteAsRichText(_ sender: Any?) { paste(sender) }

    func height(forWidth width: CGFloat) -> CGFloat {
        guard let lm = layoutManager, let tc = textContainer else { return 22 }
        let w = max(10, width - textContainerInset.width * 2)
        if tc.containerSize.width != w { tc.containerSize = NSSize(width: w, height: .greatestFiniteMagnitude) }
        lm.ensureLayout(for: tc)
        var h = lm.usedRect(for: tc).height
        let font = (typingAttributes[.font] as? NSFont) ?? NSFont.systemFont(ofSize: Theme.bodySize)
        h = max(h, lm.defaultLineHeight(for: font))
        return ceil(h + textContainerInset.height * 2)
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: height(forWidth: bounds.width > 0 ? bounds.width : 600))
    }

    func caretLineInfo() -> (Bool, Bool) {
        guard let lm = layoutManager, let tc = textContainer else { return (true, true) }
        lm.ensureLayout(for: tc)
        let ns = string as NSString
        return lm.caretLineInfo(location: selectedRange().location, length: ns.length, endsWithNewline: ns.hasSuffix("\n"))
    }
}

extension TextCoordinator: NSTextViewDelegate {
    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        lastWasInsert = !(replacementString ?? "").isEmpty
        if config.style.type == .page, let s = replacementString, s.contains("\n") { return false }
        return true
    }

    func textDidChange(_ notification: Notification) { handleChange() }

    func textViewDidChangeSelection(_ notification: Notification) { handleSelectionChange() }

    func textView(_ textView: NSTextView, shouldChangeTypingAttributes oldTypingAttributes: [String: Any],
                  toAttributes newTypingAttributes: [NSAttributedString.Key: Any]) -> [NSAttributedString.Key: Any] {
        var a = newTypingAttributes
        a[.basedMention] = nil
        a[.basedEquation] = nil
        a[.link] = nil
        return a
    }

    func textView(_ textView: NSTextView, clickedOnLink link: Any, at charIndex: Int) -> Bool {
        if let u = link as? URL { openLink(u); return true }
        if let s = link as? String, let u = URL(string: s) { openLink(u); return true }
        return false
    }

    func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        let r = textView.selectedRange()
        let len = (textView.string as NSString).length
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)):
            let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
            return handleReturn(shift: shift)
        case #selector(NSResponder.insertLineBreak(_:)), #selector(NSResponder.insertNewlineIgnoringFieldEditor(_:)):
            return config.style.type == .page
        case #selector(NSResponder.deleteBackward(_:)):
            if r.location == 0 && r.length == 0 { return handleBackspaceAtStart() }
        case #selector(NSResponder.deleteForward(_:)):
            if r.length == 0 && r.location >= len { return controller.handleDeleteAtEnd(id) }
        case #selector(NSResponder.insertTab(_:)):
            return controller.handleTab(id, shift: false)
        case #selector(NSResponder.insertBacktab(_:)):
            return controller.handleTab(id, shift: true)
        case #selector(NSResponder.moveUp(_:)):
            return handleVertical(up: true)
        case #selector(NSResponder.moveDown(_:)):
            return handleVertical(up: false)
        case #selector(NSResponder.moveLeft(_:)):
            if r.location == 0 && r.length == 0 { return controller.handleHorizontalBoundary(id, left: true) }
        case #selector(NSResponder.moveRight(_:)):
            if r.length == 0 && r.location >= len { return controller.handleHorizontalBoundary(id, left: false) }
        case #selector(NSResponder.cancelOperation(_:)):
            return controller.handleEscape(id)
        default:
            break
        }
        return false
    }
}

struct RichTextView: NSViewRepresentable {
    let id: RecordID
    let text: RichText
    let config: RichTextConfig
    let controller: EditorController

    func makeCoordinator() -> TextCoordinator {
        TextCoordinator(id: id, controller: controller, config: config)
    }

    func makeNSView(context: Context) -> BasedNSTextView {
        let tv = BasedNSTextView(usingTextLayoutManager: false)
        tv.drawsBackground = false
        tv.isRichText = true
        tv.importsGraphics = false
        tv.allowsUndo = false
        tv.isHorizontallyResizable = false
        tv.isVerticallyResizable = false
        tv.textContainerInset = NSSize(width: 0, height: 3)
        tv.textContainer?.lineFragmentPadding = 0
        tv.textContainer?.widthTracksTextView = true
        tv.textContainer?.heightTracksTextView = false
        tv.textContainer?.containerSize = NSSize(width: 600, height: CGFloat.greatestFiniteMagnitude)
        tv.isAutomaticQuoteSubstitutionEnabled = false
        tv.isAutomaticDashSubstitutionEnabled = false
        tv.isAutomaticTextReplacementEnabled = false
        tv.isAutomaticLinkDetectionEnabled = false
        tv.isAutomaticSpellingCorrectionEnabled = false
        tv.smartInsertDeleteEnabled = false
        tv.isContinuousSpellCheckingEnabled = true
        tv.usesFontPanel = false
        tv.insertionPointColor = Theme.textPrimary
        tv.linkTextAttributes = [.cursor: NSCursor.pointingHand]
        tv.selectedTextAttributes = [.backgroundColor: Theme.selection]
        tv.setContentHuggingPriority(.defaultHigh, for: .vertical)
        let c = context.coordinator
        tv.delegate = c
        tv.coordinator = c
        c.view = tv
        c.applyConfig()
        c.load(config.plain ? RichText(text.plainText) : text, selection: nil)
        controller.register(c)
        return tv
    }

    func updateNSView(_ tv: BasedNSTextView, context: Context) {
        context.coordinator.update(text: config.plain ? RichText(text.plainText) : text, config: config, controller: controller)
        controller.register(context.coordinator)
    }

    static func dismantleNSView(_ tv: BasedNSTextView, coordinator: TextCoordinator) {
        coordinator.controller.unregister(coordinator)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: BasedNSTextView, context: Context) -> CGSize? {
        var w = proposal.width ?? 600
        if !w.isFinite || w <= 0 { w = 600 }
        return CGSize(width: w, height: nsView.height(forWidth: w))
    }
}

#else

// MARK: - iOS

final class BasedUITextView: UITextView {
    weak var coordinator: TextCoordinator?
    let placeholderLabel = UILabel()
    var showsPlaceholderAlways = false

    override var undoManager: UndoManager? { nil }

    func setUpPlaceholder() {
        placeholderLabel.textColor = .placeholderText
        placeholderLabel.numberOfLines = 1
        placeholderLabel.isUserInteractionEnabled = false
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: textContainerInset.left),
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor, constant: textContainerInset.top),
        ])
    }

    func updatePlaceholder() {
        let empty = textStorage.length == 0
        placeholderLabel.isHidden = !(empty && (showsPlaceholderAlways || coordinator?.config.alwaysShowPlaceholder == true || isFirstResponder))
    }

    override func deleteBackward() {
        let r = selectedRange
        if r.location == 0, r.length == 0, coordinator?.handleBackspaceAtStart() == true { return }
        super.deleteBackward()
    }

    override func paste(_ sender: Any?) {
        guard let s = UIPasteboard.general.string else { super.paste(sender); return }
        if coordinator?.paste(s) == true { return }
        insertText(s)
    }

    override func toggleBoldface(_ sender: Any?) { coordinator?.controller.toggleMark(.bold) }
    override func toggleItalics(_ sender: Any?) { coordinator?.controller.toggleMark(.italic) }
    override func toggleUnderline(_ sender: Any?) { coordinator?.controller.toggleMark(.underline) }

    override var keyCommands: [UIKeyCommand]? {
        func cmd(_ input: String, _ mods: UIKeyModifierFlags, _ action: Selector, priority: Bool = true) -> UIKeyCommand {
            let c = UIKeyCommand(input: input, modifierFlags: mods, action: action)
            c.wantsPriorityOverSystemBehavior = priority
            return c
        }
        return [
            cmd("\t", [], #selector(tabKey)),
            cmd("\t", .shift, #selector(shiftTabKey)),
            cmd(UIKeyCommand.inputUpArrow, [], #selector(upKey)),
            cmd(UIKeyCommand.inputDownArrow, [], #selector(downKey)),
            cmd(UIKeyCommand.inputEscape, [], #selector(escapeKey)),
            cmd("e", .command, #selector(codeKey)),
            cmd("x", [.command, .shift], #selector(strikeKey)),
            cmd("k", .command, #selector(linkKey)),
        ]
    }

    @objc func tabKey() { if coordinator.map({ $0.controller.handleTab($0.id, shift: false) }) != true { insertText("\t") } }
    @objc func shiftTabKey() { _ = coordinator.map { $0.controller.handleTab($0.id, shift: true) } }
    @objc func upKey() { if coordinator?.handleVertical(up: true) != true { moveCaret(.up) } }
    @objc func downKey() { if coordinator?.handleVertical(up: false) != true { moveCaret(.down) } }
    @objc func escapeKey() { _ = coordinator.map { $0.controller.handleEscape($0.id) } }
    @objc func codeKey() { coordinator?.controller.toggleMark(.code) }
    @objc func strikeKey() { coordinator?.controller.toggleMark(.strikethrough) }
    @objc func linkKey() { if let c = coordinator { c.controller.linkEditor = c.id } }

    func moveCaret(_ direction: UITextLayoutDirection) {
        guard let r = selectedTextRange else { return }
        let from = direction == .up ? r.start : r.end
        if let p = position(from: from, in: direction, offset: 1) {
            selectedTextRange = textRange(from: p, to: p)
        } else {
            let p = direction == .up ? beginningOfDocument : endOfDocument
            selectedTextRange = textRange(from: p, to: p)
        }
    }

    func caretLineInfo() -> (Bool, Bool) {
        layoutManager.ensureLayout(for: textContainer)
        let ns = textStorage.string as NSString
        return layoutManager.caretLineInfo(location: selectedRange.location, length: ns.length, endsWithNewline: ns.hasSuffix("\n"))
    }

    override func becomeFirstResponder() -> Bool {
        let ok = super.becomeFirstResponder()
        updatePlaceholder()
        return ok
    }

    override func resignFirstResponder() -> Bool {
        let ok = super.resignFirstResponder()
        updatePlaceholder()
        return ok
    }
}

/// Formatting bar above the iPhone keyboard.
@MainActor
final class KeyboardToolbar: UIToolbar {
    weak var coordinator: TextCoordinator?

    func build() {
        func item(_ symbol: String, _ action: Selector) -> UIBarButtonItem {
            UIBarButtonItem(image: UIImage(systemName: symbol), style: .plain, target: self, action: action)
        }
        let flex = UIBarButtonItem(barButtonSystemItem: .flexibleSpace, target: nil, action: nil)
        items = [
            item("plus", #selector(slash)), flex,
            item("at", #selector(mention)), flex,
            item("checklist", #selector(todo)), flex,
            item("bold", #selector(bold)), flex,
            item("italic", #selector(italic)), flex,
            item("strikethrough", #selector(strike)), flex,
            item("increase.indent", #selector(indent)), flex,
            item("decrease.indent", #selector(outdent)), flex,
            item("arrow.uturn.backward", #selector(undo)), flex,
            item("keyboard.chevron.compact.down", #selector(done)),
        ]
        sizeToFit()
    }

    @objc func slash() { coordinator?.view?.insertText("/") }
    @objc func mention() { coordinator?.view?.insertText("@") }
    @objc func todo() {
        guard let c = coordinator, let b = c.store.blocks[c.id] else { return }
        c.store.turnInto([c.id], b.type == .todo ? .text : .todo)
    }
    @objc func bold() { coordinator?.controller.toggleMark(.bold) }
    @objc func italic() { coordinator?.controller.toggleMark(.italic) }
    @objc func strike() { coordinator?.controller.toggleMark(.strikethrough) }
    @objc func indent() { _ = coordinator.map { $0.controller.handleTab($0.id, shift: false) } }
    @objc func outdent() { _ = coordinator.map { $0.controller.handleTab($0.id, shift: true) } }
    @objc func undo() { coordinator?.controller.model.undo() }
    @objc func done() { coordinator?.endEditing() }
}

extension TextCoordinator: UITextViewDelegate {
    func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
        lastWasInsert = !text.isEmpty
        if text == "\n", !hasMarkedText {
            if handleReturn(shift: false) { return false }
            return config.style.type != .page
        }
        if config.style.type == .page, text.contains("\n") { return false }
        return true
    }

    func textViewDidChange(_ textView: UITextView) { handleChange() }

    func textViewDidChangeSelection(_ textView: UITextView) { handleSelectionChange() }

    func textViewDidBeginEditing(_ textView: UITextView) { didBegin() }

    func textViewDidEndEditing(_ textView: UITextView) { didEnd() }

    func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
        var actions = suggestedActions
        if let url = linkAtSelection() {
            actions.insert(UIAction(title: "Open Link", image: UIImage(systemName: "arrow.up.right.square")) { [weak self] _ in
                self?.openLink(url)
            }, at: 0)
        }
        if range.length > 0 {
            let fmt = UIMenu(title: "Format", children: [
                UIAction(title: "Bold") { [weak self] _ in self?.controller.toggleMark(.bold) },
                UIAction(title: "Italic") { [weak self] _ in self?.controller.toggleMark(.italic) },
                UIAction(title: "Underline") { [weak self] _ in self?.controller.toggleMark(.underline) },
                UIAction(title: "Strikethrough") { [weak self] _ in self?.controller.toggleMark(.strikethrough) },
                UIAction(title: "Code") { [weak self] _ in self?.controller.toggleMark(.code) },
                UIAction(title: "Link…") { [weak self] _ in if let s = self { s.controller.linkEditor = s.id } },
            ])
            actions.append(fmt)
        }
        return UIMenu(children: actions)
    }
}

struct RichTextView: UIViewRepresentable {
    let id: RecordID
    let text: RichText
    let config: RichTextConfig
    let controller: EditorController

    func makeCoordinator() -> TextCoordinator {
        TextCoordinator(id: id, controller: controller, config: config)
    }

    func makeUIView(context: Context) -> BasedUITextView {
        let tv = BasedUITextView(usingTextLayoutManager: false)
        tv.backgroundColor = .clear
        tv.isScrollEnabled = false
        tv.textContainerInset = UIEdgeInsets(top: 3, left: 0, bottom: 3, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        tv.autocorrectionType = .default
        tv.smartQuotesType = .no
        tv.smartDashesType = .no
        tv.tintColor = .label
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.setUpPlaceholder()
        let c = context.coordinator
        tv.delegate = c
        tv.coordinator = c
        c.view = tv
        let bar = KeyboardToolbar(frame: CGRect(x: 0, y: 0, width: 320, height: 44))
        bar.coordinator = c
        bar.build()
        tv.inputAccessoryView = bar
        c.applyConfig()
        c.load(config.plain ? RichText(text.plainText) : text, selection: nil)
        controller.register(c)
        return tv
    }

    func updateUIView(_ tv: BasedUITextView, context: Context) {
        context.coordinator.update(text: config.plain ? RichText(text.plainText) : text, config: config, controller: controller)
        controller.register(context.coordinator)
    }

    static func dismantleUIView(_ tv: BasedUITextView, coordinator: TextCoordinator) {
        coordinator.controller.unregister(coordinator)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: BasedUITextView, context: Context) -> CGSize? {
        var w = proposal.width ?? 320
        if !w.isFinite || w <= 0 { w = 320 }
        let s = uiView.sizeThatFits(CGSize(width: w, height: .greatestFiniteMagnitude))
        return CGSize(width: w, height: max(s.height, 24))
    }
}

#endif