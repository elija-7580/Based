# Duplicate sidebar entries — root cause (Pass 15)

Reported: "Teamspace Home" appears 5×, "AI Conversation Log" 2× in the Private section after the Notion import.

## 1. "Teamspace Home" ×5 — real, distinct pages from different teamspaces

Checked against the source workspace with the Notion API (Pass 15):

- The workspace has **6 teamspaces**: "Elijá F.-U. HQ" (active) and 5 archived ones
  ("Elijá Samuel Friedrich-Ulrich's Notion HQ", "Johannas", "Lacking" ×2, "NHCS").
- Every teamspace has its **own** "Teamspace Home" page — 6 different page ids
  (`ee5618c1…`, `275618c1…804e…`, `278618c1…8020…`, `278618c1…805a…`, `24b618c1…`, `26f618c1…`).
- The Notion public API reports teamspace top-level pages as `parent: workspace` and does **not** say which
  teamspace they belong to. `NotionCrawler.planSearch` / `NotionAPIMapper` therefore map all of them to
  `ParentRef.workspace`, and Based had no teamspace concept, so they all landed in "Private" side by side.

So this is not a rendering bug and not a store bug: the records are different pages with the same title.
Nothing was deleted or merged.

**Fix (cause, not symptom):**
- Data model: `Workspace.teamspaces: [Teamspace]?` and `BlockProps.teamspace: RecordID?` (top-level pages
  only; `nil` = Private). Both optional → old workspaces decode unchanged, no migration.
- Sidebar has a *Teamspaces* section; pages can be dragged onto a teamspace or moved with *Move to…*.
- Look-alike top-level rows get a tooltip with section + creation date; the Library has a **Same title**
  filter (`duplicateTitleReport()`) that lists each group with its cause, so they can be sorted into
  teamspaces or deleted *by the user*.
- Not done (API limitation): automatically assigning imported pages to teamspaces. The public API exposes
  no teamspace id for pages; this needs either the user's manual assignment or a future API field.

## 2. "AI Conversation Log" ×2 — could not be reproduced from the source

A title search in the Notion workspace (including archived pages) returned no page with that title, so the
original records could not be inspected. Code paths that can produce two rows with one title:

1. **Favorite + tree** — a favorite page is shown in *Favorites* and again in its tree (same as Notion).
   Before Pass 15 both rows used the bare page id as their SwiftUI identity inside one `LazyVStack`, and they
   shared expansion state. Now rows are scoped (`fav:` + id), so the two rows are independent.
2. **Importer placeholder for an unreadable / linked database** — `NotionAPIMapper.mapContainer` creates a
   🗃️ page with the database's title when the integration can't read the database; if the real database is
   imported too, both appear. The Library's *Same title* report labels this case `unreadableDatabase`.
3. **Plain copies** (Duplicate / re-imported page under a new id) → reported as `copies` (same content
   fingerprint) or `distinctPages`.

Ruled out: the store's child index listing one record twice — `_setBlock` removes before inserting, a test
re-imports the same pages without duplicates, and `childIndexDuplicates()` reports any such case (reported
as `listedTwice`). `topLevelPages()` additionally de-duplicates by id.

**Next step for the user:** open Library → *Same title* on the Mac; the cause column says which of the cases
above applies to the two "AI Conversation Log" rows.
