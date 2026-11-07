import SwiftUI

// Shared building blocks for the database popovers (view settings, filter, sort, property menus), so they all
// share one header, spacing, corner radius, hover behaviour and type ramp instead of ad-hoc flat columns.

/// Popover chrome: an accent icon + title header, a hairline, then the content.
struct PopoverPanel<Content: View>: View {
    let title: String
    let symbol: String
    var minWidth: CGFloat = 340
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.accentBlue)
                    .frame(width: 24, height: 24)
                    .background(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous).fill(Theme.accentBlue.opacity(0.12)))
                Text(title)
                    .font(DS.Text.ui(.semibold))
                    .foregroundStyle(Theme.primary)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, DS.Space.xl - 2)
            .padding(.vertical, DS.Space.lg - 2)
            Rectangle().fill(Theme.gridLine).frame(height: 1)
            content()
        }
        .frame(minWidth: minWidth)
        .arrowlessPopover()
    }
}

/// Value pill for menus inside popovers: label + up/down chevrons on a soft fill (reads as a control, not as text).
struct ChipMenuLabel: View {
    let text: String
    var symbol: String? = nil
    var emphasized = true

    var body: some View {
        HStack(spacing: 5) {
            if let symbol {
                Image(systemName: symbol).font(.system(size: 11)).foregroundStyle(Theme.secondary)
            }
            Text(text)
                .font(DS.Text.body(emphasized ? .medium : .regular))
                .foregroundStyle(emphasized ? Theme.primary : Theme.secondary)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.system(size: 8, weight: .semibold))
                .foregroundStyle(Theme.secondary)
        }
        .padding(.horizontal, DS.Space.md)
        .frame(height: DS.Control.regular)
        .background(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous).fill(Theme.primary.opacity(DS.Fill.hover)))
        .contentShape(RoundedRectangle(cornerRadius: DS.Radius.control, style: .continuous))
    }
}

/// Full-width action row with a leading icon; highlights on hover and press.
struct PopoverActionRow: View {
    let title: String
    let symbol: String
    var destructive = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .font(DS.Text.body())
                .foregroundStyle(destructive ? Color.red : Theme.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(MenuRowStyle())
    }
}

/// "+ Add …" menu styled as an accent action (not a bare blue word).
struct PopoverAddMenu<Content: View>: View {
    let title: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        Menu {
            content()
        } label: {
            Label(title, systemImage: "plus")
                .font(DS.Text.body(.medium))
                .foregroundStyle(Theme.accentBlue)
                .padding(.horizontal, DS.Space.md)
                .frame(height: DS.Control.regular)
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .fixedSize()
        .hoverHighlight(cornerRadius: DS.Radius.control, opacity: DS.Fill.hover)
    }
}
