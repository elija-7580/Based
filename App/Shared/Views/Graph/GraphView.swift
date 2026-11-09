import SwiftUI
import WebKit
import BasedCore
#if os(macOS)
import AppKit
import UniformTypeIdentifiers
#endif

/// Workspace graph: every page as a node, connected by the page hierarchy, relation properties and mentions.
/// Network (like Obsidian), tree / family tree (roles: parent, child, partner chosen from relation properties)
/// and radial layouts; colour, size, sort and filters are set in the page's own panel (Web/graph.html).
/// Settings are kept per workspace in UserDefaults; the graph updates live while the workspace changes.
struct GraphView: View {
    @Environment(AppModel.self) private var model
    @AppStorage("graph.settings") private var settingsJSON = ""
    @State private var bridge = GraphBridge()

    var body: some View {
        let revision = model.registry.workspace.revision
        GraphWebView(bridge: bridge, initialHTML: { Self.document(graph: model.store.pageGraph(), settings: settingsJSON) })
            .background(Color(Theme.pageBackgroundColor))
            .accessibilityIdentifier("graph")
            .onAppear { configureBridge() }
            .onChange(of: revision) { _, _ in bridge.scheduleUpdate { model.store.pageGraph() } }
    }

    private func configureBridge() {
        bridge.onOpen = { id, newTab in
            guard model.store.blocks[id] != nil else { return }
            if newTab { model.openInNewTab(id) } else { model.open(id) }
        }
        bridge.onSettings = { json in settingsJSON = json }
        bridge.onExport = { json in
            settingsJSON = json
            Self.export(Self.document(graph: model.store.pageGraph(), settings: json, standalone: true))
        }
    }

    /// The HTML page with the graph and the settings injected.
    static func document(graph: PageGraph, settings: String, standalone: Bool = false) -> String {
        let data = (try? JSONEncoder().encode(graph)).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        let s = settings.isEmpty ? "{}" : settings
        var script = "window.GRAPH=\(scriptSafe(data));window.SETTINGS=\(scriptSafe(s));"
        #if os(iOS)
        script += "window.NO_EXPORT=true;"
        #endif
        if standalone { script += "window.STANDALONE_EXPORT=true;" }
        return GraphTemplate.html.replacingOccurrences(of: "/*DATA*/", with: script)
    }

    /// JSON inside a <script> tag must not close it.
    static func scriptSafe(_ json: String) -> String {
        json.replacingOccurrences(of: "</", with: "<\\/").replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    }

    static func export(_ html: String) {
        #if os(macOS)
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.html]
        panel.nameFieldStringValue = "Graph.html"
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do { try html.write(to: url, atomically: true, encoding: .utf8); Log.info("graph exported → \(url.lastPathComponent)", category: "graph") }
        catch { Log.error("graph export failed: \(error.localizedDescription)", category: "graph") }
        #endif
    }
}

/// Connects the web page with the app: messages from the page (open, settings, export) and live data updates.
final class GraphBridge: NSObject, WKScriptMessageHandler {
    weak var webView: WKWebView?
    var onOpen: (RecordID, Bool) -> Void = { _, _ in }
    var onSettings: (String) -> Void = { _ in }
    var onExport: (String) -> Void = { _ in }
    private var pending: DispatchWorkItem?
    private var loaded = false

    /// Workspace changed: rebuild the graph after a short pause (typing changes the workspace on every key).
    func scheduleUpdate(_ build: @escaping () -> PageGraph) {
        pending?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.loaded, let web = self.webView else { return }
                let graph = Log.measure("graph build", category: "graph", warnAfter: 0.1) { build() }
                guard let data = try? JSONEncoder().encode(graph) else { return }
                let json = GraphView.scriptSafe(String(decoding: data, as: UTF8.self))
                web.evaluateJavaScript("window.updateGraph && window.updateGraph(\(json))")
            }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
    }

    func didLoad() { loaded = true }

    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        guard let text = m.body as? String else { return }
        handle(text)
    }

    private func handle(_ text: String) {
        guard let obj = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let type = obj["type"] as? String else { return }
        let body = obj["body"]
        switch type {
        case "open":
            if let b = body as? [String: Any], let id = b["id"] as? String { onOpen(id, (b["newTab"] as? Bool) ?? false) }
        case "settings", "export":
            guard let b = body, JSONSerialization.isValidJSONObject(b),
                  let d = try? JSONSerialization.data(withJSONObject: b) else { return }
            let json = String(decoding: d, as: UTF8.self)
            if type == "settings" { onSettings(json) } else { onExport(json) }
        default: break
        }
    }
}

#if os(macOS)
struct GraphWebView: NSViewRepresentable {
    let bridge: GraphBridge
    let initialHTML: () -> String
    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }
    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(WeakHandler(bridge), name: "graph")
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.setValue(false, forKey: "drawsBackground")
        v.navigationDelegate = context.coordinator
        bridge.webView = v
        v.loadHTMLString(Log.measure("graph page", category: "graph", warnAfter: 0.15) { initialHTML() }, baseURL: nil)
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {}
    static func dismantleNSView(_ v: WKWebView, coordinator: Coordinator) {
        v.configuration.userContentController.removeScriptMessageHandler(forName: "graph")
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let bridge: GraphBridge
        init(bridge: GraphBridge) { self.bridge = bridge }
        func webView(_ w: WKWebView, didFinish n: WKNavigation!) { bridge.didLoad() }
        func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if a.navigationType == .linkActivated, let u = a.request.url { NSWorkspace.shared.open(u); decisionHandler(.cancel) } else { decisionHandler(.allow) }
        }
    }
}
#else
struct GraphWebView: UIViewRepresentable {
    let bridge: GraphBridge
    let initialHTML: () -> String
    func makeCoordinator() -> Coordinator { Coordinator(bridge: bridge) }
    func makeUIView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.userContentController.add(WeakHandler(bridge), name: "graph")
        let v = WKWebView(frame: .zero, configuration: cfg)
        v.isOpaque = false; v.backgroundColor = .clear; v.scrollView.isScrollEnabled = false
        v.navigationDelegate = context.coordinator
        bridge.webView = v
        v.loadHTMLString(initialHTML(), baseURL: nil)
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) {}
    static func dismantleUIView(_ v: WKWebView, coordinator: Coordinator) {
        v.configuration.userContentController.removeScriptMessageHandler(forName: "graph")
    }
    final class Coordinator: NSObject, WKNavigationDelegate {
        let bridge: GraphBridge
        init(bridge: GraphBridge) { self.bridge = bridge }
        func webView(_ w: WKWebView, didFinish n: WKNavigation!) { bridge.didLoad() }
    }
}
#endif

/// WKUserContentController keeps its handlers strongly; this breaks the cycle web view → handler → web view.
final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        target?.userContentController(c, didReceive: m)
    }
}
