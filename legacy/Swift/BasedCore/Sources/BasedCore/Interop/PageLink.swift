import Foundation

/// One link format for a page everywhere — the app, agents (MCP resources use the same URI), the web client,
/// exports and other apps: `based://page/<id>`. Parsing is lenient so links copied from elsewhere still open.
public enum PageLink {
    public static let scheme = "based"

    /// `based://page/<id>`
    public static func url(_ id: RecordID) -> String { "based://page/\(id)" }

    /// Markdown link `[Title](based://page/<id>)`, for chats, notes and other editors.
    public static func markdown(_ id: RecordID, title: String) -> String {
        let t = title.isEmpty ? "Untitled" : title.replacingOccurrences(of: "]", with: "\\]")
        return "[\(t)](\(url(id)))"
    }

    /// Web client link on a based-server (`https://host/app#<id>`).
    public static func web(_ id: RecordID, server: String) -> String? {
        let base = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        return base.isEmpty ? nil : "\(base)/app#\(id)"
    }

    /// Page id from any accepted form: `based://page/<id>`, `based://<id>`, `…/app#<id>`, a bare UUID, or a
    /// Notion-style 32-hex id (Notion imports keep those ids, dashed).
    public static func id(from raw: String) -> RecordID? {
        let s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var candidate = s
        if let u = URL(string: s) {
            if u.scheme == scheme {
                candidate = u.host == "page" || u.host == "block" ? u.lastPathComponent : (u.host ?? u.lastPathComponent)
            } else if let f = u.fragment, !f.isEmpty {
                candidate = f
            } else if !u.lastPathComponent.isEmpty, u.scheme != nil {
                candidate = u.lastPathComponent
            }
        }
        // Notion URLs end in "Title-<32hex>".
        if let r = candidate.range(of: "[0-9a-fA-F]{32}$", options: .regularExpression) { candidate = String(candidate[r]) }
        let hex = candidate.replacingOccurrences(of: "-", with: "").lowercased()
        guard hex.count == 32, hex.allSatisfy({ $0.isHexDigit }) else { return candidate.isEmpty ? nil : candidate }
        let c = Array(hex)
        return String(c[0..<8]) + "-" + String(c[8..<12]) + "-" + String(c[12..<16]) + "-" + String(c[16..<20]) + "-" + String(c[20..<32])
    }
}
