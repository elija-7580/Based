import Foundation
import BasedCore

/// A keyboard shortcut for the system-wide quick capture on the Mac (BSD-64), e.g. "⌥⇧Space".
///
/// Parses what people type in Settings ("⌥⇧Space", "option+shift+space", "Cmd-Ctrl-C", "ctrl alt n") and gives the
/// Carbon key code / modifier mask that `RegisterEventHotKey` wants (ANSI layout key positions).
public struct HotKey: Hashable, Sendable, CustomStringConvertible {
    public struct Modifiers: OptionSet, Hashable, Sendable {
        public let rawValue: Int
        public init(rawValue: Int) { self.rawValue = rawValue }
        public static let control = Modifiers(rawValue: 1)
        public static let option = Modifiers(rawValue: 2)
        public static let shift = Modifiers(rawValue: 4)
        public static let command = Modifiers(rawValue: 8)
    }

    public var modifiers: Modifiers
    /// Normalised key name: "Space", "Return", "Tab", "F1"…"F12", or one upper-case character ("C", "1", "/").
    public var key: String

    public init(modifiers: Modifiers, key: String) {
        self.modifiers = modifiers
        self.key = key
    }

    public static let defaultQuickCapture = HotKey(modifiers: [.option, .shift], key: "Space")

    /// Mac order: ⌃⌥⇧⌘ then the key.
    public var description: String {
        var s = ""
        if modifiers.contains(.control) { s += "⌃" }
        if modifiers.contains(.option) { s += "⌥" }
        if modifiers.contains(.shift) { s += "⇧" }
        if modifiers.contains(.command) { s += "⌘" }
        return s + key
    }

    /// nil when the text names no key, an unknown key, or no modifier (a bare key would swallow normal typing —
    /// only F-keys may stand alone).
    public static func parse(_ text: String) -> HotKey? {
        var rest = Substring(text.trimmingCharacters(in: .whitespacesAndNewlines))
        var mods: Modifiers = []
        let symbols: [Character: Modifiers] = ["⌃": .control, "⌥": .option, "⇧": .shift, "⌘": .command]
        while let c = rest.first, let m = symbols[c] { mods.insert(m); rest = rest.dropFirst() }
        let words: [String: Modifiers] = ["ctrl": .control, "control": .control, "ctl": .control, "^": .control,
                                          "alt": .option, "opt": .option, "option": .option,
                                          "shift": .shift, "cmd": .command, "command": .command, "super": .command]
        // Separators: "+", " " and "-" (so "-" itself can only be the key after symbols: "⌃⌥-").
        var parts = rest.split(whereSeparator: { $0 == "+" || $0 == "-" || $0 == " " }).map(String.init)
        if parts.isEmpty, rest == "-" { parts = ["-"] }
        guard !parts.isEmpty else { return nil }
        let keyPart = parts.removeLast()
        for p in parts {
            guard let m = words[p.lowercased()] else { return nil }
            mods.insert(m)
        }
        guard let key = normalizedKey(keyPart) else { return nil }
        if mods.isEmpty && !key.hasPrefix("F") { return nil }
        if mods.isEmpty, key.count == 1 { return nil }
        return HotKey(modifiers: mods, key: key)
    }

    static func normalizedKey(_ raw: String) -> String? {
        let l = raw.lowercased()
        switch l {
        case "space", "spacebar", "leertaste", "␣": return "Space"
        case "return", "enter", "↩": return "Return"
        case "tab", "⇥": return "Tab"
        default: break
        }
        if l.hasPrefix("f"), let n = Int(l.dropFirst()), (1...12).contains(n) { return "F\(n)" }
        guard raw.count == 1 else { return nil }
        let k = raw.uppercased()
        return keyCodes[k] != nil ? k : nil
    }

    // MARK: Carbon

    /// Virtual key codes (kVK_ANSI_* / kVK_*).
    static let keyCodes: [String: UInt32] = [
        "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7, "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13,
        "E": 14, "R": 15, "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "O": 31, "U": 32, "[": 33, "I": 34, "P": 35, "Return": 36,
        "L": 37, "J": 38, "'": 39, "K": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "N": 45, "M": 46, ".": 47,
        "Tab": 48, "Space": 49, "`": 50,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97, "F7": 98, "F8": 100, "F9": 101, "F10": 109,
        "F11": 103, "F12": 111,
    ]

    public var carbonKeyCode: UInt32 { Self.keyCodes[key] ?? 49 }

    /// cmdKey 0x100, shiftKey 0x200, optionKey 0x800, controlKey 0x1000.
    public var carbonModifiers: UInt32 {
        var m: UInt32 = 0
        if modifiers.contains(.command) { m |= 0x100 }
        if modifiers.contains(.shift) { m |= 0x200 }
        if modifiers.contains(.option) { m |= 0x800 }
        if modifiers.contains(.control) { m |= 0x1000 }
        return m
    }
}

/// What the quick-capture field does with its input (BSD-64): a capture in Captures, or a task for the main agent.
public enum QuickCapture {
    public enum Outcome: Equatable, Sendable {
        case captured(RecordID)
        /// Hand the text to the main agent's thread (the "To main agent" switch).
        case askMainAgent(String)
        case failed(String)
    }

    /// A web link on the clipboard pre-fills the link (only http/https, nothing else from the clipboard is read).
    public static func prefillLink(clipboard: String?) -> String? {
        guard let s = clipboard?.trimmingCharacters(in: .whitespacesAndNewlines), !s.contains(where: \.isNewline),
              CaptureInput.isWebLink(s) else { return nil }
        return s
    }

    @MainActor
    public static func submit(text: String, link: String? = nil, toMainAgent: Bool, source: Capture.Source = .mac,
                              brain: BrainStore, now: Date = Date()) -> Outcome {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let l = link?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        if toMainAgent {
            let task = [t, l ?? ""].filter { !$0.isEmpty }.joined(separator: "\n")
            return task.isEmpty ? .failed(CaptureInput.Problem.empty.description) : .askMainAgent(task)
        }
        do {
            return .captured(try brain.addCapture(CaptureInput(text: t, link: l, source: source, capturedAt: now)))
        } catch {
            return .failed((error as? CaptureInput.Problem)?.description ?? "\(error)")
        }
    }
}
