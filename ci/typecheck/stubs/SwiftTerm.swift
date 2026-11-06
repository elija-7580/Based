import AppKit
public protocol LocalProcessTerminalViewDelegate: AnyObject {}
@preconcurrency @MainActor open class TerminalView: NSView {
    open var font: NSFont = .systemFont(ofSize: 12)
    open var nativeForegroundColor: NSColor = .black
    open var nativeBackgroundColor: NSColor = .white
    open var caretColor: NSColor = .black
    open var optionAsMetaKey = false
    open func feed(text: String) {}
    open func send(txt: String) {}
    open func getTerminal() -> AnyObject { NSObject() }
}
@preconcurrency @MainActor open class LocalProcessTerminalView: TerminalView {
    public override init(frame: NSRect) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    open weak var processDelegate: LocalProcessTerminalViewDelegate?
    open func startProcess(executable: String = "/bin/bash", args: [String] = [], environment: [String]? = nil, execName: String? = nil, currentDirectory: String? = nil) {}
    open func terminate() {}
    open var process: AnyObject? { nil }
}
