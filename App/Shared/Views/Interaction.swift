import SwiftUI
#if os(macOS)
import AppKit
#endif

// Shared interaction pieces: every clickable thing reacts to the pointer (hover fill, pressed state) and every
// resize edge has a generous hit area, the resize cursor and a blue line while hovered or dragged.

// MARK: - Quiet buttons

/// Notion-style quiet button: transparent at rest, soft rounded fill on hover, a bit darker while pressed.
/// The whole padded area is clickable, so small icons are easy to hit.
struct QuietButtonStyle: ButtonStyle {
    var padding: CGFloat = 4
    var cornerRadius: CGFloat = 5
    var minSize: CGFloat = 24
    /// Draws the fill even without hover (e.g. the selected view tab).
    var selected = false

    func makeBody(configuration: Configuration) -> some View {
        QuietButtonBody(configuration: configuration, style: self)
    }

    private struct QuietButtonBody: View {
        let configuration: ButtonStyleConfiguration
        let style: QuietButtonStyle
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .padding(style.padding)
                .frame(minWidth: style.minSize, minHeight: style.minSize)
                .background(
                    RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous)
                        .fill(Theme.primary.opacity(fillOpacity))
                )
                .contentShape(RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous))
                .opacity(enabled ? 1 : 0.45)
                .clickableCursor()
                .onHover { hover = $0 }
                .animation(.easeOut(duration: 0.1), value: hover)
                .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
        }

        private var fillOpacity: Double {
            guard enabled else { return 0 }
            if configuration.isPressed { return 0.13 }
            if style.selected { return hover ? 0.1 : 0.07 }
            return hover ? 0.065 : 0
        }
    }
}

/// Drop-in replacement for `.plain`: the layout stays exactly the same, but the area under the pointer
/// gets a soft rounded fill on hover (a bit darker while pressed) and a pointing-hand cursor.
/// The fill bleeds `outset` pt past the label so small icon buttons get a comfortable highlight.
struct HoverFillButtonStyle: ButtonStyle {
    var cornerRadius: CGFloat = 5
    var outset: CGFloat = 3

    func makeBody(configuration: Configuration) -> some View {
        HoverFillBody(configuration: configuration, style: self)
    }

    private struct HoverFillBody: View {
        let configuration: ButtonStyleConfiguration
        let style: HoverFillButtonStyle
        @State private var hover = false
        @Environment(\.isEnabled) private var enabled

        var body: some View {
            configuration.label
                .padding(style.outset)
                .background(
                    RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous)
                        .fill(Theme.primary.opacity(fillOpacity))
                )
                .contentShape(RoundedRectangle(cornerRadius: style.cornerRadius, style: .continuous))
                .padding(-style.outset)
                .clickableCursor()
                .onHover { hover = $0 }
                .animation(.easeOut(duration: 0.1), value: hover)
                .animation(.easeOut(duration: 0.06), value: configuration.isPressed)
        }

        private var fillOpacity: Double {
            guard enabled else { return 0 }
            if configuration.isPressed { return 0.13 }
            return hover ? 0.07 : 0
        }
    }
}

extension ButtonStyle where Self == HoverFillButtonStyle {
    /// `.plain` + hover fill + pointing hand.
    static var hoverFill: HoverFillButtonStyle { HoverFillButtonStyle() }
    static func hoverFill(cornerRadius: CGFloat = 5, outset: CGFloat = 3) -> HoverFillButtonStyle {
        HoverFillButtonStyle(cornerRadius: cornerRadius, outset: outset)
    }
}

extension View {
    /// Pointing-hand cursor over clickable things (macOS 15+; older systems keep the arrow).
    @ViewBuilder
    func clickableCursor() -> some View {
        #if os(macOS)
        if #available(macOS 15, *) { self.pointerStyle(.link) } else { self }
        #else
        self
        #endif
    }
}

extension ButtonStyle where Self == QuietButtonStyle {
    /// Icon / text button with hover fill (24 pt minimum hit area).
    static var quiet: QuietButtonStyle { QuietButtonStyle() }
    static func quiet(padding: CGFloat = 4, cornerRadius: CGFloat = 5, minSize: CGFloat = 24, selected: Bool = false) -> QuietButtonStyle {
        QuietButtonStyle(padding: padding, cornerRadius: cornerRadius, minSize: minSize, selected: selected)
    }
}

/// Toolbar icon (thin, consistent size / weight) for quiet buttons.
struct ToolbarIcon: View {
    let systemName: String
    var active = false
    var size: CGFloat = 13

    init(_ systemName: String, active: Bool = false, size: CGFloat = 13) {
        self.systemName = systemName
        self.active = active
        self.size = size
    }

    var body: some View {
        Image(systemName: systemName)
            .font(.system(size: size, weight: .regular))
            .symbolRenderingMode(.monochrome)
            .foregroundStyle(active ? Theme.accentBlue : Theme.secondary)
            .frame(width: 16, height: 16)
    }
}

// MARK: - Hover highlight for rows

extension View {
    /// Soft rounded background while the pointer is over the view (list rows, cards, menu-like rows).
    func hoverHighlight(cornerRadius: CGFloat = 5, opacity: Double = 0.045) -> some View {
        modifier(HoverHighlight(cornerRadius: cornerRadius, opacity: opacity))
    }
}

private struct HoverHighlight: ViewModifier {
    let cornerRadius: CGFloat
    let opacity: Double
    @State private var hover = false

    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(Theme.primary.opacity(hover ? opacity : 0))
            )
            .onHover { hover = $0 }
            .animation(.easeOut(duration: 0.1), value: hover)
    }
}

// MARK: - Resize handle

/// A vertical resize edge: 12 pt hit area centred on a hairline, the left-right resize cursor while hovered
/// *or dragged* (the cursor no longer flips back when the pointer outruns the edge), and a blue 2 pt line.
/// Reports the drag translation in window coordinates, so a handle that moves with the size doesn't jitter.
struct ResizeHandle: View {
    /// Hairline drawn at rest (nil: invisible until hovered).
    var restColor: Color? = nil
    var hitWidth: CGFloat = 12
    let onBegan: () -> Void
    let onChanged: (CGFloat) -> Void
    let onEnded: () -> Void
    var onDoubleClick: (() -> Void)? = nil

    @State private var hover = false
    @State private var dragging = false
    #if os(macOS)
    @State private var cursorPushed = false
    #endif

    private var active: Bool { hover || dragging }

    var body: some View {
        ZStack {
            if let restColor, !active {
                Rectangle().fill(restColor).frame(width: 1)
            }
            Capsule()
                .fill(Theme.accentBlue)
                .frame(width: 2.5)
                .opacity(active ? (dragging ? 1 : 0.75) : 0)
        }
        .frame(width: hitWidth)
        .frame(maxHeight: .infinity)
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .gesture(
            DragGesture(minimumDistance: 0, coordinateSpace: .global)
                .onChanged { v in
                    if !dragging { dragging = true; onBegan() }
                    onChanged(v.translation.width)
                }
                .onEnded { _ in
                    dragging = false
                    onEnded()
                }
        )
        .simultaneousGesture(TapGesture(count: 2).onEnded { onDoubleClick?() })
        .animation(.easeOut(duration: 0.12), value: active)
        #if os(macOS)
        .onChange(of: active) { _, on in updateCursor(on) }
        .onDisappear { updateCursor(false) }
        #endif
    }

    #if os(macOS)
    private func updateCursor(_ on: Bool) {
        if on, !cursorPushed { NSCursor.resizeLeftRight.push(); cursorPushed = true }
        else if !on, cursorPushed { NSCursor.pop(); cursorPushed = false }
    }
    #endif
}

// MARK: - Primary split button ("New ⌄")

/// Notion's blue "New ⌄": the left part runs the primary action, the chevron opens the menu.
struct PrimarySplitButton<MenuContent: View>: View {
    let title: String
    let action: () -> Void
    @ViewBuilder let menu: () -> MenuContent
    @State private var hoverMain = false
    @State private var hoverMenu = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: action) {
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .padding(.leading, 9).padding(.trailing, 7)
                    .frame(height: 26)
                    .background(Color.white.opacity(hoverMain ? 0.12 : 0))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hoverMain = $0 }
            Rectangle().fill(Color.white.opacity(0.28)).frame(width: 1, height: 26)
            Menu(content: menu) {
                Image(systemName: "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 20, height: 26)
                    .contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .background(Color.white.opacity(hoverMenu ? 0.12 : 0))
            .onHover { hoverMenu = $0 }
        }
        .foregroundStyle(.white)
        .tint(.white)
        .background(Theme.accentBlue)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .animation(.easeOut(duration: 0.1), value: hoverMain)
        .animation(.easeOut(duration: 0.1), value: hoverMenu)
        .fixedSize()
    }
}

// MARK: - ⌘-click

#if os(macOS)
@MainActor
enum ClickIntent {
    /// The click being handled right now was a ⌘-click (open in a new tab). ⌘⇧ brings the new tab to the front.
    static var newTab: (open: Bool, activate: Bool) {
        guard let e = NSApp.currentEvent else { return (false, false) }
        let mouse: Set<NSEvent.EventType> = [.leftMouseDown, .leftMouseUp, .otherMouseDown]
        guard mouse.contains(e.type) else { return (false, false) }
        if e.type == .otherMouseDown { return (true, false) }          // middle click
        let f = e.modifierFlags
        guard f.contains(.command), !f.contains(.option), !f.contains(.control) else { return (false, false) }
        return (true, f.contains(.shift))
    }
}
#endif
