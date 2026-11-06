import AppKit
@preconcurrency @MainActor open class WKUserContentController: NSObject { public override init() {}; open func add(_ h: WKScriptMessageHandler, name: String) {}; open func removeScriptMessageHandler(forName: String) {}; open func addUserScript(_ s: WKUserScript) {} }
@preconcurrency @MainActor open class WKUserScript: NSObject { public enum InjectionTime: Int { case atDocumentStart, atDocumentEnd }; public init(source: String, injectionTime: InjectionTime, forMainFrameOnly: Bool) {} }
@preconcurrency @MainActor open class WKPreferences: NSObject { open var javaScriptCanOpenWindowsAutomatically = false; open var isElementFullscreenEnabled = false }
@preconcurrency @MainActor open class WKWebpagePreferences: NSObject { open var allowsContentJavaScript = true }
@preconcurrency @MainActor open class WKWebsiteDataStore: NSObject { open class func nonPersistent() -> WKWebsiteDataStore { WKWebsiteDataStore() }; open class func `default`() -> WKWebsiteDataStore { WKWebsiteDataStore() } }
@preconcurrency @MainActor open class WKWebViewConfiguration: NSObject {
    public override init() {}
    open var userContentController = WKUserContentController()
    open var preferences = WKPreferences()
    open var defaultWebpagePreferences = WKWebpagePreferences()
    open var websiteDataStore = WKWebsiteDataStore()
    open var allowsInlineMediaPlayback = false
    open var mediaTypesRequiringUserActionForPlayback: Int = 0
    open var limitsNavigationsToAppBoundDomains = false
}
@preconcurrency @MainActor public protocol WKScriptMessageHandler: NSObjectProtocol { func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) }
@preconcurrency @MainActor open class WKScriptMessage: NSObject { open var body: Any { 0 }; open var name: String { "" } }
public enum WKNavigationActionPolicy: Int { case cancel, allow, download }
public enum WKNavigationType: Int { case linkActivated, formSubmitted, backForward, reload, formResubmitted, other = -1 }
@preconcurrency @MainActor open class WKFrameInfo: NSObject { open var isMainFrame: Bool { true } }
@preconcurrency @MainActor open class WKNavigationAction: NSObject { open var navigationType: WKNavigationType { .other }; open var request: URLRequest { URLRequest(url: URL(fileURLWithPath: "/")) }; open var targetFrame: WKFrameInfo? { nil } }
@preconcurrency @MainActor open class WKNavigation: NSObject {}
@preconcurrency @MainActor public protocol WKNavigationDelegate: NSObjectProtocol {}
extension WKNavigationDelegate {
    public func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {}
    public func webView(_ w: WKWebView, didFinish n: WKNavigation!) {}
    public func webView(_ w: WKWebView, didFail n: WKNavigation!, withError e: Error) {}
}
@preconcurrency @MainActor public protocol WKUIDelegate: NSObjectProtocol {}
@preconcurrency @MainActor open class WKWebView: NSView {
    public init(frame: CGRect, configuration: WKWebViewConfiguration) { super.init(frame: frame) }
    public required init?(coder: NSCoder) { super.init(coder: coder) }
    open weak var navigationDelegate: (any WKNavigationDelegate)?
    open weak var uiDelegate: (any WKUIDelegate)?
    open var configuration: WKWebViewConfiguration { WKWebViewConfiguration() }
    open var url: URL? { nil }
    open var title: String? { nil }
    open var isLoading: Bool { false }
    open var customUserAgent: String?
    open var allowsBackForwardNavigationGestures = false
    open var allowsMagnification = false
    open var underPageBackgroundColor: NSColor!
    open var isInspectable = false
    open func setValue(_ v: Any?, forKey k: String) {}
    @discardableResult open func load(_ r: URLRequest) -> WKNavigation? { nil }
    @discardableResult open func loadHTMLString(_ s: String, baseURL: URL?) -> WKNavigation? { nil }
    @discardableResult open func loadFileURL(_ u: URL, allowingReadAccessTo: URL) -> WKNavigation? { nil }
    open func evaluateJavaScript(_ js: String, completionHandler: ((Any?, Error?) -> Void)? = nil) {}
    open func evaluateJavaScript(_ js: String) async throws -> Any { 0 }
    @discardableResult open func reload() -> WKNavigation? { nil }
    open func stopLoading() {}
}
