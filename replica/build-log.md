# Build log — Based

- 2026-11-05 · Recon and architecture written; Anytype evaluated (not
  forked, ASAL license + iOS-only client); REA not used against Notion
  (MSA §2.1). Core package scaffolded.
- Pass 2 · BasedCore complete: fractional index, HLC, rich text + marks +
  mentions, blocks, databases (schema, views, filters, sorts, groups,
  calculations), formula lexer/parser/evaluator, query engine, SQLite
  persistence, undo/redo transactions, Markdown/CSV/Notion import-export,
  search, CKSyncEngine transport. 27 tests green on Linux.
- Pass 3 · App layer: AppModel, Theme, EditorController (focus, caret,
  slash/inline menus, selection, keyboard), AttributedBridge, platform text
  views (NSTextView/UITextView, TextKit 1), block views for every block type,
  media blocks (WKWebView embeds, MathJax equations), block menus, pickers
  (icon/cover/page), simple table.
- Pass 4 · Databases UI: table (resize, calculations, groups), board (drag
  between groups), list, gallery, calendar (drag reschedule), timeline;
  filter/sort/group editors, view settings, property config incl. formula
  validation + preview, relation/rollup, cells & editors for all types,
  templates, side/center peek.
- Pass 5 · Shell: sidebar tree (drag & drop, context menus), Home, Quick Find,
  Trash, Settings (sync status, appearance), Notion-export importer with
  security-scoped folders, Markdown/CSV exporters, `based://` URL scheme,
  appearance system/light/dark (⇧⌘L).
- Verification: core `swift test` on Linux; App/Shared type-checked with a
  SwiftUI stub harness (`/data/stubcheck`, not in repo) — zero errors.
  RichTextView.swift reviewed by hand (AppKit/UIKit API signatures checked)
  but never compiled. **First real Xcode build is the next milestone.**
- Pass 6 · Back/forward history (⌘[ ⌘], Mac toolbar buttons).
- Parity: 108 yes / 24 partial / 15 no / 2 skip of 149 tracked features.
- Not done: open-source inspiration (AppFlowy AGPL, AFFiNE MIT, Anytype
  ASAL) was evaluated for architecture only; no code copied (license mix and
  Rust/TS → Swift gap).
