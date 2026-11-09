import SwiftUI
import BasedCore
import AVKit
import PDFKit
import WebKit
import UniformTypeIdentifiers

/// Image, video, audio, file, PDF, bookmark and embed blocks.
struct MediaBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var showSource = false
    @State private var hovering = false

    private var store: WorkspaceStore { model.store }
    private var hasSource: Bool { block.props.asset != nil || !(block.props.url ?? "").isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !hasSource {
                placeholder
            } else {
                media
                    .overlay(alignment: .topTrailing) {
                        if hovering && !editor.isLocked && block.type != .bookmark {
                            Button { showSource = true } label: {
                                Image(systemName: "arrow.triangle.2.circlepath").padding(5)
                                    .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(.regularMaterial))
                            }
                            .buttonStyle(.plain)
                            .padding(DS.Space.sm)
                            .help("Replace")
                        }
                    }
                CaptionField(block: block, editor: editor)
            }
        }
        .onHover { hovering = $0 }
        .panelPopover(isPresented: $showSource) {
            MediaSourcePicker(block: block) { showSource = false }
                .frame(minWidth: 320)
        }
    }

    private var placeholder: some View {
        Button { showSource = true } label: {
            HStack(spacing: 8) {
                Image(systemName: Self.symbol(block.type))
                Text(Self.prompt(block.type))
                Spacer()
            }
            .padding(DS.Space.lg)
            .foregroundStyle(Theme.secondary)
            .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(Color(Theme.codeBackground)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill)
    }

    static func symbol(_ t: BlockType) -> String {
        switch t {
        case .image: return "photo"
        case .video: return "play.rectangle"
        case .audio: return "waveform"
        case .file: return "paperclip"
        case .pdf: return "doc.richtext"
        case .bookmark: return "bookmark"
        default: return "globe"
        }
    }

    static func prompt(_ t: BlockType) -> String {
        switch t {
        case .image: return "Add an image"
        case .video: return "Embed or upload a video"
        case .audio: return "Embed or upload audio"
        case .file: return "Upload or embed a file"
        case .pdf: return "Embed or upload a PDF"
        case .bookmark: return "Add a web bookmark"
        default: return "Embed a link"
        }
    }

    var sourceURL: URL? {
        if let a = block.props.asset, let u = model.assets.url(for: a), FileManager.default.fileExists(atPath: u.path) { return u }
        if let s = block.props.url, let u = URL(string: s) { return u }
        return nil
    }

    @ViewBuilder
    private var media: some View {
        switch block.type {
        case .image: ImageBlockView(block: block, url: sourceURL, editor: editor)
        case .video:
            if let u = sourceURL {
                if let host = u.host, ["youtube.com", "www.youtube.com", "youtu.be", "vimeo.com", "www.vimeo.com"].contains(host) {
                    WebEmbedView(url: Self.embedURL(u)).frame(height: 380).clipShape(RoundedRectangle(cornerRadius: DS.Radius.small))
                } else {
                    VideoPlayer(player: AVPlayer(url: u)).frame(height: 380).clipShape(RoundedRectangle(cornerRadius: DS.Radius.small))
                }
            }
        case .audio:
            if let u = sourceURL { VideoPlayer(player: AVPlayer(url: u)).frame(height: 54).clipShape(RoundedRectangle(cornerRadius: DS.Radius.control)) }
        case .pdf:
            if let u = sourceURL { PDFBlockView(url: u).frame(height: 560).clipShape(RoundedRectangle(cornerRadius: DS.Radius.small)) }
        case .embed:
            if let u = sourceURL { WebEmbedView(url: Self.embedURL(u)).frame(height: 420).clipShape(RoundedRectangle(cornerRadius: DS.Radius.small)) }
        case .bookmark:
            BookmarkCard(block: block)
        default:
            FileRow(block: block, url: sourceURL)
        }
    }

    /// Use the embeddable player for common video hosts.
    static func embedURL(_ u: URL) -> URL {
        guard let host = u.host else { return u }
        if host.contains("youtube.com"), let comps = URLComponents(url: u, resolvingAgainstBaseURL: false),
           let v = comps.queryItems?.first(where: { $0.name == "v" })?.value {
            return URL(string: "https://www.youtube.com/embed/\(v)") ?? u
        }
        if host == "youtu.be" { return URL(string: "https://www.youtube.com/embed\(u.path)") ?? u }
        if host.contains("vimeo.com"), let id = u.pathComponents.last, Int(id) != nil {
            return URL(string: "https://player.vimeo.com/video/\(id)") ?? u
        }
        return u
    }
}

struct CaptionField: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var text = ""
    @FocusState private var focused: Bool

    var body: some View {
        TextField("Add a caption…", text: $text, axis: .vertical)
            .textFieldStyle(.plain)
            .font(DS.Text.body())
            .foregroundStyle(Theme.secondary)
            .focused($focused)
            .disabled(editor.isLocked)
            .onAppear { text = block.props.caption?.plainText ?? "" }
            .onChange(of: block.props.caption) { _, new in if !focused { text = new?.plainText ?? "" } }
            .onChange(of: text) { _, new in
                guard new != (block.props.caption?.plainText ?? "") else { return }
                model.store.updateBlock(block.id, name: "Caption", coalesce: "caption:" + block.id) {
                    $0.props.caption = new.isEmpty ? nil : RichText(new)
                }
            }
            .opacity(text.isEmpty && !focused ? 0.6 : 1)
    }
}

struct ImageBlockView: View {
    let block: Block
    let url: URL?
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var dragWidth: CGFloat?
    @State private var available: CGFloat = 700

    var body: some View {
        let stored = block.props.width.map { CGFloat($0) }
        let width = min(dragWidth ?? stored ?? available, available)
        HStack {
            image
                .frame(width: width)
                .clipShape(RoundedRectangle(cornerRadius: DS.Radius.small))
                .overlay(alignment: .trailing) { resizeHandle(width) }
            Spacer(minLength: 0)
        }
        .onGeometryChange(for: CGFloat.self, of: { $0.size.width }, action: { available = max(80, $0) })
    }

    @ViewBuilder
    private var image: some View {
        if let url, url.isFileURL, let img = PlatformImage(contentsOfFile: url.path) {
            Image(platformImage: img).resizable().scaledToFit()
        } else if let url {
            AsyncImage(url: url) { img in img.resizable().scaledToFit() } placeholder: {
                Rectangle().fill(Color(Theme.codeBackground)).frame(height: 200).overlay { ProgressView() }
            }
        } else {
            Rectangle().fill(Color(Theme.codeBackground)).frame(height: 120)
                .overlay { Label("Image unavailable", systemImage: "photo").foregroundStyle(Theme.secondary) }
        }
    }

    private func resizeHandle(_ width: CGFloat) -> some View {
        Capsule()
            .fill(Color.black.opacity(0.45))
            .frame(width: 6, height: 44)
            .padding(.trailing, DS.Space.sm)
            .opacity(editor.isLocked ? 0 : 0.8)
            .gesture(
                DragGesture(minimumDistance: 1)
                    .onChanged { v in dragWidth = max(80, min(available, (block.props.width.map { CGFloat($0) } ?? available) + v.translation.width)) }
                    .onEnded { _ in
                        if let w = dragWidth {
                            model.store.updateBlock(block.id, name: "Resize image") { $0.props.width = Double(w) }
                        }
                        dragWidth = nil
                    }
            )
    }
}

struct FileRow: View {
    let block: Block
    let url: URL?
    @Environment(\.openURL) private var openURL

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "paperclip").foregroundStyle(Theme.secondary)
            Text(block.props.asset?.name ?? url?.lastPathComponent ?? "File")
                .lineLimit(1)
            if let size = block.props.asset?.size {
                Text(ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file))
                    .font(DS.Text.small()).foregroundStyle(Theme.secondary)
            }
            Spacer()
            if let url {
                #if os(macOS)
                Button("Open") { openURL(url) }.buttonStyle(.hoverFill).foregroundStyle(Theme.secondary)
                #else
                ShareLink(item: url).labelStyle(.iconOnly)
                #endif
            }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(Color(Theme.codeBackground)))
    }
}

struct BookmarkCard: View {
    let block: Block
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL

    var body: some View {
        let meta = block.props.bookmark
        let url = block.props.url ?? ""
        Button { if let u = URL(string: url) { openURL(u) } } label: {
            HStack(alignment: .top, spacing: 0) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(meta?.title ?? url).font(DS.Text.ui(.medium)).lineLimit(1).foregroundStyle(Theme.primary)
                    if let s = meta?.summary, !s.isEmpty {
                        Text(s).font(DS.Text.small()).lineLimit(2).foregroundStyle(Theme.secondary)
                    }
                    Text(url).font(DS.Text.small()).lineLimit(1).foregroundStyle(Theme.primary)
                }
                .padding(DS.Space.lg)
                Spacer(minLength: 0)
                if let img = meta?.imageURL, let u = URL(string: img) {
                    AsyncImage(url: u) { i in i.resizable().scaledToFill() } placeholder: { Color.clear }
                        .frame(width: 160, height: 92)
                        .clipped()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: DS.Radius.small).stroke(Color(Theme.divider)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill)
        .task(id: url) {
            if meta == nil, !url.isEmpty { await fetch(url) }
        }
    }

    private func fetch(_ url: String) async {
        guard let u = URL(string: url), let meta = await LinkMetadata.fetch(u) else { return }
        let id = block.id
        await MainActor.run {
            model.store.updateBlock(id, name: "Bookmark") { $0.props.bookmark = meta }
        }
    }
}

/// Minimal Open Graph / <title> scraper for bookmarks.
enum LinkMetadata {
    static func fetch(_ url: URL) async -> BookmarkMeta? {
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("Mozilla/5.0 (Macintosh) Based/1.0", forHTTPHeaderField: "User-Agent")
        guard let (data, _) = try? await URLSession.shared.data(for: req),
              let html = String(data: data.prefix(400_000), encoding: .utf8) ?? String(data: data.prefix(400_000), encoding: .isoLatin1) else { return nil }
        func meta(_ prop: String) -> String? {
            for pattern in ["<meta[^>]+(?:property|name)=[\"']\(prop)[\"'][^>]*content=[\"']([^\"']*)[\"']",
                            "<meta[^>]+content=[\"']([^\"']*)[\"'][^>]*(?:property|name)=[\"']\(prop)[\"']"] {
                if let r = html.range(of: pattern, options: [.regularExpression, .caseInsensitive]) {
                    let tag = String(html[r])
                    if let c = tag.range(of: "content=[\"']([^\"']*)[\"']", options: .regularExpression) {
                        return decode(String(tag[c]).dropFirst(9).dropLast().description)
                    }
                }
            }
            return nil
        }
        var title = meta("og:title")
        if title == nil, let r = html.range(of: "<title[^>]*>[^<]*</title>", options: [.regularExpression, .caseInsensitive]) {
            let t = String(html[r]).replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
            title = decode(t.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        var image = meta("og:image")
        if let i = image, i.hasPrefix("/") { image = URL(string: i, relativeTo: url)?.absoluteString }
        return BookmarkMeta(title: title ?? url.host, summary: meta("og:description") ?? meta("description"), imageURL: image,
                            iconURL: URL(string: "/favicon.ico", relativeTo: url)?.absoluteString)
    }

    static func decode(_ s: String) -> String {
        s.replacingOccurrences(of: "&amp;", with: "&").replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'").replacingOccurrences(of: "&lt;", with: "<").replacingOccurrences(of: "&gt;", with: ">")
    }
}

/// Upload a file or paste a link for a media block.
struct MediaSourcePicker: View {
    let block: Block
    var done: () -> Void
    @Environment(AppModel.self) private var model
    @State private var link = ""
    @State private var importing = false

    private var types: [UTType] {
        switch block.type {
        case .image: return [.image]
        case .video: return [.movie, .audiovisualContent]
        case .audio: return [.audio]
        case .pdf: return [.pdf]
        default: return [.item]
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if block.type != .bookmark && block.type != .embed {
                Button { importing = true } label: {
                    Label("Upload file", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Text("or embed a link").font(DS.Text.small()).foregroundStyle(Theme.secondary)
            }
            TextField("Paste a link…", text: $link)
                .textFieldStyle(.roundedBorder)
                .onSubmit(apply)
            Button(block.type == .bookmark ? "Create bookmark" : "Embed link", action: apply)
                .disabled(URL(string: link.trimmingCharacters(in: .whitespaces))?.scheme == nil && !link.contains("."))
        }
        .padding(DS.Space.xl)
        .fileImporter(isPresented: $importing, allowedContentTypes: types) { result in
            if case .success(let url) = result, let ref = AssetImport.importFile(url, into: model.assets) {
                model.store.updateBlock(block.id, name: "Upload") { b in
                    b.props.asset = ref
                    b.props.url = nil
                    if b.type == .file, ref.mime == "application/pdf" { b.type = .pdf }
                }
                done()
            }
        }
    }

    private func apply() {
        var s = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return }
        if !s.contains("://") { s = "https://" + s }
        model.store.updateBlock(block.id, name: "Embed link") { b in
            b.props.url = s
            b.props.asset = nil
            b.props.bookmark = nil
        }
        done()
    }
}

enum AssetImport {
    /// Copy a user-selected file into the asset store (handles security-scoped URLs).
    static func importFile(_ url: URL, into assets: FileAssetStore) -> AssetRef? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        return try? assets.importFile(at: url)
    }
}

// MARK: - Equations

struct EquationBlockView: View {
    let block: Block
    let editor: EditorController
    @Environment(AppModel.self) private var model
    @State private var editing = false
    @State private var draft = ""

    var body: some View {
        let expr = block.props.expression ?? block.text.plainText
        Button {
            draft = expr
            editing = true
        } label: {
            Group {
                if expr.isEmpty {
                    Label("Add a TeX equation", systemImage: "function").foregroundStyle(Theme.secondary)
                } else {
                    Text(EquationRenderer.render(expr))
                        .font(.system(size: 20, design: .serif))
                        .italic()
                        .foregroundStyle(Theme.primary)
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(RoundedRectangle(cornerRadius: DS.Radius.small).fill(expr.isEmpty ? Color(Theme.codeBackground) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.hoverFill)
        .disabled(editor.isLocked)
        .panelPopover(isPresented: $editing) {
            VStack(alignment: .trailing, spacing: 8) {
                TextEditor(text: $draft)
                    .font(.system(size: 13, design: .monospaced))
                    .frame(minWidth: 320, minHeight: 90)
                Text(EquationRenderer.render(draft)).font(.system(size: 16, design: .serif)).italic()
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button("Done") {
                    model.store.updateBlock(block.id, name: "Edit equation") { $0.props.expression = draft }
                    editing = false
                }
                .keyboardShortcut(.return, modifiers: .command)
            }
            .padding(DS.Space.lg)
        }
    }
}

/// Lightweight TeX → Unicode rendering (Greek, operators, super/subscripts, fractions, roots).
enum EquationRenderer {
    static let symbols: [String: String] = [
        "alpha": "α", "beta": "β", "gamma": "γ", "delta": "δ", "epsilon": "ε", "varepsilon": "ε", "zeta": "ζ", "eta": "η",
        "theta": "θ", "vartheta": "ϑ", "iota": "ι", "kappa": "κ", "lambda": "λ", "mu": "μ", "nu": "ν", "xi": "ξ", "pi": "π",
        "rho": "ρ", "sigma": "σ", "tau": "τ", "upsilon": "υ", "phi": "φ", "varphi": "φ", "chi": "χ", "psi": "ψ", "omega": "ω",
        "Gamma": "Γ", "Delta": "Δ", "Theta": "Θ", "Lambda": "Λ", "Xi": "Ξ", "Pi": "Π", "Sigma": "Σ", "Phi": "Φ", "Psi": "Ψ", "Omega": "Ω",
        "sum": "∑", "prod": "∏", "int": "∫", "iint": "∬", "oint": "∮", "infty": "∞", "partial": "∂", "nabla": "∇",
        "cdot": "·", "times": "×", "div": "÷", "pm": "±", "mp": "∓", "leq": "≤", "le": "≤", "geq": "≥", "ge": "≥", "neq": "≠", "ne": "≠",
        "approx": "≈", "equiv": "≡", "sim": "∼", "propto": "∝", "to": "→", "rightarrow": "→", "leftarrow": "←", "Rightarrow": "⇒",
        "Leftarrow": "⇐", "leftrightarrow": "↔", "Leftrightarrow": "⇔", "mapsto": "↦", "in": "∈", "notin": "∉", "subset": "⊂",
        "subseteq": "⊆", "supset": "⊃", "cup": "∪", "cap": "∩", "emptyset": "∅", "forall": "∀", "exists": "∃", "neg": "¬",
        "land": "∧", "lor": "∨", "wedge": "∧", "vee": "∨", "ldots": "…", "cdots": "⋯", "dots": "…", "circ": "∘", "degree": "°",
        "sqrt": "√", "langle": "⟨", "rangle": "⟩", "hbar": "ħ", "ell": "ℓ", "Re": "ℜ", "Im": "ℑ", "aleph": "ℵ",
        "quad": "  ", "qquad": "    ", ",": " ", ";": " ", "!": "", "left": "", "right": "", "displaystyle": "",
        "sin": "sin", "cos": "cos", "tan": "tan", "log": "log", "ln": "ln", "exp": "exp", "lim": "lim", "max": "max", "min": "min",
    ]
    static let blackboard: [Character: String] = ["R": "ℝ", "N": "ℕ", "Z": "ℤ", "Q": "ℚ", "C": "ℂ", "P": "ℙ"]
    static let sup: [Character: Character] = ["0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
                                              "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ", "x": "ˣ", "y": "ʸ", "a": "ᵃ",
                                              "b": "ᵇ", "c": "ᶜ", "d": "ᵈ", "e": "ᵉ", "k": "ᵏ", "m": "ᵐ", "t": "ᵗ", "T": "ᵀ"]
    static let sub: [Character: Character] = ["0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
                                              "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎", "a": "ₐ", "e": "ₑ", "i": "ᵢ", "j": "ⱼ", "k": "ₖ",
                                              "n": "ₙ", "m": "ₘ", "o": "ₒ", "x": "ₓ", "t": "ₜ"]

    static func render(_ tex: String) -> String {
        var chars = Array(tex)
        var i = 0
        func group() -> String {
            while i < chars.count, chars[i] == " " { i += 1 }
            guard i < chars.count else { return "" }
            if chars[i] == "{" {
                var depth = 0, j = i
                var inner: [Character] = []
                while j < chars.count {
                    if chars[j] == "{" { depth += 1; if depth == 1 { j += 1; continue } }
                    if chars[j] == "}" { depth -= 1; if depth == 0 { break } }
                    inner.append(chars[j]); j += 1
                }
                i = j + 1
                return render(String(inner))
            }
            if chars[i] == "\\" {
                let start = i
                i += 1
                while i < chars.count, chars[i].isLetter { i += 1 }
                let name = String(chars[(start + 1)..<i])
                return symbols[name] ?? name
            }
            let c = chars[i]; i += 1
            return String(c)
        }
        var out = ""
        while i < chars.count {
            let c = chars[i]
            switch c {
            case "\\":
                i += 1
                var name = ""
                while i < chars.count, chars[i].isLetter { name.append(chars[i]); i += 1 }
                if name.isEmpty, i < chars.count { name = String(chars[i]); i += 1 }
                switch name {
                case "frac", "dfrac", "tfrac":
                    let a = group(), b = group()
                    out += (a.count > 1 ? "(\(a))" : a) + "⁄" + (b.count > 1 ? "(\(b))" : b)
                case "sqrt": let a = group(); out += "√" + (a.count > 1 ? "(\(a))" : a)
                case "mathbb": out += group().map { blackboard[$0] ?? String($0) }.joined()
                case "text", "mathrm", "mathbf", "mathit", "operatorname", "textbf", "mathcal": out += group()
                case "vec": out += group() + "\u{20D7}"
                case "hat": out += group() + "\u{0302}"
                case "bar", "overline": out += group() + "\u{0305}"
                case "dot": out += group() + "\u{0307}"
                case "{", "}": out += name
                default: out += symbols[name] ?? name
                }
            case "^", "_":
                i += 1
                let g = group()
                let table = c == "^" ? sup : sub
                let mapped = g.map { table[$0] }
                if mapped.allSatisfy({ $0 != nil }) { out += String(mapped.compactMap { $0 }) }
                else { out += (c == "^" ? "^" : "_") + (g.count > 1 ? "(\(g))" : g) }
            case "{", "}":
                i += 1
            default:
                out.append(c); i += 1
            }
        }
        chars = []
        return out
    }
}

// MARK: - Platform views

#if os(macOS)
struct PDFBlockView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(url: url)
        return v
    }
    func updateNSView(_ v: PDFView, context: Context) {
        if v.document?.documentURL != url { v.document = PDFDocument(url: url) }
    }
}

struct WebEmbedView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let v = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        v.load(URLRequest(url: url))
        return v
    }
    func updateNSView(_ v: WKWebView, context: Context) {
        if v.url != url, !v.isLoading, v.url?.host != url.host { v.load(URLRequest(url: url)) }
    }
}
#else
struct PDFBlockView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> PDFView {
        let v = PDFView()
        v.autoScales = true
        v.document = PDFDocument(url: url)
        return v
    }
    func updateUIView(_ v: PDFView, context: Context) {
        if v.document?.documentURL != url { v.document = PDFDocument(url: url) }
    }
}

struct WebEmbedView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        let v = WKWebView(frame: .zero, configuration: config)
        v.load(URLRequest(url: url))
        return v
    }
    func updateUIView(_ v: WKWebView, context: Context) {
        if v.url != url, !v.isLoading, v.url?.host != url.host { v.load(URLRequest(url: url)) }
    }
}
#endif