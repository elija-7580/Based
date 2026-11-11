# ADR 0009: Design values come only from central tokens

- **Status:** accepted (2026-11-08, architecture review)
- **Deciders:** Elija, architecture review

## Context

Based copies Notion's look closely for now. After Notion parity it should get a design of its own. Views
currently mix values from `DS` (`legacy/App/Shared/DesignSystem.swift`) and `Theme` (`legacy/App/Shared/Theme.swift`)
with hard-coded colours, paddings, font sizes and radii, which makes a redesign a hunt through hundreds of
views.

## Options

1. Allow literals in views and redesign by search-and-replace later.
2. Introduce a third-party theming system.
3. All design values come exclusively from `DS`/`Theme`.

## Decision

Option 3. Colours, spacing, fonts, corner radii and motion (durations, curves) are read only from
`DS`/`Theme`. Views contain no hard-coded design values. New tokens are added to `DS`/`Theme` when needed.

## Consequences

- A future Based design is a change in one or two files.
- Existing literals are migrated gradually; new code must not add any.
- Reviews and the nightly audit flag literals in views.
