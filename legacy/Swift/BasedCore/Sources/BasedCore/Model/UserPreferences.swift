import Foundation

/// BSD-71: the decisions behind Settings → My settings, as pure functions (the app reads UserDefaults and
/// passes the values in).
public enum UserPreferences {
    /// Where the app opens on launch.
    public enum StartTarget: Equatable, Sendable {
        case home
        case page(RecordID)
    }

    /// `pref` is the stored choice: "last" (default), "home" or a page ID. A page that no longer opens (deleted,
    /// trashed) falls back to the last visited page, then to `fallback` (the first top-level page); nil = Home.
    public static func startTarget(pref: String?, lastPage: RecordID?, fallback: RecordID?,
                                   isOpenable: (RecordID) -> Bool) -> StartTarget {
        switch pref ?? "last" {
        case "home":
            return .home
        case "last", "":
            break
        case let id:
            if isOpenable(id) { return .page(id) }
        }
        if let last = lastPage, isOpenable(last) { return .page(last) }
        if let f = fallback, isOpenable(f) { return .page(f) }
        return .home
    }

    /// Style of a page created by the user (Notion: per page, default from settings). nil = no format record
    /// (all defaults), so existing data and new pages without preferences look the same.
    public static func newPageFormat(font: String?, smallText: Bool, fullWidth: Bool) -> PageFormat? {
        let f = font.flatMap(PageFont.init(rawValue:)).flatMap { $0 == .default ? nil : $0 }
        guard f != nil || smallText || fullWidth else { return nil }
        return PageFormat(font: f, smallText: smallText ? true : nil, fullWidth: fullWidth ? true : nil)
    }
}
