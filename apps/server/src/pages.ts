// Seiten-Operationen für MCP (docs/mcp.md, „Pages and content“): lesen als Markdown, suchen, anlegen, anhängen,
// ersetzen, umbenennen, Papierkorb. Alles über den gemeinsamen Kern (@based/core), sodass jede Änderung als
// lokale Änderung des Servers im Change-Log landet und per Sync v2 bei den Geräten ankommt.
import {
  attachSearchIndex,
  insertPage,
  isPageLike,
  isTrashed,
  keyOf,
  makeBlock,
  makeRecordID,
  MarkdownExporter,
  MarkdownImporter,
  restorePages,
  sortKeys,
  titleOf,
  toRichText,
  trashedPages,
  trashPages,
  type Block,
  type BlockProps,
  type MarkdownBlock,
  type SearchIndex,
  type Tx,
  type WorkspaceStore,
} from "@based/core";

export const PAGE_URI = "based://page/";

/** Fehler, den ein Werkzeug als Antwort (isError) zurückgibt; ohne Nutzerinhalte im Log. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** Swift `BlockType.supportsChildren` wird vom Parser schon beachtet; Tabellen brauchen eine Spaltenzahl. */
function putMarkdownBlocks(store: WorkspaceStore, tx: Tx, items: MarkdownBlock[], parent: string, keys: string[]) {
  items.forEach((item, i) => {
    const props: BlockProps = { ...item.props };
    if (item.type === "table" && props.tableColumns === undefined) props.tableColumns = 2;
    const id = makeRecordID();
    const block = makeBlock({ id, type: item.type, parent, sk: keys[i]!, text: toRichText(item.text), props, createdBy: store.userID }, store.now());
    tx.put({ kind: "block", data: block });
    if (item.children.length > 0) {
      putMarkdownBlocks(store, tx, item.children, "b:" + id, sortKeys(store, "b:" + id, { kind: "end" }, item.children.length));
    }
  });
}

export class Pages {
  private search: { index: SearchIndex; dispose: () => void } | undefined;

  constructor(readonly store: WorkspaceStore) {}

  dispose() {
    this.search?.dispose();
    this.search = undefined;
  }

  private get index(): SearchIndex {
    return (this.search ??= attachSearchIndex(this.store)).index;
  }

  private importer() {
    return new MarkdownImporter({
      // Links auf based://page/<id> oder eine bekannte Seiten-ID werden Erwähnungen.
      resolveLink: (target) => {
        const id = target.startsWith(PAGE_URI) ? target.slice(PAGE_URI.length) : target;
        return isPageLike(this.store.blocks.get(id)) ? id : undefined;
      },
    });
  }

  private exporter() {
    return new MarkdownExporter(this.store, { pageLink: (id) => ({ title: titleOf(this.store, id), url: PAGE_URI + id }) });
  }

  /** Eine Seite (nicht im Papierkorb, außer `allowTrashed`), sonst ToolError. */
  page(id: string, allowTrashed = false): Block {
    const b = this.store.blocks.get(id);
    if (!b || !isPageLike(b)) throw new ToolError(`No page with id ${id}`);
    if (!allowTrashed && isTrashed(this.store, id)) throw new ToolError(`Page ${id} is in the Trash (restore_page brings it back)`);
    return b;
  }

  title(id: string): string {
    return titleOf(this.store, id);
  }

  /** Seite als Markdown, mit Properties, wenn sie eine Datenbankzeile ist. */
  read(id: string): string {
    this.page(id, true);
    const md = this.exporter().export(id);
    return isTrashed(this.store, id) ? `(in the Trash)\n\n${md}` : md;
  }

  /** Titel und Volltext; nur Seiten außerhalb des Papierkorbs. */
  searchPages(query: string, limit = 20): { id: string; title: string; snippet?: string }[] {
    const hits = this.index.search(query, {}, "bestMatch", Math.max(limit * 2, limit));
    const out: { id: string; title: string; snippet?: string }[] = [];
    for (const h of hits) {
      if (!this.store.blocks.has(h.pageID) || isTrashed(this.store, h.pageID)) continue;
      out.push(h.snippet ? { id: h.pageID, title: this.title(h.pageID), snippet: h.snippet } : { id: h.pageID, title: this.title(h.pageID) });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Seiten oben (ohne `parent`) oder Unterseiten einer Seite, in Seitenleisten-Reihenfolge. */
  list(parent?: string): string[] {
    if (parent !== undefined) this.page(parent);
    const key = parent === undefined ? "w" : "b:" + parent;
    return this.store.children(key).filter((id) => {
      const b = this.store.blocks.get(id);
      return isPageLike(b) && b?.trashedAt === undefined;
    });
  }

  /** Neue Seite aus Markdown. Eine führende „# Titel“-Zeile wird der Titel, wenn `title` fehlt. */
  create(opts: { title?: string | undefined; markdown?: string | undefined; parent?: string | undefined }): string {
    if (opts.parent !== undefined) this.page(opts.parent);
    let title = opts.title;
    let body = opts.markdown ?? "";
    if (title === undefined) {
      const split = MarkdownImporter.splitTitle(body);
      title = split.title;
      body = split.body;
    }
    const blocks = this.importer().parse(body);
    return this.store.transact("New page", (tx) => {
      const id = insertPage(this.store, tx, opts.parent ? { parent: opts.parent, ...(title ? { title } : {}) } : title ? { title } : {});
      if (blocks.length > 0) putMarkdownBlocks(this.store, tx, blocks, "b:" + id, sortKeys(this.store, "b:" + id, { kind: "end" }, blocks.length));
      return id;
    });
  }

  /** Markdown-Blöcke ans Ende einer Seite. Gibt die Anzahl neuer Blöcke oberster Ebene zurück. */
  append(id: string, markdown: string): number {
    this.page(id);
    const blocks = this.importer().parse(markdown);
    if (blocks.length === 0) return 0;
    this.store.transact("Append", (tx) => putMarkdownBlocks(this.store, tx, blocks, "b:" + id, sortKeys(this.store, "b:" + id, { kind: "end" }, blocks.length)));
    return blocks.length;
  }

  /** Inhalt ersetzen. Unterseiten und Datenbanken bleiben (nur Inhaltsblöcke werden ersetzt). */
  replaceContent(id: string, markdown: string): { removed: number; added: number } {
    this.page(id);
    const blocks = this.importer().parse(markdown);
    const content = this.store.children("b:" + id).filter((k) => {
      const b = this.store.blocks.get(k);
      return b !== undefined && !isPageLike(b) && b.type !== "databaseInline";
    });
    let removed = 0;
    this.store.transact("Replace content", (tx) => {
      for (const k of content) {
        for (const d of [...this.store.descendants(k).reverse(), k]) {
          tx.remove(keyOf("block", d));
          removed++;
        }
      }
      if (blocks.length > 0) {
        const keys = sortKeys(this.store, "b:" + id, { kind: "end" }, blocks.length);
        putMarkdownBlocks(this.store, tx, blocks, "b:" + id, keys);
      }
    });
    return { removed, added: blocks.length };
  }

  /** Titel, Emoji-Icon (leer = entfernen), Cover entfernen. */
  update(id: string, opts: { title?: string | undefined; icon?: string | undefined; removeCover?: boolean | undefined }) {
    const b = this.page(id);
    const dbID = b.type === "databasePage" ? b.props?.databaseID : undefined;
    const db = dbID ? this.store.databases.get(dbID) : undefined;
    this.store.transact("Update page", (tx) => {
      if (opts.title !== undefined && db) tx.put({ kind: "database", data: { ...structuredClone(db), title: opts.title } });
      tx.update(id, (x) => {
        if (opts.title !== undefined && !db) {
          if (opts.title === "") delete x.text;
          else x.text = opts.title;
        }
        if (opts.icon !== undefined) {
          if (opts.icon === "") {
            if (x.props) delete x.props.icon;
          } else x.props = { ...(x.props ?? {}), icon: opts.icon };
        }
        if (opts.removeCover && x.props) delete x.props.cover;
        if (x.props && Object.keys(x.props).length === 0) delete x.props;
      });
    });
  }

  trash(id: string): boolean {
    this.page(id, true);
    return trashPages(this.store, [id]).length > 0;
  }

  restore(id: string): boolean {
    const b = this.page(id, true);
    if (b.trashedAt === undefined) return false;
    restorePages(this.store, [id]);
    return true;
  }

  trashList(): string[] {
    return trashedPages(this.store).filter(isPageLike).map((b) => b.id);
  }

  /** Alle Seiten außerhalb des Papierkorbs (für die Ressourcenliste). */
  allPages(limit: number): string[] {
    const out: string[] = [];
    for (const b of this.store.blocks.values()) {
      if (out.length >= limit) break;
      if (isPageLike(b) && !isTrashed(this.store, b.id)) out.push(b.id);
    }
    return out;
  }
}
