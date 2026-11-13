// BSD-382 (ADR 0016, E1): Kopieren und Einfügen im neuen Block-Editor. Einfügen nimmt HTML (Notion, Google Docs,
// Web; über den Kern-Importer mit Swift-Fixtures), Markdown, Klartext oder Based-intern (Records mit allem darin,
// auch Datenbanken). Ein Einfügen = eine Transaktion = ein Undo-Schritt.
import type { BlockProps, WireRecord } from "../../model/records.js";
import { makeBlock } from "../../interop/builder.js";
import { ClipboardHTMLImporter, type ImportedBlock } from "../../interop/clipboard.js";
import { MarkdownImporter } from "../../interop/markdown.js";
import { pasteKind } from "../paste.js";
import { copyTree, isPageLike, sortKeys, subtree } from "../../store/pages.js";
import { MemoryPersistence, WorkspaceStore, type Tx } from "../../store/store.js";
import { blockText, clampRange, concatRuns, plainRuns, replaceRuns, runsLength, runsOf, splitRuns, type Run } from "./text.js";
import { isTextBlock, liveChildren, topLevel } from "./tree.js";
import { newBlockID, replaceText, type Focus, type TextRange } from "./blocks.js";

/** Based-intern in der Zwischenablage: die Records der kopierten Blöcke (mit Unterblöcken, eigenen Datenbanken, Ansichten). */
export interface BasedClipboard {
  format: "based/blocks";
  version: 1;
  /** Die kopierten Blöcke oben, in Dokumentreihenfolge. */
  roots: string[];
  records: WireRecord[];
}

/** MIME-Typ für `BasedClipboard` als JSON (neben text/html und text/plain). */
export const BASED_CLIPBOARD_MIME = "application/x-based-blocks";

/** Blöcke für die Zwischenablage (⌘C bei Blockauswahl). Datenbanken in ihrer zusammengesetzten Form (mit Properties). */
export function copyBlocks(store: WorkspaceStore, ids: readonly string[]): BasedClipboard {
  const roots = topLevel(store, ids);
  const records: WireRecord[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    for (const id of [root, ...subtree(store, root)]) {
      if (seen.has(id)) continue;
      seen.add(id);
      const b = store.blocks.get(id);
      if (!b || (id !== root && b.trashedAt !== undefined)) continue;
      records.push({ kind: "block", data: structuredClone(b) });
      const db = b.props?.databaseID ? store.databases.get(b.props.databaseID) : undefined;
      if (db && db.blockID === id) records.push({ kind: "database", data: structuredClone(db) });
      for (const v of store.views.values()) if (v.blockID === id) records.push({ kind: "view", data: structuredClone(v) });
    }
  }
  return { format: "based/blocks", version: 1, roots, records };
}

/** Prüft, ob ein Wert eine Based-Zwischenablage ist (aus JSON der Zwischenablage). */
export function isBasedClipboard(v: unknown): v is BasedClipboard {
  const o = v as BasedClipboard | null;
  return typeof o === "object" && o !== null && o.format === "based/blocks" && o.version === 1 && Array.isArray(o.roots) && Array.isArray(o.records);
}

export interface PasteContent {
  html?: string | undefined;
  text?: string | undefined;
  based?: BasedClipboard | undefined;
  /** „Paste as plain text“ (⇧⌘V). */
  plainOnly?: boolean | undefined;
}

export interface PasteOptions {
  /** Gibt es diese Seite? Notion-/Based-Links auf vorhandene Seiten werden dann zur Erwähnung. */
  pageExists?: (id: string) => boolean;
}

/** Inhalt der Zwischenablage → Parser-Blöcke (ohne IDs). Based-intern wird nicht hier, sondern als Records eingefügt. */
export function parsePaste(content: PasteContent, opts: PasteOptions = {}): ImportedBlock[] {
  const kind = pasteKind({ html: content.html, text: content.text, plainOnly: content.plainOnly });
  if (kind === "html") {
    const exists = opts.pageExists ?? (() => false);
    return new ClipboardHTMLImporter(ClipboardHTMLImporter.pageResolver(exists)).parse(content.html!);
  }
  const text = (content.text ?? "").replaceAll("\r\n", "\n");
  if (kind === "markdown") return new MarkdownImporter({ lenient: true }).parse(text.replace(/^\n+|\s+$/g, ""));
  return text.split("\n").map((line) => ({ type: "text", text: line ? [{ t: line, m: {} }] : [], props: {}, children: [] }));
}

/**
 * Einfügen an der Schreibmarke (`at`, eine Auswahl im Block wird ersetzt).
 *  - Eine Zeile / ein einfacher Absatz: als Text an der Schreibmarke, Formatierung bleibt.
 *  - Mehrere Blöcke: der Block wird an der Schreibmarke geteilt; ein Absatz am Anfang hängt sich an den Text davor,
 *    der Rest hinter der Schreibmarke an den letzten eingefügten Textblock. Ein leerer Textblock wird ersetzt.
 *  - Im Code-Block immer Klartext.
 */
export function insertContent(store: WorkspaceStore, at: TextRange, content: PasteContent, opts: PasteOptions = {}): Focus | undefined {
  const cur = store.blocks.get(at.blockId);
  if (!cur || !isTextBlock(cur)) return undefined;
  if (cur.type === "code") {
    const text = content.text ?? (content.html ? new ClipboardHTMLImporter().parse(content.html).map((b) => b.text.map((r) => r.t).join("")).join("\n") : "");
    return text ? replaceText(store, at, text, { coalesce: null }) : undefined;
  }
  if (content.based && !content.plainOnly && content.based.roots.length > 0) return insertBased(store, at, content.based);
  const blocks = parsePaste(content, opts).filter((b) => b.type !== "text" || b.text.length > 0 || b.children.length > 0 || Object.keys(b.props).length > 0);
  if (blocks.length === 0) return undefined;
  const only = blocks[0]!;
  if (blocks.length === 1 && only.type === "text" && only.children.length === 0 && Object.keys(only.props).length === 0) {
    return replaceText(store, at, only.text, { coalesce: null });
  }
  return store.transact("Paste", (tx) => {
    const { left, right } = cutAt(tx, at);
    const parsed = [...blocks];
    let head = left;
    const first = parsed[0]!;
    const mergeFirst = runsLength(left) > 0 && first.type === "text" && first.children.length === 0 && Object.keys(first.props).length === 0;
    if (mergeFirst) head = concatRuns(left, first.text);
    if (mergeFirst) parsed.shift();
    const ids = parsed.length ? putImported(store, tx, parsed, cur.parent, sortKeys(store, cur.parent, { kind: "after", id: cur.id }, parsed.length)) : [];
    return finish(store, tx, cur.id, head, right, ids);
  });
}

/** Text des Blocks an der Schreibmarke teilen (die Auswahl fällt weg). */
function cutAt(tx: Tx, at: TextRange): { left: Run[]; right: Run[] } {
  const b = tx.block(at.blockId)!;
  const runs = runsOf(b.text);
  const [a, z] = clampRange(runsLength(runs), at.from, at.to);
  const [left, right] = splitRuns(replaceRuns(runs, a, z, ""), a);
  return { left, right };
}

/** Text links in den Block, Rest rechts an den letzten eingefügten Textblock (sonst neuer Block); leeren Textblock ersetzen. */
function finish(store: WorkspaceStore, tx: Tx, curID: string, head: Run[], right: Run[], inserted: string[]): Focus {
  const cur = store.blocks.get(curID)!;
  const write = (id: string, runs: Run[]) => tx.update(id, (x) => {
    const t = blockText(x.type === "code" ? plainRuns(runs) : runs);
    if (t === undefined) delete x.text;
    else x.text = t;
  });
  write(curID, head);
  const lastID = inserted[inserted.length - 1];
  const last = lastID ? store.blocks.get(lastID) : undefined;
  let focus: Focus;
  if (last && isTextBlock(last) && last.type !== "code" && liveChildren(store, last.id).length === 0) {
    const runs = runsOf(last.text);
    write(last.id, concatRuns(runs, right));
    focus = { blockId: last.id, offset: runsLength(runs) };
  } else if (runsLength(right) > 0 || !last) {
    const anchor = last ?? cur;
    const sk = sortKeys(store, anchor.parent, { kind: "after", id: anchor.id }, 1)[0]!;
    const id = newBlockID();
    tx.put({ kind: "block", data: makeBlock({ id, type: cur.type === "code" ? "text" : cur.type, parent: anchor.parent, sk, text: blockText(right), createdBy: store.userID }, store.now()) });
    focus = { blockId: id, offset: 0 };
  } else focus = { blockId: last.id, selected: true };
  // Ein leerer Textblock (ohne Kinder), in den eingefügt wurde, verschwindet: das Eingefügte steht an seiner Stelle.
  if (runsLength(head) === 0 && cur.type === "text" && inserted.length > 0 && liveChildren(store, curID).length === 0) store.deleteBlocksIn(tx, [curID]);
  return focus;
}

/** Parser-Blöcke als Records schreiben (neue IDs); gibt die IDs der obersten zurück. */
function putImported(store: WorkspaceStore, tx: Tx, items: readonly ImportedBlock[], parent: string, keys: readonly string[]): string[] {
  return items.map((item, i) => {
    const props: BlockProps = { ...item.props };
    if (item.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    if (item.type === "code" && props.language === "plain text") delete props.language;
    const id = newBlockID();
    tx.put({ kind: "block", data: makeBlock({ id, type: item.type, parent, sk: keys[i]!, text: blockText(item.type === "code" ? plainRuns(item.text) : item.text), props, createdBy: store.userID }, store.now()) });
    if (item.children.length > 0) putImported(store, tx, item.children, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, item.children.length));
    return id;
  });
}

/** Woher kopiert wird: aus demselben Workspace direkt aus dem Store (aktueller Stand), sonst aus den Records der Zwischenablage. */
function clipboardSource(store: WorkspaceStore, clip: BasedClipboard): { source: WorkspaceStore; local: boolean; roots: string[] } {
  const local = clip.roots.every((id) => store.blocks.has(id));
  let source = store;
  if (!local) {
    const records = clip.records.filter((r) => r.kind !== "workspace");
    // Wurzeln hängen in der Quelle irgendwo; für die Kopie reicht ein gemeinsamer Elternteil.
    source = new WorkspaceStore({ node: "clipboard", persistence: new MemoryPersistence(records), propertyRecords: false, now: () => store.now(), userID: store.userID });
  }
  return { source, local, roots: clip.roots.filter((id) => source.blocks.has(id)) };
}

/**
 * Einfügen, während Blöcke ausgewählt sind (keine Schreibmarke): alles kommt als eigene Blöcke hinter `afterId`.
 * Fokus: der letzte eingefügte Block ist ausgewählt.
 */
export function insertContentAfter(store: WorkspaceStore, afterId: string, content: PasteContent, opts: PasteOptions = {}): Focus | undefined {
  const anchor = store.blocks.get(afterId);
  if (!anchor) return undefined;
  if (content.based && !content.plainOnly && content.based.roots.length > 0) {
    const { source, local, roots } = clipboardSource(store, content.based);
    if (roots.length === 0) return undefined;
    const ids = store.transact("Paste", (tx) => {
      const keys = sortKeys(store, anchor.parent, { kind: "after", id: anchor.id }, roots.length);
      return roots.map((id, i) => copyTree(source, tx, source.blocks.get(id)!, anchor.parent, keys[i]!, local && isPageLike(source.blocks.get(id)) ? " (1)" : undefined));
    });
    return { blockId: ids[ids.length - 1]!, selected: true };
  }
  const blocks = parsePaste(content, opts).filter((b) => b.type !== "text" || b.text.length > 0 || b.children.length > 0 || Object.keys(b.props).length > 0);
  if (blocks.length === 0) return undefined;
  const ids = store.transact("Paste", (tx) => putImported(store, tx, blocks, anchor.parent, sortKeys(store, anchor.parent, { kind: "after", id: anchor.id }, blocks.length)));
  return { blockId: ids[ids.length - 1]!, selected: true };
}

/** Based-intern: Kopien der Records (neue IDs, eigene Datenbanken samt Zeilen) hinter die Schreibmarke. */
function insertBased(store: WorkspaceStore, at: TextRange, clip: BasedClipboard): Focus | undefined {
  const { source, local, roots } = clipboardSource(store, clip);
  if (roots.length === 0) return undefined;
  const cur = store.blocks.get(at.blockId)!;
  return store.transact("Paste", (tx) => {
    const { left, right } = cutAt(tx, at);
    const keys = sortKeys(store, cur.parent, { kind: "after", id: cur.id }, roots.length);
    const ids = roots.map((id, i) => copyTree(source, tx, source.blocks.get(id)!, cur.parent, keys[i]!, local && isPageLike(source.blocks.get(id)) ? " (1)" : undefined));
    return finish(store, tx, cur.id, left, right, ids);
  });
}
