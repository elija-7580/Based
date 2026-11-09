import Automerge
import Foundation

// Zwei Replikate bearbeiten denselben Absatz parallel (wie bench.mjs), dann Merge.
let base = "Der schnelle braune Fuchs springt über den faulen Hund."
let a = Document()
let text = try a.putObject(obj: .ROOT, key: "text", ty: .Text)
try a.spliceText(obj: text, start: 0, delete: 0, value: base)
let b = a.fork()
let clock = ContinuousClock()
let edit = try clock.measure {
    for i in 0 ..< 500 { try a.spliceText(obj: text, start: UInt64(10 + i), delete: 0, value: String(UnicodeScalar(97 + (i * 7 + 1) % 26)!)) }
    for i in 0 ..< 500 { try b.spliceText(obj: text, start: UInt64(base.count + i), delete: 0, value: String(UnicodeScalar(97 + (i * 7 + 3) % 26)!)) }
    try b.mark(obj: text, start: 0, end: 9, expand: .after, name: "bold", value: .Boolean(true))
    try b.mark(obj: text, start: 20, end: 30, expand: .none, name: "link", value: .String("https://example.com"))
}
let merge = try clock.measure { try a.merge(other: b); try b.merge(other: a) }
let ta = try a.text(obj: text), tb = try b.text(obj: text)
let marks = try a.marks(obj: text)
print("Automerge-Swift (Linux): edit \(edit), merge \(merge), konvergiert \(ta == tb), Zeichen \(ta.count), Marks \(marks.count), save \(a.save().count) B")
