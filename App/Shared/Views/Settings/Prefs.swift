import SwiftUI
import BasedCore

/// User preferences mirrored from Notion's Settings (My settings / Language & region / Notifications).
/// Stored in UserDefaults; anything that influences rendering is read through here.
enum Prefs {
    // Keys
    static let startPage = "pref.startPage"             // "last" | "home" | page id
    static let openLinksInApp = "pref.openLinksInApp"
    static let cursorOnOpen = "pref.cursorOnOpen"       // "title" | "body" | "none"
    static let spellCheck = "pref.spellCheck"
    static let autoTimezone = "pref.autoTimezone"
    static let timezone = "pref.timezone"
    static let weekStartMonday = "pref.weekStartMonday"
    static let dateFormat = "pref.dateFormat"           // "system" | "iso" | "eu" | "us"
    static let timeFormat24h = "pref.time24h"
    static let language = "pref.language"
    static let notifyMobile = "pref.notify.mobile"
    static let notifyEmailActivity = "pref.notify.email.activity"
    static let notifyEmailDigest = "pref.notify.email.digest"
    static let notifyAnnouncements = "pref.notify.announcements"
    static let notifyAgents = "pref.notify.agents"      // inbox badge / local notification for agent approvals
    static let compactMode = "pref.compact"
    static let fontFamily = "pref.font"                 // "default" | "serif" | "mono"
    static let smallText = "pref.smallText"
    static let fullWidth = "pref.fullWidth"

    static var defaults: UserDefaults { .standard }

    static var calendar: Calendar {
        var c = Calendar.current
        if defaults.bool(forKey: weekStartMonday) { c.firstWeekday = 2 }
        if !(defaults.object(forKey: autoTimezone) as? Bool ?? true), let id = defaults.string(forKey: timezone), let tz = TimeZone(identifier: id) { c.timeZone = tz }
        return c
    }

    static var dateFormatter: DateFormatter {
        let f = DateFormatter()
        f.calendar = calendar; f.timeZone = calendar.timeZone
        switch defaults.string(forKey: dateFormat) ?? "system" {
        case "iso": f.dateFormat = "yyyy-MM-dd"
        case "eu": f.dateFormat = "dd.MM.yyyy"
        case "us": f.dateFormat = "MM/dd/yyyy"
        default: f.dateStyle = .medium
        }
        return f
    }

    static var languages: [(code: String, name: String)] {
        [("system", "Use system language"), ("en", "English"), ("de", "Deutsch"), ("fr", "Français"), ("es", "Español"), ("ja", "日本語"), ("ko", "한국어"), ("pt-BR", "Português (Brasil)"), ("zh-CN", "中文 (简体)")]
    }
}
