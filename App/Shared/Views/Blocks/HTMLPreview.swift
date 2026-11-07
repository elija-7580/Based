import SwiftUI
import WebKit
import BasedCore

/// Renders the source of a code block with language `html` (any HTML/CSS/JS, D3, Chart.js, Observable Plot …)
/// or `mermaid` (diagrams) in a sandboxed WKWebView. The AI brain writes such blocks via `add_html` / `add_mermaid`.
struct HTMLPreview: View {
    let source: String
    let language: String
    var height: CGFloat = 160
    @State private var reportedHeight: CGFloat?

    var body: some View {
        WebContentView(html: document, onHeight: { h in if h > 8, abs((reportedHeight ?? 0) - h) > 2 { reportedHeight = min(h, 2400) } })
            .frame(height: reportedHeight ?? height)
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .accessibilityIdentifier("html.preview")
    }

    private var document: String { Self.document(source: source, language: language) }

    /// Full HTML document; the page reports its height back so the block grows with its content.
    static func document(source: String, language: String) -> String {
        let reporter = """
        <script>
        (function(){
          // The content's own height (documentElement.scrollHeight never drops below the view's height, so the
          // block could only grow and kept a big empty area under short content).
          function report(){ try {
            var b = document.body, cs = getComputedStyle(b);
            var h = b.getBoundingClientRect().height + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
            window.webkit.messageHandlers.height.postMessage(Math.ceil(h));
          } catch(e){} }
          new ResizeObserver(report).observe(document.body);
          window.addEventListener('load', report); setTimeout(report, 50); setTimeout(report, 500); setTimeout(report, 2000);
        })();
        </script>
        """
        let base = """
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="color-scheme" content="light dark">
        <style>
          :root { color-scheme: light dark; }
          html, body { margin: 0; padding: 0; background: transparent; font: 14px -apple-system, system-ui, sans-serif; color: CanvasText; }
          html { height: auto; } body { padding: 4px 0; height: auto; overflow: hidden; }
          pre.mermaid { margin: 0; display: flex; justify-content: center; }
          pre.mermaid svg { max-width: 100%; height: auto; }
        </style>
        """
        if language == "mermaid" {
            let escaped = source.replacingOccurrences(of: "</", with: "<\\/")
            return """
            <!doctype html><html><head>\(base)</head><body>
            <pre class="mermaid">\(escaped)</pre>
            <script type="module">
              import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
              const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
              mermaid.initialize({ startOnLoad: true, theme: dark ? 'dark' : 'default', securityLevel: 'strict' });
            </script>
            \(reporter)</body></html>
            """
        }
        // HTML: if the author wrote a full document keep it, otherwise wrap the fragment.
        if source.range(of: "<html", options: .caseInsensitive) != nil {
            if let r = source.range(of: "</body>", options: .caseInsensitive) {
                var s = source; s.replaceSubrange(r, with: reporter + "</body>"); return s
            }
            return source + reporter
        }
        return "<!doctype html><html><head>\(base)</head><body>\(source)\(reporter)</body></html>"
    }
}

/// Code block header toggle "Code | Preview" for html/mermaid blocks (persisted per block in `props.url` = "preview").
struct CodePreviewToggle: View {
    let block: Block
    @Environment(AppModel.self) private var model
    static func supports(_ language: String?) -> Bool { language == "html" || language == "mermaid" }
    static func isPreview(_ block: Block) -> Bool { block.props.url == "preview" }

    var body: some View {
        Picker("", selection: Binding(get: { Self.isPreview(block) ? 1 : 0 }, set: { v in
            model.store.updateBlock(block.id, name: "Toggle preview") { $0.props.url = v == 1 ? "preview" : nil }
        })) {
            Text("Code").tag(0)
            Text("Preview").tag(1)
        }
        .pickerStyle(.segmented).labelsHidden().controlSize(.small).fixedSize()
        .accessibilityIdentifier("code.previewToggle")
    }
}

/// Parses "height=320" from a code-block caption (what the agent tools emit).
func previewHeight(from caption: RichText?) -> CGFloat? {
    guard let text = caption?.plainText, let r = text.range(of: "height=") else { return nil }
    let digits = text[r.upperBound...].prefix { $0.isNumber }
    return Double(digits).map { CGFloat(max(80, min(2000, $0))) }
}

#if os(macOS)
struct WebContentView: NSViewRepresentable {
    let html: String
    var onHeight: (CGFloat) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onHeight: onHeight) }
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: Self.configuration(context.coordinator))
        v.setValue(false, forKey: "drawsBackground")
        v.navigationDelegate = context.coordinator
        v.loadHTMLString(html, baseURL: nil)
        context.coordinator.lastHTML = html
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {
        context.coordinator.onHeight = onHeight
        if context.coordinator.lastHTML != html { context.coordinator.lastHTML = html; v.loadHTMLString(html, baseURL: nil) }
    }
    static func configuration(_ c: Coordinator) -> WKWebViewConfiguration {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(c, name: "height")
        cfg.preferences.javaScriptCanOpenWindowsAutomatically = false
        return cfg
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onHeight: (CGFloat) -> Void
        var lastHTML = ""
        init(onHeight: @escaping (CGFloat) -> Void) { self.onHeight = onHeight }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            if let h = m.body as? Double { onHeight(CGFloat(h)) } else if let h = m.body as? Int { onHeight(CGFloat(h)) }
        }
        /// Links inside previews open in the default browser instead of navigating the sandbox.
        func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if a.navigationType == .linkActivated, let u = a.request.url { NSWorkspace.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
        }
    }
}
#else
struct WebContentView: UIViewRepresentable {
    let html: String
    var onHeight: (CGFloat) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onHeight: onHeight) }
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(context.coordinator, name: "height")
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.isOpaque = false; v.backgroundColor = .clear; v.scrollView.isScrollEnabled = false
        v.navigationDelegate = context.coordinator
        v.loadHTMLString(html, baseURL: nil)
        context.coordinator.lastHTML = html
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) {
        context.coordinator.onHeight = onHeight
        if context.coordinator.lastHTML != html { context.coordinator.lastHTML = html; v.loadHTMLString(html, baseURL: nil) }
    }
    final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var onHeight: (CGFloat) -> Void
        var lastHTML = ""
        init(onHeight: @escaping (CGFloat) -> Void) { self.onHeight = onHeight }
        func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
            if let h = m.body as? Double { onHeight(CGFloat(h)) } else if let h = m.body as? Int { onHeight(CGFloat(h)) }
        }
        func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if a.navigationType == .linkActivated, let u = a.request.url { UIApplication.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
        }
    }
}
#endif
