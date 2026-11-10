// BSD-163: das „Agent Brain“ als echte Based-Datenbanken im Workspace (wie Swift `BrainStore`): eine Seite
// „Agent Brain“ mit „About me“, der Datenbank „Memories“ (Type: Profile/Preference/Work/People/Notes) und „Skills“
// (Description, Enabled, Frontmatter; Rumpf = SKILL.md-Anweisungen, weitere Dateien = Unterseiten mit einem
// Codeblock). Synct wie alles andere. Die Teile sind gegen Löschen geschützt („Agent Brain can't be deleted“):
// `protectedIDs` für Papierkorb/Endgültig-Löschen und `repair()`, das Weggeräumtes zurückholt.
//
// Angelegt wird erst bei Bedarf (erste Skill, erste Memory, Einstellungen öffnen) – ein leerer Workspace bekommt
// nicht ungefragt eine Seite. Ein aus der Mac-App gesyncter Brain (Titel „Agent Brain“ mit „Memories“/„Skills“)
// wird übernommen.
import {
  addOption, addProperty, addRow, createDatabase, insertPage, isTrashed, keyOf, makeBlock, makeRecordID, MarkdownExporter, MarkdownImporter,
  plainText, restorePages, setValue, sortKeys, titleOf, toRichText,
  type Block, type BlockProps, type MarkdownBlock, type PropertyValue, type Tx, type WorkspaceStore,
} from "@based/core";
import { decodeSkill, encodeSkill, isTextData, skillFileLanguage, type SkillDocument, type SkillFolder } from "../skills/codec.js";
import { MEMORY_KINDS, similarTitles, type MemoryKind, type MemoryRecord } from "../memory/suggestions.js";

export const BRAIN_TITLE = "Agent Brain";
const BASE64_LANGUAGE = "base64";
type Role = "root" | "about" | "memories" | "skills";

export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  body: string;
  extraFrontmatter: string;
}

export interface SkillImportResult {
  id: string;
  name: string;
  created: boolean;
  files: number;
}

export interface BrainIDs {
  root: string;
  about: string;
  memoriesDB: string;
  skillsDB: string;
}

/** Store-weiter Schutz: IDs, die Papierkorb und „Endgültig löschen“ überspringen (siehe `guardedTrash`). */
const PROTECTED = new WeakMap<WorkspaceStore, Set<string>>();
export function protectedIDs(store: WorkspaceStore): Set<string> {
  let s = PROTECTED.get(store);
  if (!s) PROTECTED.set(store, (s = new Set()));
  return s;
}

/** Was von `ids` gelöscht werden darf (geschützte Teile und ihre Vorfahren bleiben). */
export function deletableIDs(store: WorkspaceStore, ids: readonly string[]): { allowed: string[]; refused: string[] } {
  const prot = protectedIDs(store);
  const allowed: string[] = [], refused: string[] = [];
  for (const id of ids) {
    let hit = prot.has(id);
    // Eine Seite, die einen geschützten Teil enthält, darf auch nicht weg.
    if (!hit) for (const p of prot) if (isInside(store, p, id)) { hit = true; break; }
    (hit ? refused : allowed).push(id);
  }
  return { allowed, refused };
}

function isInside(store: WorkspaceStore, id: string, ancestor: string): boolean {
  let cur = store.blocks.get(id);
  for (let i = 0; cur && i < 200; i++) {
    const p = cur.parent;
    if (!p.startsWith("b:")) return false;
    const pid = p.slice(2);
    if (pid === ancestor) return true;
    cur = store.blocks.get(pid);
  }
  return false;
}

const brainRole = (b: Block | undefined): Role | undefined => (b?.props as { brain?: Role } | undefined)?.brain;

export class AgentBrain {
  private idsCache: BrainIDs | undefined;
  /** Zuletzt gefundene IDs (auch wenn ein Teil inzwischen fehlt) – zum Wiederanhängen einer Datenbank. */
  private known: BrainIDs | undefined;

  constructor(readonly store: WorkspaceStore) {}

  // MARK: Finden, anlegen, schützen

  /** Vorhandenen Brain finden (Markierung, sonst Titel wie in der Mac-App). */
  find(): BrainIDs | undefined {
    const c = this.idsCache;
    const hosted = (db: string) => {
      const host = this.store.databases.get(db)?.blockID;
      return host !== undefined && this.store.blocks.has(host);
    };
    if (c && this.store.blocks.has(c.root) && hosted(c.memoriesDB) && hosted(c.skillsDB) && this.store.blocks.has(c.about)) return c;
    this.idsCache = undefined;
    const tops = this.store.children("w").map((id) => this.store.blocks.get(id)).filter((b): b is Block => b?.type === "page");
    const root = tops.find((b) => brainRole(b) === "root") ?? tops.find((b) => plainText(b.text) === BRAIN_TITLE && this.partsOf(b.id).memoriesDB);
    if (!root) return undefined;
    const parts = this.partsOf(root.id);
    if (!parts.memoriesDB || !parts.skillsDB || !parts.about) return undefined;
    this.idsCache = { root: root.id, about: parts.about, memoriesDB: parts.memoriesDB, skillsDB: parts.skillsDB };
    this.known = this.idsCache;
    return this.idsCache;
  }

  private partsOf(root: string): Partial<BrainIDs> {
    const out: Partial<BrainIDs> = {};
    for (const id of this.store.children("b:" + root)) {
      const b = this.store.blocks.get(id);
      if (!b) continue;
      const role = brainRole(b);
      const dbID = b.props?.databaseID;
      const db = dbID ? this.store.databases.get(dbID) : undefined;
      if (db && (b.type === "databaseInline" || b.type === "databasePage")) {
        const t = plainText(db.title);
        if ((role === "memories" || (!role && t === "Memories")) && !out.memoriesDB) out.memoriesDB = db.id;
        if ((role === "skills" || (!role && t === "Skills")) && !out.skillsDB) out.skillsDB = db.id;
      } else if (b.type === "page" && (role === "about" || plainText(b.text) === "About me") && !out.about) out.about = b.id;
    }
    return out;
  }

  get exists(): boolean {
    return this.find() !== undefined;
  }

  /** Brain anlegen bzw. fehlende Teile ergänzen, Schutz setzen. */
  ensure(): BrainIDs {
    const found = this.find();
    if (found) {
      this.protect();
      return found;
    }
    const s = this.store;
    let root = s.children("w").map((id) => s.blocks.get(id)).find((b) => b?.type === "page" && (brainRole(b) === "root" || plainText(b.text) === BRAIN_TITLE))?.id;
    if (!root) {
      root = s.transact("Create Agent Brain", (tx) => {
        const id = insertPage(s, tx, { title: BRAIN_TITLE });
        tx.update(id, (b) => { b.props = { ...(b.props ?? {}), icon: "🧠", brain: "root" } as BlockProps; });
        return id;
      });
    }
    const parts = this.partsOf(root);
    if (!parts.about) {
      const about = s.transact("Create Agent Brain", (tx) => {
        const first = s.children("b:" + root)[0];
        const id = insertPage(s, tx, { parent: root, title: "About me", position: first ? { kind: "before", id: first } : { kind: "end" } });
        tx.update(id, (b) => { b.props = { ...(b.props ?? {}), icon: "👤", brain: "about" } as BlockProps; });
        this.putMarkdown(tx, id, "## Role\n\n## Current work\n\n## Working preferences\n");
        return id;
      });
      parts.about = about;
    }
    if (!parts.memoriesDB) parts.memoriesDB = this.makeDB(root, "Memories", "memories");
    if (!parts.skillsDB) parts.skillsDB = this.makeDB(root, "Skills", "skills");
    this.idsCache = { root, about: parts.about, memoriesDB: parts.memoriesDB, skillsDB: parts.skillsDB };
    this.known = this.idsCache;
    this.protect();
    return this.idsCache;
  }

  private makeDB(root: string, title: string, role: Role): string {
    const s = this.store;
    const made = createDatabase(s, { parent: "b:" + root, title, inline: true, sampleRows: 0 });
    s.transact("Create Agent Brain", (tx) => tx.update(made.blockID, (b) => { b.props = { ...(b.props ?? {}), brain: role } as BlockProps; }), { undoable: false });
    // Die Standard-Spalte „Tags“ braucht der Brain nicht.
    const tags = s.databases.get(made.databaseID)?.properties.find((p) => p.name === "Tags");
    if (tags) s.transact("Create Agent Brain", (tx) => {
      const db = structuredClone(s.databases.get(made.databaseID)!);
      db.properties = db.properties.filter((p) => p.id !== tags.id);
      tx.put({ kind: "database", data: db });
    }, { undoable: false });
    if (role === "memories") {
      const pid = addProperty(s, made.databaseID, "Type", "select");
      if (pid) for (const k of MEMORY_KINDS) addOption(s, made.databaseID, pid, k);
    } else {
      addProperty(s, made.databaseID, "Description", "text");
      addProperty(s, made.databaseID, "Enabled", "checkbox");
      addProperty(s, made.databaseID, "Frontmatter", "text");
    }
    return made.databaseID;
  }

  /** Seiten des Brains, die nicht gelöscht werden dürfen (Seite, About me, die Blöcke der Datenbanken). */
  coreIDs(): string[] {
    const ids = this.find();
    if (!ids) return [];
    const out = [ids.root, ids.about];
    for (const db of [ids.memoriesDB, ids.skillsDB]) {
      const host = this.store.databases.get(db)?.blockID;
      if (host) out.push(host);
    }
    return out;
  }

  protect() {
    const p = protectedIDs(this.store);
    for (const id of this.coreIDs()) p.add(id);
  }

  /**
   * Holt weggeräumte Teile zurück (Papierkorb – aus einer älteren Version, einem anderen Gerät oder über Sync)
   * und legt eine fehlende Datenbank neu an. `true`, wenn etwas repariert wurde.
   */
  repair(): boolean {
    const rehosted = this.rehost();
    const before = this.find();
    if (!before) {
      // Gab es ihn je? Dann ist ein Teil weg (z. B. die Datenbank per Editor gelöscht) → ergänzen.
      const root = this.store.children("w").map((id) => this.store.blocks.get(id)).find((b) => brainRole(b) === "root");
      if (!root) return false;
      this.ensure();
      return true;
    }
    this.protect();
    const trashed = this.coreIDs().filter((id) => this.store.blocks.get(id)?.trashedAt !== undefined);
    if (trashed.length > 0) {
      restorePages(this.store, trashed);
      return true;
    }
    if (rehosted) return true;
    if (isTrashed(this.store, before.root)) {
      // In eine Seite verschoben, die im Papierkorb liegt → zurück nach oben.
      this.store.transact("Restore Agent Brain", (tx) => {
        const [sk] = sortKeys(this.store, "w", { kind: "end" }, 1);
        tx.update(before.root, (b) => { b.parent = "w"; b.sk = sk!; });
      });
      return true;
    }
    return false;
  }

  /**
   * Der Block einer Brain-Datenbank wurde im Editor gelöscht, die Datenbank (mit allen Zeilen) gibt es noch:
   * den Block mit derselben ID wieder in die Brain-Seite hängen, statt eine leere Datenbank anzulegen.
   */
  private rehost(): boolean {
    const k = this.known;
    if (!k || !this.store.blocks.has(k.root)) return false;
    let fixed = false;
    for (const [db, role] of [[k.memoriesDB, "memories"], [k.skillsDB, "skills"]] as const) {
      const d = this.store.databases.get(db);
      if (!d?.blockID || this.store.blocks.has(d.blockID)) continue;
      const views = [...this.store.views.values()].filter((v) => v.blockID === d.blockID).map((v) => v.id);
      this.store.transact("Restore Agent Brain", (tx) => {
        const [sk] = sortKeys(this.store, "b:" + k.root, { kind: "end" }, 1);
        tx.put({ kind: "block", data: makeBlock({ id: d.blockID!, type: "databaseInline", parent: "b:" + k.root, sk: sk!, props: { databaseID: db, viewIDs: views, brain: role } as BlockProps, createdBy: this.store.userID }, this.store.now()) });
      }, { undoable: false });
      fixed = true;
    }
    return fixed;
  }

  // MARK: Helfer

  private propID(db: string, name: string): string | undefined {
    const d = this.store.databases.get(db);
    return (d?.properties.find((p) => p.name === name) ?? d?.properties.find((p) => p.name.toLowerCase() === name.toLowerCase()))?.id;
  }

  private text(row: Block, db: string, name: string): string {
    const pid = this.propID(db, name);
    const v = pid ? (row.values?.[pid] as { text?: { _0: Block["text"] } } | undefined) : undefined;
    return v?.text ? plainText(v.text._0) : "";
  }

  private bool(row: Block, db: string, name: string, fallback: boolean): boolean {
    const pid = this.propID(db, name);
    const v = pid ? (row.values?.[pid] as { checkbox?: { _0: boolean } } | undefined) : undefined;
    return v?.checkbox ? v.checkbox._0 : fallback;
  }

  private rows(db: string): Block[] {
    return this.store.children("d:" + db).map((id) => this.store.blocks.get(id)).filter((b): b is Block => !!b && b.trashedAt === undefined && b.props?.isTemplate !== true);
  }

  private contentBlocks(id: string, pages: boolean): Block[] {
    return this.store.children("b:" + id).map((k) => this.store.blocks.get(k)).filter((b): b is Block => !!b && b.trashedAt === undefined && (pages ? b.type === "page" : b.type !== "page"));
  }

  /** Inhalt einer Seite als Markdown (ohne Unterseiten und Property-Zeilen). */
  body(id: string): string {
    return new MarkdownExporter(this.store).exportBlocks(this.contentBlocks(id, false), 0).replace(/^\n+|\n+$/g, "");
  }

  private putMarkdown(tx: Tx, parent: string, md: string, position: "start" | "end" = "end") {
    const items = new MarkdownImporter().parse(md);
    if (items.length === 0) return;
    const put = (list: MarkdownBlock[], p: string, keys: string[]) => list.forEach((item, i) => {
      const id = makeRecordID();
      tx.put({ kind: "block", data: makeBlock({ id, type: item.type, parent: p, sk: keys[i]!, text: toRichText(item.text), props: { ...item.props }, createdBy: this.store.userID }, this.store.now()) });
      if (item.children.length > 0) put(item.children, "b:" + id, sortKeys(this.store, "b:" + id, { kind: "end" }, item.children.length));
    });
    const first = position === "start" ? this.store.children("b:" + parent)[0] : undefined;
    put(items, "b:" + parent, sortKeys(this.store, "b:" + parent, first ? { kind: "before", id: first } : { kind: "end" }, items.length));
  }

  /** Rumpf ersetzen (Unterseiten bleiben) – eine Transaktion. */
  private setBody(id: string, md: string, name: string) {
    const old = this.contentBlocks(id, false);
    this.store.transact(name, (tx) => {
      for (const b of old) for (const d of [...this.store.descendants(b.id).reverse(), b.id]) tx.remove(keyOf("block", d));
      this.putMarkdown(tx, id, md, "start");
    });
  }

  // MARK: Skills

  skills(enabledOnly = false): SkillRecord[] {
    const ids = this.find();
    if (!ids) return [];
    const db = ids.skillsDB;
    return this.rows(db).map((row) => ({
      id: row.id, name: titleOf(this.store, row.id), description: this.text(row, db, "Description"), enabled: this.bool(row, db, "Enabled", true),
      body: this.body(row.id), extraFrontmatter: this.text(row, db, "Frontmatter"),
    })).filter((s) => !enabledOnly || s.enabled).sort((a, b) => a.name.localeCompare(b.name));
  }

  skill(id: string): SkillRecord | undefined {
    return this.skills().find((s) => s.id === id);
  }

  skillByName(name: string): SkillRecord | undefined {
    const n = name.trim().toLowerCase();
    return this.skills().find((s) => s.name.toLowerCase() === n);
  }

  /** Skill anlegen oder (gleicher Name) aktualisieren. */
  saveSkill(doc: { name: string; description: string; body: string; extraFrontmatter?: string; enabled?: boolean }): { id: string; created: boolean } {
    const ids = this.ensure();
    const db = ids.skillsDB;
    const existing = this.skillByName(doc.name);
    const id = existing?.id ?? addRow(this.store, db, { title: doc.name, values: this.check(db, "Enabled", true) })!;
    const set = (name: string, v: PropertyValue | null) => {
      const pid = this.propID(db, name);
      if (pid) setValue(this.store, id, pid, v);
    };
    set("Description", { text: { _0: doc.description } } as PropertyValue);
    if (doc.extraFrontmatter !== undefined) set("Frontmatter", doc.extraFrontmatter ? ({ text: { _0: doc.extraFrontmatter } } as PropertyValue) : null);
    if (doc.enabled !== undefined) set("Enabled", { checkbox: { _0: doc.enabled } } as PropertyValue);
    this.setBody(id, doc.body, existing ? "Update skill" : "New skill");
    return { id, created: !existing };
  }

  private check(db: string, name: string, on: boolean): Record<string, PropertyValue> {
    const pid = this.propID(db, name);
    return pid ? { [pid]: { checkbox: { _0: on } } as PropertyValue } : {};
  }

  setSkillEnabled(id: string, enabled: boolean) {
    const ids = this.find();
    const pid = ids && this.propID(ids.skillsDB, "Enabled");
    if (pid) setValue(this.store, id, pid, { checkbox: { _0: enabled } } as PropertyValue);
  }

  /** Skill aus einem Agent-Skills-Ordner: weitere Dateien werden Unterseiten mit einem Codeblock. */
  importSkill(folder: SkillFolder): SkillImportResult {
    const doc = decodeSkill(folder);
    const { id, created } = this.saveSkill({ name: doc.name, description: doc.description, body: doc.body, extraFrontmatter: doc.extraFrontmatter });
    const pages = new Map(this.contentBlocks(id, true).map((b) => [plainText(b.text), b.id] as const));
    for (const path of Object.keys(doc.files).sort()) {
      const data = doc.files[path]!;
      const text = isTextData(data) ? new TextDecoder().decode(data) : base64(data);
      const language = isTextData(data) ? skillFileLanguage(path) : BASE64_LANGUAGE;
      const s = this.store;
      s.transact("Import skill file", (tx) => {
        let page = pages.get(path);
        if (page) for (const k of s.children("b:" + page)) for (const d of [...s.descendants(k).reverse(), k]) tx.remove(keyOf("block", d));
        else page = insertPage(s, tx, { parent: id, title: path });
        const [sk] = sortKeys(s, "b:" + page, { kind: "end" }, 1);
        tx.put({ kind: "block", data: makeBlock({ id: makeRecordID(), type: "code", parent: "b:" + page, sk: sk!, text, props: { language }, createdBy: s.userID }, s.now()) });
      });
    }
    return { id, name: doc.name, created, files: Object.keys(doc.files).length };
  }

  /** Die Skill als Agent-Skills-Ordner (SKILL.md + Dateien aus den Unterseiten). */
  exportSkill(id: string): SkillFolder | undefined {
    const sk = this.skill(id);
    if (!sk) return undefined;
    const files: Record<string, Uint8Array> = {};
    for (const page of this.contentBlocks(id, true)) {
      const title = plainText(page.text).trim() || "Untitled";
      const blocks = this.contentBlocks(page.id, false);
      const only = blocks.length === 1 && blocks[0]!.type === "code" ? blocks[0]! : undefined;
      if (only) {
        const text = plainText(only.text);
        files[title] = only.props?.language === BASE64_LANGUAGE ? unbase64(text) : new TextEncoder().encode(text);
      } else {
        const name = /\.[A-Za-z0-9]+$/.test(title) ? title : title + ".md";
        files[name.replace(/[\\:]/g, "-")] = new TextEncoder().encode(this.body(page.id) + "\n");
      }
    }
    const doc: SkillDocument = { name: sk.name, description: sk.description, body: sk.body, extraFrontmatter: sk.extraFrontmatter, files };
    return encodeSkill(doc);
  }

  // MARK: Memories

  memories(): MemoryRecord[] {
    const ids = this.find();
    if (!ids) return [];
    const db = ids.memoriesDB;
    const typeID = this.propID(db, "Type");
    const schema = this.store.databases.get(db)?.properties.find((p) => p.id === typeID);
    return this.rows(db).map((row) => {
      let kind: MemoryKind = "Notes";
      const v = typeID ? (row.values?.[typeID] as { select?: { _0: string } } | undefined) : undefined;
      const name = v?.select ? schema?.options?.find((o) => o.id === v.select!._0)?.name : undefined;
      if (name && (MEMORY_KINDS as readonly string[]).includes(name)) kind = name as MemoryKind;
      return { id: row.id, title: titleOf(this.store, row.id), kind, body: this.body(row.id), updatedAt: row.updatedAt };
    }).sort((a, b) => b.updatedAt - a.updatedAt).map(({ updatedAt: _u, ...m }) => m);
  }

  /** Memory speichern – NUR nach Bestätigung des Nutzers aufrufen. Ähnlicher Titel → an diese Memory anhängen. */
  saveMemory(m: { title: string; kind: MemoryKind; body: string; updates?: string | undefined }): string {
    const ids = this.ensure();
    const db = ids.memoriesDB;
    const existing = (m.updates && this.memories().find((x) => x.id === m.updates)) || this.memories().find((x) => similarTitles(x.title, m.title));
    if (existing) {
      this.store.transact("Update memory", (tx) => this.putMarkdown(tx, existing.id, m.body));
      return existing.id;
    }
    const values: Record<string, PropertyValue> = {};
    const pid = this.propID(db, "Type");
    if (pid) {
      const opt = this.store.databases.get(db)?.properties.find((p) => p.id === pid)?.options?.find((o) => o.name === m.kind)?.id ?? addOption(this.store, db, pid, m.kind);
      if (opt) values[pid] = { select: { _0: opt } } as PropertyValue;
    }
    const id = addRow(this.store, db, { title: m.title, values })!;
    this.store.transact("New memory", (tx) => this.putMarkdown(tx, id, m.body));
    return id;
  }

  about(): string {
    const ids = this.find();
    return ids ? this.body(ids.about) : "";
  }

  /** Namen bekannter Personen (Memories vom Typ People) – für Privacy-Redact. */
  personNames(): string[] {
    return this.memories().filter((m) => m.kind === "People").map((m) => m.title.trim()).filter((t) => t.length >= 3 && /^\p{Lu}/u.test(t));
  }
}

function base64(d: Uint8Array): string {
  let s = "";
  for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
  return btoa(s);
}

function unbase64(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
