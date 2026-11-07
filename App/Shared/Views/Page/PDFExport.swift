#if os(macOS)
import AppKit
import WebKit
import BasedCore

/// "Export as PDF…": renders the page's HTML export (same layout as the HTML export) in an offscreen web view,
/// always in light mode, and splits it into A4 pages (vector, 36 pt margins).
@MainActor
final class PDFExport: NSObject, WKNavigationDelegate {
    private static var running: [PDFExport] = []
    private let webView: WKWebView
    private let destination: URL
    private let done: (Result<URL, Error>) -> Void

    private init(html: String, destination: URL, done: @escaping (Result<URL, Error>) -> Void) {
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 794, height: 1123), configuration: config)
        webView.appearance = NSAppearance(named: .aqua)
        self.destination = destination
        self.done = done
        super.init()
        webView.navigationDelegate = self
        // Print styles: light colours, no page chrome, keep blocks together where possible.
        let printCSS = "<style>@media print { :root { color-scheme: light; } body { background: #fff !important; color: #37352f !important; } pre, table, figure, blockquote { break-inside: avoid; } }</style>"
        webView.loadHTMLString(html.replacingOccurrences(of: "</head>", with: printCSS + "</head>"), baseURL: nil)
    }

    /// Asks for a destination and exports `pageID`.
    static func run(pageID: RecordID, store: WorkspaceStore, completion: @escaping (String) -> Void) {
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.pdf]
        panel.nameFieldStringValue = MarkdownExporter.fileName(store.title(of: pageID)) + ".pdf"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        export(pageID: pageID, store: store, to: url) { r in
            switch r {
            case .success(let u): completion("Exported \(u.lastPathComponent)"); NSWorkspace.shared.activateFileViewerSelecting([u])
            case .failure(let e): completion("PDF export failed: \(e.localizedDescription)")
            }
        }
    }

    static func export(pageID: RecordID, store: WorkspaceStore, to url: URL, done: @escaping (Result<URL, Error>) -> Void) {
        let html = HTMLExporter(store: store).export(page: pageID)
        var job: PDFExport?
        job = PDFExport(html: html, destination: url) { r in
            running.removeAll { $0 === job }
            done(r)
        }
        running.append(job!)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // Measure the document, render it as one tall vector page, then cut it into A4 pages.
        webView.evaluateJavaScript("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)") { [weak self] h, _ in
            guard let self else { return }
            let height = CGFloat((h as? NSNumber)?.doubleValue ?? 1123)
            self.webView.frame.size.height = max(1, height)
            let config = WKPDFConfiguration()
            config.rect = CGRect(x: 0, y: 0, width: self.webView.frame.width, height: height)
            self.webView.createPDF(configuration: config) { result in
                switch result {
                case .success(let data):
                    do { try Self.paginate(data, to: self.destination); self.done(.success(self.destination)) }
                    catch { self.done(.failure(error)) }
                case .failure(let e): self.done(.failure(e))
                }
            }
        }
    }

    /// Splits one tall PDF page into A4 pages (scaled to the paper width, 36 pt margins), keeping vectors.
    static func paginate(_ data: Data, to url: URL) throws {
        guard let provider = CGDataProvider(data: data as CFData), let doc = CGPDFDocument(provider), let src = doc.page(at: 1) else {
            throw NSError(domain: "Based.PDF", code: 2, userInfo: [NSLocalizedDescriptionKey: "Couldn't read the rendered page."])
        }
        let srcBox = src.getBoxRect(.mediaBox)
        var a4 = CGRect(x: 0, y: 0, width: 595.28, height: 841.89)
        let margin: CGFloat = 36
        let contentW = a4.width - 2 * margin, contentH = a4.height - 2 * margin
        let scale = contentW / srcBox.width
        let sliceH = contentH / scale                        // source points per page
        let pages = max(1, Int(ceil(srcBox.height / sliceH)))
        guard pages <= 500, let ctx = CGContext(url as CFURL, mediaBox: &a4, nil) else {
            throw NSError(domain: "Based.PDF", code: 3, userInfo: [NSLocalizedDescriptionKey: "The page is too long to print."])
        }
        for i in 0..<pages {
            ctx.beginPDFPage(nil)
            ctx.saveGState()
            ctx.clip(to: CGRect(x: margin, y: margin, width: contentW, height: contentH))
            // PDF space is bottom-up: page i shows source rows [top - (i+1)·slice, top - i·slice].
            let srcTop = srcBox.maxY - CGFloat(i) * sliceH
            ctx.translateBy(x: margin, y: margin)
            ctx.scaleBy(x: scale, y: scale)
            ctx.translateBy(x: -srcBox.minX, y: -(srcTop - sliceH))
            ctx.drawPDFPage(src)
            ctx.restoreGState()
            ctx.endPDFPage()
        }
        ctx.closePDF()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { done(.failure(error)) }
}
#endif
