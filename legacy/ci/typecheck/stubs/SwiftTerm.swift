#if STUB_IOS
import UIKit
#else
import AppKit
#endif
public protocol LocalProcessTerminalViewDelegate: AnyObject {}
@preconcurrency @MainActor open class TerminalView: _PlatformView {
    open var font: _PlatformFont = .systemFont(ofSize: 12)
    open var nativeForegroundColor: _PlatformColor = .black
    open var nativeBackgroundColor: _PlatformColor = .white
    open var caretColor: _PlatformColor = .black
    open var optionAsMetaKey = false
    open func feed(text: String) {}
    open func send(txt: String) {}
    open func getTerminal() -> AnyObject { NSObject() }
}
@preconcurrency @MainActor open class LocalProcessTerminalView: TerminalView {
    public override init(frame: CGRect) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    open weak var processDelegate: LocalProcessTerminalViewDelegate?
    open func startProcess(executable: String = "/bin/bash", args: [String] = [], environment: [String]? = nil, execName: String? = nil, currentDirectory: String? = nil) {}
    open func terminate() {}
    open var process: AnyObject? { nil }
}
