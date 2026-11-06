# Based

Native, local-first notes for **macOS and iPhone**: pages, a block editor and
databases, synced through your own iCloud. It's modeled on Notion's
note-taking features and built clean-room from public documentation.

> Prototype. 107 of 149 tracked Notion features are implemented, 25 partially;
> see [`replica/features.csv`](replica/features.csv) for the parity matrix and
> [`replica/build-log.md`](replica/build-log.md) for progress.
> The core package is unit-tested on Linux. The SwiftUI app has been
> type-checked against API stubs only — the first Xcode build may still need
> small fixes (see *Status* below).

## What works

- **Pages**: tree in sidebar, drag & drop, icons (emoji/image), covers, fonts,
  small text, full width, lock, duplicate, move, favorites, trash with restore,
  backlinks, deep links (`based://page/<id>`), Quick Find (⌘P), Home.
- **Block editor**: every Notion block type except tabs — text, headings 1–4,
  lists, to-dos, toggles & toggle headings, quote, callout, divider, code,
  equation, image/video/audio/file/PDF, bookmark, embed, TOC, breadcrumb,
  columns, simple table, synced block, button, link to page, child page.
  Slash menu, Markdown shortcuts, inline Markdown, @-mentions (pages, dates),
  ⌘K links, colours, turn into, drag handle, block menu, multi-select,
  ⌘⇧↑↓, ⌘D, ⌘⌥0–9, undo/redo, paste Markdown/URLs, copy as Markdown,
  emoji picker, word count.
- **Databases**: inline, full-page and linked views; table, board, list,
  gallery, calendar, timeline; filters (and/or groups), multi-sort, group by,
  hidden groups, calculations, per-view property visibility/order, templates,
  side peek / center peek / full page. All property types incl. status, date
  ranges, relation (two-way), rollup, formula (Formula 2.0 subset), unique ID,
  files, number formats, type conversion.
- **Sync**: CloudKit `CKSyncEngine` (private DB), offline-first, HLC
  last-writer-wins per record, fractional-index ordering, assets as CKAssets.
- **Import / export**: Notion export (Markdown + CSV, with relations and
  nested pages), Markdown files; export page as Markdown, database as CSV.
- **App**: light/dark/system (⇧⌘L), settings, iPhone keyboard toolbar and
  long-press menus, iPad runs (layout not tuned).

Not implemented: comments, sharing/publishing, page history, real-time
multi-user, chart/form/feed/map views, sub-items, HTML/PDF export, find in
page, share extension, widgets, AI.

## Repository layout

- `Packages/BasedCore` — model, store, editing, databases, formulas,
  import/export, search, sync core (Swift package; Foundation only, tested on
  Linux and macOS)
- `App/Shared` — SwiftUI app shared by macOS and iOS; `App/macOS`, `App/iOS`
  — Info.plist and entitlements
- `project.yml` — XcodeGen project; `Config/` — build settings
- `ci/github-actions-ci.yml` — CI template (copy to `.github/workflows/ci.yml`)
- `replica/` — recon, architecture, parity matrix, build log

## Build

Core (any platform with Swift 5.9+/6):

```bash
make test        # = swift test --package-path Packages/BasedCore
```

Apps (macOS 14+ / iOS 17+, Xcode 16+, `brew install xcodegen`):

```bash
make project     # generates Based.xcodeproj (and app icons via Pillow)
make mac         # or: open Based.xcodeproj and run the Based-macOS / Based-iOS scheme
make ios
```

### iCloud sync

Without an Apple Developer team the app runs local-only. To enable sync:

1. `cp Config/Local.xcconfig.example Config/Local.xcconfig` and fill in
   `DEVELOPMENT_TEAM`, `BASED_BUNDLE_ID`, `BASED_CLOUDKIT_CONTAINER`
   (`iCloud.<bundle id>`), keep `BASED_CLOUD_SYNC = YES` and
   `BASED_ENTITLEMENTS_SUFFIX = -iCloud`.
2. Create the iCloud container in the Developer portal; the schema is created
   on first sync in the development environment (deploy to production before
   shipping).
3. `make project`, run on both devices with the same Apple ID.

### Importing from Notion

Settings → Workspace → Export → *Markdown & CSV*, include subpages, unzip the
archive, then **File → Import…** (⌘⇧I) in Based and pick the unzipped folder.

## Status

The app has not yet been compiled with Apple's toolchain in this repository
(the agent sandbox is Linux). `App/Shared` type-checks against SwiftUI API
stubs; `App/Shared/Editor/RichTextView.swift` (AppKit/UIKit text views) was
reviewed but not compiled. Expect a handful of fixes on the first Xcode run.
Copy `ci/github-actions-ci.yml` to `.github/workflows/ci.yml` to get macOS +
iOS simulator builds on every push; failures are written to the `ci-logs`
branch so they can be fixed iteratively.

## License

MIT. Clean-room implementation from public Notion help docs; no Notion code or
assets were used.
