import SwiftUI
import BasedCore
#if os(macOS)
import AppKit
#endif

/// Finds layout problems in the running UI by walking the accessibility tree of each window:
/// - **outOfBounds**: an element sticks out of its window (clipped content, like a too-narrow window)
/// - **clipped**: a control is cut off by its parent (not a scroll view)
/// - **overlap**: two sibling controls cover each other (> 35 % of the smaller one)
/// - **tiny**: an interactive control smaller than 6 × 6 pt (unclickable)
/// Results go to the log (category `layout`) and the Diagnostics view. Runs on demand or, when
/// enabled in Diagnostics, automatically after navigation / window resizes (throttled).
@MainActor
final class LayoutAuditor {
    static let shared = LayoutAuditor()

    struct Issue: Identifiable, Hashable {
        enum Kind: String { case outOfBounds = "Out of window", clipped = "Clipped", overlap = "Overlap", tiny = "Too small" }
        let id = UUID()
        var kind: Kind
        var element: String
        var other: String?
        var frame: CGRect
        var detail: String
    }

    private(set) var lastIssues: [Issue] = []
    private(set) var lastRun: Date?
    private(set) var lastElementCount = 0
    private var pending = false
    private var lastAuto = Date.distantPast

    static var autoAuditEnabled: Bool {
        get {
            #if DEBUG
            return UserDefaults.standard.object(forKey: "diagnostics.autoAudit") as? Bool ?? true
            #else
            return UserDefaults.standard.bool(forKey: "diagnostics.autoAudit")
            #endif
        }
        set { UserDefaults.standard.set(newValue, forKey: "diagnostics.autoAudit") }
    }

    /// Throttled automatic audit (after the UI settled).
    func schedule(reason: String) {
        guard Self.autoAuditEnabled, !pending else { return }
        pending = true
        let wait = max(1.2, 4 - Date().timeIntervalSince(lastAuto))
        DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
            guard let self else { return }
            self.pending = false
            self.lastAuto = Date()
            let issues = self.run(log: true)
            if !issues.isEmpty { Log.debug("Layout audit after \(reason): \(issues.count) issue(s)", category: "layout") }
        }
    }

    @discardableResult
    func run(log: Bool = true) -> [Issue] {
        var issues: [Issue] = []
        var count = 0
        let started = Date()
        #if os(macOS)
        for w in NSApplication.shared.windows where w.isVisible && w.className != "NSStatusBarWindow" {
            guard let content = w.contentView else { continue }
            let windowFrame = w.convertToScreen(content.frame)
            var nodes: [Node] = []
            collect(w, depth: 0, parent: nil, into: &nodes, count: &count)
            issues += analyse(nodes, window: windowFrame, title: w.title)
        }
        #endif
        // De-duplicate identical reports.
        var seen = Set<String>()
        issues = issues.filter { seen.insert("\($0.kind)|\($0.element)|\($0.other ?? "")").inserted }
        lastIssues = issues
        lastRun = Date()
        lastElementCount = count
        if log {
            let ms = Int(Date().timeIntervalSince(started) * 1000)
            if issues.isEmpty {
                Log.debug("Layout audit: \(count) elements, no issues (\(ms) ms)", category: "layout")
            } else {
                for i in issues.prefix(25) {
                    Log.warning("\(i.kind.rawValue): \(i.element)\(i.other.map { " ↔ \($0)" } ?? "") — \(i.detail)", category: "layout",
                                metadata: ["frame": "\(Int(i.frame.minX)),\(Int(i.frame.minY)) \(Int(i.frame.width))×\(Int(i.frame.height))"])
                }
                Log.notice("Layout audit: \(issues.count) issue(s) in \(count) elements (\(ms) ms)", category: "layout")
            }
        }
        return issues
    }

    // MARK: Accessibility walk (macOS)

    struct Node {
        var frame: CGRect
        var role: String
        var name: String
        var depth: Int
        var parent: Int?
        var interactive: Bool
        var scrolls: Bool
    }

    #if os(macOS)
    private static let interactiveRoles: Set<String> = ["AXButton", "AXCheckBox", "AXTextField", "AXTextArea", "AXPopUpButton",
                                                        "AXMenuButton", "AXRadioButton", "AXSlider", "AXLink", "AXDisclosureTriangle", "AXComboBox"]

    private func value(_ obj: NSObject, _ key: String) -> Any? {
        guard obj.responds(to: NSSelectorFromString(key)) else { return nil }
        return obj.value(forKey: key)
    }

    private func collect(_ element: Any, depth: Int, parent: Int?, into nodes: inout [Node], count: inout Int) {
        guard count < 6000, depth < 60, let obj = element as? NSObject else { return }
        count += 1
        let frame = (value(obj, "accessibilityFrame") as? NSValue)?.rectValue ?? .zero
        let role = (value(obj, "accessibilityRole") as? String) ?? ""
        let label = (value(obj, "accessibilityLabel") as? String) ?? (value(obj, "accessibilityTitle") as? String) ?? ""
        let ident = (value(obj, "accessibilityIdentifier") as? String) ?? ""
        let hidden = (value(obj, "isAccessibilityHidden") as? Bool) ?? false
        if hidden { return }
        var name = ident.isEmpty ? label : ident
        if name.isEmpty { name = role.replacingOccurrences(of: "AX", with: "") }
        let index = nodes.count
        nodes.append(Node(frame: frame, role: role, name: String(name.prefix(60)), depth: depth, parent: parent,
                          interactive: Self.interactiveRoles.contains(role), scrolls: role == "AXScrollArea" || role == "AXOutline" || role == "AXTable" || role == "AXList"))
        let children = (value(obj, "accessibilityChildren") as? [Any]) ?? []
        for c in children { collect(c, depth: depth + 1, parent: index, into: &nodes, count: &count) }
    }
    #endif

    private func analyse(_ nodes: [Node], window: CGRect, title: String) -> [Issue] {
        var out: [Issue] = []
        let win = window.insetBy(dx: -2, dy: -2)
        // Elements inside scroll views may legitimately extend outside (they're scrolled away).
        func insideScroll(_ i: Int) -> Bool {
            var p = nodes[i].parent
            while let j = p { if nodes[j].scrolls { return true }; p = nodes[j].parent }
            return false
        }
        var children: [Int: [Int]] = [:]
        for (i, n) in nodes.enumerated() {
            if let p = n.parent { children[p, default: []].append(i) }
            guard n.frame.width > 0, n.frame.height > 0, n.role != "AXWindow" else { continue }
            let scrolled = insideScroll(i)
            if !scrolled, !win.contains(n.frame), n.frame.intersects(win), n.interactive || n.role == "AXStaticText" || n.role == "AXImage" {
                out.append(Issue(kind: .outOfBounds, element: n.name, other: nil, frame: n.frame,
                                 detail: "extends outside the window \"\(title)\" (\(Int(n.frame.width))×\(Int(n.frame.height)))"))
            }
            if n.interactive, !scrolled, let p = n.parent, nodes[p].frame.width > 0, !nodes[p].scrolls {
                let pf = nodes[p].frame.insetBy(dx: -2, dy: -2)
                let visible = pf.intersection(n.frame)
                if !visible.isNull, visible.width * visible.height < n.frame.width * n.frame.height * 0.6 {
                    out.append(Issue(kind: .clipped, element: n.name, other: nodes[p].name, frame: n.frame, detail: "less than 60 % visible inside its container"))
                }
            }
            if n.interactive, n.frame.width < 6 || n.frame.height < 6 {
                out.append(Issue(kind: .tiny, element: n.name, other: nil, frame: n.frame, detail: "\(Int(n.frame.width))×\(Int(n.frame.height)) pt is hard to click"))
            }
        }
        for (_, kids) in children {
            let leafs = kids.filter { nodes[$0].interactive || nodes[$0].role == "AXStaticText" }
            guard leafs.count > 1, leafs.count < 300 else { continue }
            for a in 0..<leafs.count {
                for b in (a + 1)..<leafs.count {
                    let x = nodes[leafs[a]], y = nodes[leafs[b]]
                    guard x.frame.width > 1, y.frame.width > 1, x.frame.intersects(y.frame) else { continue }
                    let inter = x.frame.intersection(y.frame)
                    let smaller = min(x.frame.width * x.frame.height, y.frame.width * y.frame.height)
                    if smaller > 0, inter.width * inter.height > smaller * 0.35, x.interactive || y.interactive {
                        out.append(Issue(kind: .overlap, element: x.name, other: y.name, frame: inter,
                                         detail: "\(Int(inter.width * inter.height / smaller * 100)) % of the smaller element is covered"))
                    }
                }
            }
        }
        return out
    }
}

extension View {
    /// Re-runs the (throttled) layout audit when this view appears or its size changes.
    func auditLayout(_ name: String) -> some View {
        modifier(AuditLayoutModifier(name: name))
    }
}

private struct AuditLayoutModifier: ViewModifier {
    let name: String
    func body(content: Content) -> some View {
        content
            .onAppear { LayoutAuditor.shared.schedule(reason: "\(name) appeared") }
            .onGeometryChange(for: CGSize.self, of: { CGSize(width: ($0.size.width / 40).rounded() * 40, height: ($0.size.height / 40).rounded() * 40) }) { _ in
                LayoutAuditor.shared.schedule(reason: "\(name) resized")
            }
    }
}
