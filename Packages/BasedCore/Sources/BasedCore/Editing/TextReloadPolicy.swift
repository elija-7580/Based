import Foundation

/// When a block's text view must reload its storage from the store (BSD-40).
///
/// Mentions are shown with the page's current title or a relative date („Today“), so the text read back from the
/// view (`applied`) can differ from the stored text although nobody edited anything. Comparing the stored text
/// with `applied` alone reloaded the view on every render after a rename or a new day: the caret jumped and a
/// running IME / dead-key composition was lost.
public enum TextReloadPolicy {
    /// - Parameters:
    ///   - text: the stored text now.
    ///   - applied: the text the view holds (last loaded or typed).
    ///   - loadedSource: the stored text the view was last loaded from.
    ///   - mentions: the displayed mention texts now (only evaluated when needed).
    ///   - loadedMentions: the displayed mention texts at the last load or edit.
    public static func needsReload(text: RichText, applied: RichText, loadedSource: RichText?,
                                   mentions: () -> [String], loadedMentions: [String]) -> Bool {
        // Changed elsewhere (sync, agent, undo, another window) and not what the view shows: reload.
        if text != applied && text != loadedSource { return true }
        // Otherwise only a mention that now displays differently (rename, new day) reloads, once.
        return text.hasMentions && mentions() != loadedMentions
    }
}
