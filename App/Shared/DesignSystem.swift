import SwiftUI

/// Design tokens: one place for the spacing scale, type ramp, corner radii, control heights and interaction fills,
/// so new UI picks a value from here instead of inventing another 12.5 pt / 0.055 opacity.
/// Colour values live in `Theme` (light/dark pairs); `DS.Color` names their roles for new UI.
/// BSD-68: `scripts/design-audit.py` counts hard-coded values outside these two files,
/// `scripts/design-codemod.py` replaces the ones that equal a token (pixel-identical).
enum DS {
    /// Semantic colour roles (all light/dark aware). A future Based design changes the mapping here.
    enum Color {
        static var text: SwiftUI.Color { Theme.primary }
        static var textMuted: SwiftUI.Color { Theme.secondary }
        static var bg: SwiftUI.Color { SwiftUI.Color(Theme.pageBackgroundColor) }
        static var line: SwiftUI.Color { Theme.dividerColor }
        static var gridLine: SwiftUI.Color { Theme.gridLine }
        static var hover: SwiftUI.Color { Theme.hoverFill }
        static var accent: SwiftUI.Color { Theme.accentBlue }
        static var success: SwiftUI.Color { Theme.color(.green) }
        static var warning: SwiftUI.Color { Theme.color(.orange) }
        static var danger: SwiftUI.Color { Theme.color(.red) }
    }

    /// 4-pt based spacing scale.
    enum Space {
        static let xxs: CGFloat = 2
        static let xs: CGFloat = 4
        static let sm: CGFloat = 6
        static let md: CGFloat = 8
        static let lg: CGFloat = 12
        static let xl: CGFloat = 16
        static let xxl: CGFloat = 24
    }

    /// Corner radii (all drawn with `.continuous`).
    enum Radius {
        static let small: CGFloat = 4     // menu rows, inline highlights
        static let control: CGFloat = 6   // buttons, chips, fields
        static let card: CGFloat = 8      // grouped rows, cards
        static let panel: CGFloat = 12    // popovers, floating panels
    }

    /// Interactive control heights.
    enum Control {
        static let compact: CGFloat = 24
        static let regular: CGFloat = 26
        static let comfortable: CGFloat = 28
        static let large: CGFloat = 32
    }

    /// Type ramp: caption / small / body / ui / title (+ semibold variants through `weight`).
    enum Text {
        static func caption(_ weight: Font.Weight = .regular) -> Font { .system(size: 11, weight: weight) }
        static func small(_ weight: Font.Weight = .regular) -> Font { .system(size: 12, weight: weight) }
        static func body(_ weight: Font.Weight = .regular) -> Font { .system(size: 13, weight: weight) }
        static func ui(_ weight: Font.Weight = .regular) -> Font { .system(size: 14, weight: weight) }
        static func title(_ weight: Font.Weight = .semibold) -> Font { .system(size: 17, weight: weight) }
    }

    /// Fill strength of `Theme.primary` laid over the page for interaction states.
    enum Fill {
        static let rest: Double = 0.045       // quiet container (segmented control track, chip menu)
        static let hover: Double = 0.065
        static let selected: Double = 0.1
        static let pressed: Double = 0.13
    }

    /// Motion — one short, quiet vocabulary for the whole app (Notion / the Claude app feel): things react at
    /// once, nothing bounces, nothing lingers. Use these instead of ad-hoc `.easeOut(duration:)` / springs.
    enum Motion {
        /// Hover fill fading *out* (in is instant — see `hoverFill`).
        static let hover: Double = 0.1
        static let press: Double = 0.06
        /// Hover fills: no delay going in, a short fade going out.
        static let hoverOut = Animation.easeOut(duration: 0.12)
        /// Popovers, menus, toolbars appearing (critically damped: no overshoot).
        static let panel = Animation.spring(response: 0.2, dampingFraction: 1)
        /// Folding (toggles, sidebar tree, sections): the arrow and the content move together.
        static let fold = Animation.spring(response: 0.24, dampingFraction: 0.92)
        /// Blocks moving, being inserted or removed.
        static let reorder = Animation.spring(response: 0.3, dampingFraction: 0.9)
        /// Switching pages / screens.
        static let page = Animation.easeOut(duration: 0.14)
        /// Side / center peek sliding in.
        static let peek = Animation.spring(response: 0.3, dampingFraction: 0.95)
        /// Small state changes (badges, checkmarks, selection washes).
        static let quick = Animation.easeOut(duration: 0.1)

        /// A block appearing in the editor.
        static let blockInsert = AnyTransition.asymmetric(insertion: .opacity.combined(with: .offset(y: -3)), removal: .opacity)
        /// Floating panels (menus, popovers): fade with a hint of scale from the anchor.
        static func panelTransition(from anchor: UnitPoint = .top) -> AnyTransition {
            .opacity.combined(with: .scale(scale: 0.97, anchor: anchor))
        }
        /// Folded content (toggle children, tree rows).
        static let foldTransition = AnyTransition.asymmetric(insertion: .opacity.combined(with: .offset(y: -4)), removal: .opacity)
    }
}
