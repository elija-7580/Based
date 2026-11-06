# Architecture — Based

## Stack

- **Swift 5 mode, SwiftUI multiplatform** app (macOS 14+, iOS 17+). One
  codebase, platform-specific text editing (UITextView/NSTextView, TextKit 1).
- **BasedCore** Swift package: model, store, editing operations, undo, query
  engine, formula engine, Markdown/Notion import & export, search and the
  sync core. Foundation only; compiles and is unit-tested on Linux too.
- **Persistence**: SQLite (system library), one `records` table holding JSON
  payloads per record (block / database / view / workspace), plus `meta`.
  Loaded into an in-memory record cache at launch; writes are synchronous and
  transactional.
- **Ordering**: fractional index keys (`sortKey`) per block, not child arrays.
  Two devices inserting into the same list never lose a block.
- **Versioning**: hybrid logical clock stamp per record; last-writer-wins at
  record granularity on merge.
- **Sync**: `CKSyncEngine` (CloudKit private database, custom zone `Based`).
  One CKRecord per record (`kind`, `payload`, `stamp`). Assets go in separate
  CKRecords with a CKAsset. Needs an Apple Developer team plus an iCloud
  container. Without one, the app runs local-only. The transport is behind a
  protocol, so a self-hosted or any-sync transport can be added later.
- **Project**: XcodeGen (`project.yml`) → `Based.xcodeproj`. Run
  `make project` on a Mac.
- **CI**: GitHub Actions — Linux job runs `swift test` for BasedCore; macOS
  job builds the macOS app and the iOS simulator app. Build errors are written
  to the `ci-logs` branch.

## Modules

```
Packages/BasedCore/Sources/BasedCore
  Model/     ids, stamps (HLC), fractional index, colors, rich text, block,
             database (schema, values, views, filters), workspace, record
  Store/     WorkspaceStore (cache + indexes + transactions + undo/redo +
             observers), editing ops, page ops, database ops, SQLite persistence
  Editing/   Markdown shortcuts, inline Markdown, slash command catalog
  Query/     filter/sort/group/calculations, formula language (lexer, parser,
             evaluator)
  Interop/   Markdown export/import, CSV, Notion export importer
  Search/    full-text search over titles and content
  Sync/      CloudKit sync engine (Apple only)
App/
  Shared/    SwiftUI: app model, sidebar, page, editor, blocks, database
             views, quick find, trash, settings
  macOS/     menus/commands, Info.plist, entitlements
  iOS/       keyboard toolbar, Info.plist, entitlements
```

## Editor model

Each block is its own text view in a vertical stack, like Notion's
per-block editing regions. `EditorController` owns focus, caret, the slash
menu and block selection. Text views report Return, Backspace-at-start,
Tab/Shift-Tab, arrows at the first/last line and typed characters. Every
structural edit is one store transaction, so undo/redo covers both text and
structure. Typing is coalesced into one undo step.

## App layer (SwiftUI)

```
AppModel            @Observable: store, navigation (selection, path, back
                    stack), open modes (full / side peek / center peek),
                    sheets (quick find, trash, move, import/export), sync
                    engine lifecycle, active EditorController
EditorController    per page: focus + caret hand-off between block text views
                    (TextHost protocol), slash & inline menus, block selection,
                    Return/Backspace/Tab/arrow semantics, paste, marks
AttributedBridge    RichText ⇄ NSAttributedString (marks, mentions, equations
                    as custom attribute keys), typing attributes
RichTextView        NSViewRepresentable / UIViewRepresentable around
                    BasedNSTextView / BasedUITextView (TextKit 1, intrinsic
                    height, placeholder, key commands, iOS keyboard toolbar)
BlockViews          one view per BlockType, recursive children, drag handle,
                    block menus; MediaBlocks for image/video/file/pdf/
                    bookmark/embed/equation (WKWebView), SimpleTable
Database/           DatabaseBlockView (tabs/toolbar) → layout views (Table,
                    Board, List, Gallery, Calendar, Timeline) → Cells /
                    PropertyValueEditor; DatabaseSettings for filters, sorts,
                    groups, view and property configuration
RootView            NavigationSplitView: Sidebar (tree, favorites, new,
                    import, trash) · Home · PageScreen · inspector side peek ·
                    sheets (QuickFind, Trash, Settings) · fileImporter/
                    fileExporter · onOpenURL (based://page/<id>)
Theme               colours (dynamic light/dark), fonts per block type,
                    page formats (default/serif/mono, small text)
```

Rules: views never mutate records directly — every change goes through a
`WorkspaceStore` transaction (undoable, observed, persisted, synced). The
store is the single source of truth; SwiftUI observes it via `@Observable`.
Platform code is confined to `RichTextView.swift`, `Theme` typealiases and
`#if os()` blocks in a few views.

## Milestones

1. Core + persistence + tests (Linux) ✅
2. App shell: sidebar, pages, block editor, slash menu, shortcuts ✅ (type-checked)
3. Databases: table/board/list/gallery/calendar, properties, filter/sort/group ✅
4. Sync (CloudKit) + assets ✅ code, ⏳ untested on device
5. Import/export (Notion export, Markdown), search, trash, favorites, backlinks ✅
6. **First Xcode build + fix pass, CI workflow enabled** ⏳
7. Parity backlog: columns drag, synced blocks, page history, comments,
   templates, buttons, timeline/chart/form views, relations/rollups UI, KaTeX,
   share extension, widgets, PDF export
