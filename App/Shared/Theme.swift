import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
typealias PlatformColor = NSColor
typealias PlatformFont = NSFont
typealias PlatformImage = NSImage
#else
import UIKit
typealias PlatformColor = UIColor
typealias PlatformFont = UIFont
typealias PlatformImage = UIImage
#endif

enum Theme {
    /// Page text zoom (⌘+ / ⌘- / ⌘0), 0.7…1.6. Stored per user.
    nonisolated(unsafe) static var zoom: CGFloat = {
        let z = UserDefaults.standard.double(forKey: "pageZoom")
        return z > 0 ? CGFloat(z) : 1
    }()
    static var bodySize: CGFloat { 16 * zoom }
    static let contentWidth: CGFloat = 708
    static let indent: CGFloat = 26
    static let blockSpacing: CGFloat = 2

    static func hex(_ v: UInt32) -> (CGFloat, CGFloat, CGFloat) {
        (CGFloat((v >> 16) & 0xFF) / 255, CGFloat((v >> 8) & 0xFF) / 255, CGFloat(v & 0xFF) / 255)
    }

    static func dynamic(light: UInt32, dark: UInt32) -> PlatformColor {
        let l = hex(light), d = hex(dark)
        #if os(macOS)
        return NSColor(name: nil) { appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let c = isDark ? d : l
            return NSColor(srgbRed: c.0, green: c.1, blue: c.2, alpha: 1)
        }
        #else
        return UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? d : l
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: 1)
        }
        #endif
    }

    /// Notion-like palette (text colours and highlight backgrounds), light/dark.
    static func platformColor(_ c: TColor) -> PlatformColor {
        switch c {
        case .default, .unknown: return textPrimary   // BSD-130: a colour from a newer version draws as default
        case .gray: return dynamic(light: 0x787774, dark: 0x9B9B9B)
        case .brown: return dynamic(light: 0x9F6B53, dark: 0xBA856F)
        case .orange: return dynamic(light: 0xD9730D, dark: 0xC77D48)
        case .yellow: return dynamic(light: 0xCB912F, dark: 0xCA9849)
        case .green: return dynamic(light: 0x448361, dark: 0x529E72)
        case .blue: return dynamic(light: 0x337EA9, dark: 0x5E87C9)
        case .purple: return dynamic(light: 0x9065B0, dark: 0x9D68D3)
        case .pink: return dynamic(light: 0xC14C8A, dark: 0xD15796)
        case .red: return dynamic(light: 0xD44C47, dark: 0xDF5452)
        case .grayBackground: return dynamic(light: 0xF1F1EF, dark: 0x2F2F2F)
        case .brownBackground: return dynamic(light: 0xF4EEEE, dark: 0x4A3228)
        case .orangeBackground: return dynamic(light: 0xFBECDD, dark: 0x5C3B23)
        case .yellowBackground: return dynamic(light: 0xFBF3DB, dark: 0x564328)
        case .greenBackground: return dynamic(light: 0xEDF3EC, dark: 0x243D30)
        case .blueBackground: return dynamic(light: 0xE7F3F8, dark: 0x143A4E)
        case .purpleBackground: return dynamic(light: 0xF6F3F9, dark: 0x3C2D49)
        case .pinkBackground: return dynamic(light: 0xFAF1F5, dark: 0x4E2C3C)
        case .redBackground: return dynamic(light: 0xFDEBEC, dark: 0x522E2A)
        }
    }

    static func color(_ c: TColor) -> Color { Color(platformColor(c)) }

    /// Tag/option pill backgrounds.
    static func optionBackground(_ c: TColor) -> Color {
        switch c {
        case .default: return Color(dynamic(light: 0xE3E2E0, dark: 0x373737))
        case .gray: return Color(dynamic(light: 0xE3E2E0, dark: 0x5A5A5A))
        case .brown: return Color(dynamic(light: 0xEEE0DA, dark: 0x603B2C))
        case .orange: return Color(dynamic(light: 0xFADEC9, dark: 0x854C1D))
        case .yellow: return Color(dynamic(light: 0xFDECC8, dark: 0x89632A))
        case .green: return Color(dynamic(light: 0xDBEDDB, dark: 0x2B593F))
        case .blue: return Color(dynamic(light: 0xD3E5EF, dark: 0x28456C))
        case .purple: return Color(dynamic(light: 0xE8DEEE, dark: 0x492F64))
        case .pink: return Color(dynamic(light: 0xF5E0E9, dark: 0x69314C))
        case .red: return Color(dynamic(light: 0xFFE2DD, dark: 0x6E3630))
        default: return color(c)
        }
    }

    static let textPrimary = dynamic(light: 0x37352F, dark: 0xD4D4D4)
    static let textSecondary = dynamic(light: 0x787774, dark: 0x9B9B9B)
    static let codeBackground = dynamic(light: 0xF7F6F3, dark: 0x2A2A2A)
    static let inlineCode = dynamic(light: 0xEB5757, dark: 0xFF7369)
    static let selection = dynamic(light: 0xD3E5EF, dark: 0x1F3A4D)
    static let divider = dynamic(light: 0xE9E9E7, dark: 0x373737)

    /// Notion's hover fill for quiet buttons and menu rows (rgba(55,53,47,0.08) light).
    static let hoverFillColor = dynamic(light: 0xEFEFEE, dark: 0x2C2C2C)
    static var hoverFill: Color { Color(hoverFillColor) }
    /// Table grid / row separators — lighter than block dividers (Notion: rgba(55,53,47,0.09)).
    /// Small floating controls over content (row "Open" pill): page white / a slightly raised dark gray.
    static let pageBackgroundColor = dynamic(light: 0xFFFFFF, dark: 0x2A2A2A)
    static let gridLineColor = dynamic(light: 0xEDEDEC, dark: 0x2B2B2B)
    static var gridLine: Color { Color(gridLineColor) }
    static var dividerColor: Color { Color(divider) }

    /// Code highlighting (light: Notion's Prism-like palette; dark: a softer Material-like one).
    static func codeColor(_ k: SyntaxHighlighter.Kind) -> PlatformColor {
        switch k {
        case .keyword: return dynamic(light: 0x0077AA, dark: 0xC792EA)
        case .string: return dynamic(light: 0x669900, dark: 0xC3E88D)
        case .comment: return dynamic(light: 0x8A8A86, dark: 0x7E8186)
        case .number: return dynamic(light: 0x990055, dark: 0xF78C6C)
        case .function: return dynamic(light: 0xDD4A68, dark: 0x82AAFF)
        case .type: return dynamic(light: 0x0F7B7B, dark: 0xFFCB6B)
        case .property: return dynamic(light: 0x905090, dark: 0x89DDFF)
        }
    }

    /// Checked to-do fill (Notion blue; document colour, not the system accent).
    static var todoBlue: Color { Color(dynamic(light: 0x2383E2, dark: 0x2383E2)) }

    /// Notion's interface blue (primary "New" button, resize lines, active toolbar icons).
    static var accentBlue: Color { Color(dynamic(light: 0x2383E2, dark: 0x2383E2)) }

    /// Drag & drop target line (Notion blue, independent of the system accent colour).
    static var dropIndicator: Color { Color(dynamic(light: 0x2383E2, dark: 0x529CCA)).opacity(0.85) }

    static var secondary: Color { Color(textSecondary) }
    static var primary: Color { Color(textPrimary) }

    static func fontSize(for type: BlockType, small: Bool) -> CGFloat {
        let base: CGFloat = small ? 14 * zoom : bodySize
        switch type {
        case .heading1: return base * 1.875
        case .heading2: return base * 1.5
        case .heading3: return base * 1.25
        case .heading4: return base * 1.1
        case .page: return (small ? 34 : 40) * zoom
        case .code: return base * 0.875
        default: return base
        }
    }

    /// Height of the first line of a block's text view (used to align bullets, checkboxes and handles).
    static func lineHeight(for type: BlockType, format: PageFormat?) -> CGFloat {
        let size = fontSize(for: type, small: format?.smallText == true)
        let mult: CGFloat = type == .code ? 1.2 : (type.isHeading || type == .page ? 1.05 : 1.18)
        return ceil(size * 1.2 * mult) + 6
    }

    static func baseFont(for type: BlockType, format: PageFormat?) -> PlatformFont {
        let size = fontSize(for: type, small: format?.smallText == true)
        // Notion: page title 700, headings 600.
        let weight: PlatformFont.Weight = type == .page ? .bold : (type.isHeading ? .semibold : .regular)
        if type == .code { return PlatformFont.monospacedSystemFont(ofSize: size, weight: .regular) }
        let base = PlatformFont.systemFont(ofSize: size, weight: weight)
        switch format?.font ?? .default {
        case .serif: return withDesign(base, serif: true) ?? base
        case .mono: return PlatformFont.monospacedSystemFont(ofSize: size * 0.95, weight: weight)
        default: return base
        }
    }

    static func withDesign(_ f: PlatformFont, serif: Bool) -> PlatformFont? {
        #if os(macOS)
        guard let d = f.fontDescriptor.withDesign(.serif) else { return nil }
        return NSFont(descriptor: d, size: f.pointSize)
        #else
        guard let d = f.fontDescriptor.withDesign(.serif) else { return nil }
        return UIFont(descriptor: d, size: f.pointSize)
        #endif
    }
}

extension PageIcon {
    @ViewBuilder
    func view(size: CGFloat, assets: FileAssetStore?) -> some View {
        switch self {
        case .emoji(let e):
            Text(e).font(.system(size: size * 0.85))
        case .symbol(let s):
            Image(systemName: s).font(.system(size: size * 0.7)).foregroundStyle(Theme.secondary)
        case .asset(let a):
            if let url = assets?.url(for: a), let img = PlatformImage(contentsOfFile: url.path) {
                Image(platformImage: img).resizable().scaledToFill().frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: 4))
            } else {
                Image(systemName: "photo").font(.system(size: size * 0.6))
            }
        case .url(let u):
            AsyncImage(url: URL(string: u)) { img in img.resizable().scaledToFill() } placeholder: { Color.clear }
                .frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
}

extension Image {
    init(platformImage: PlatformImage) {
        #if os(macOS)
        self.init(nsImage: platformImage)
        #else
        self.init(uiImage: platformImage)
        #endif
    }
}

/// Small icon for a page in lists (emoji, image or a document glyph).
struct PageIconView: View {
    let icon: PageIcon?
    var isDatabase = false
    var size: CGFloat = 18
    @Environment(AppModel.self) private var model

    var body: some View {
        if let icon {
            icon.view(size: size, assets: model.assets).frame(width: size, height: size)
        } else {
            Image(systemName: isDatabase ? "tablecells" : "doc.text")
                .font(.system(size: size * 0.75))
                .foregroundStyle(Theme.secondary)
                .frame(width: size, height: size)
        }
    }
}

struct OptionPill: View {
    let name: String
    let color: TColor
    var body: some View {
        Text(name.isEmpty ? " " : name)
            .font(.system(size: 13))
            .lineLimit(1)
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(RoundedRectangle(cornerRadius: 3).fill(Theme.optionBackground(color)))
            .foregroundStyle(Theme.primary)
    }
}

extension PropertyType {
    var symbol: String {
        switch self {
        case .title: return "textformat"
        case .text: return "text.alignleft"
        case .number: return "number"
        case .select: return "chevron.down.circle"
        case .multiSelect: return "list.bullet"
        case .status: return "circle.dotted.circle"
        case .date: return "calendar"
        case .person: return "person"
        case .files: return "paperclip"
        case .checkbox: return "checkmark.square"
        case .url: return "link"
        case .email: return "at"
        case .phone: return "phone"
        case .formula: return "function"
        case .relation: return "arrow.up.right"
        case .rollup: return "magnifyingglass"
        case .createdTime, .lastEditedTime: return "clock"
        case .createdBy, .lastEditedBy: return "person.crop.circle"
        case .button: return "cursorarrow.click"
        case .uniqueID: return "number.square"
        case .place: return "mappin"
        case .verification: return "checkmark.seal"
        case .unknown: return "questionmark.square.dashed"
        }
    }
}

extension ViewType {
    var symbol: String {
        switch self {
        case .table: return "tablecells"
        case .board: return "rectangle.split.3x1"
        case .list: return "list.bullet"
        case .gallery: return "square.grid.2x2"
        case .calendar: return "calendar"
        case .timeline: return "chart.bar.xaxis"
        case .chart: return "chart.pie"
        case .form: return "list.clipboard"
        case .dashboard: return "rectangle.3.group"
        case .map: return "map"
        default: return "square.stack"
        }
    }
}

extension BlockType {
    var symbol: String {
        switch self {
        case .text: return "textformat"
        case .heading1, .heading2, .heading3, .heading4: return "textformat.size"
        case .bulletedList: return "list.bullet"
        case .numberedList: return "list.number"
        case .todo: return "checklist"
        case .toggle: return "chevron.right"
        case .quote: return "text.quote"
        case .callout: return "lightbulb"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .page: return "doc"
        case .equation: return "function"
        default: return "square"
        }
    }
}