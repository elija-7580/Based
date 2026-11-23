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
  plainText, restorePages, setValue, sortKeys, titleOf, toRichText, trashPages,
  type Block, type BlockProps, type MarkdownBlock, type PropertyValue, type Tx, type WorkspaceStore,
} from "@based/core";
import { decodeSkill, encodeSkill, isTextData, skillFileLanguage, type SkillDocument, type SkillFolder } from "../skills/codec.js";
import { MEMORY_KINDS, MEMORY_STATUSES, normalizedWords, similarTitles, type MemoryKind, type MemoryRecord, type MemoryStatus, type MemorySuggestion } from "../memory/suggestions.js";
import { isLearned, LEARNED_PREFIX, STYLE_TITLE } from "../memory/learn.js";
import { tokenize } from "../semantic/text.js";

/** Link auf eine Seite in Markdown (wird beim Schreiben eine Erwähnung und damit eine Kante im Graphen). */
export const PAGE_LINK = "based://page/";

/** Längster Titel einer gemerkten Tatsache; der Rest steht im Rumpf. */
export const MEMORY_TITLE_CHARS = 160;

export interface RememberInput {
  /** Die Tatsache in einem Satz. */
  fact: string;
  kind?: MemoryKind | undefined;
  /** Seiten, um die es geht (Person, Projekt, Thema) – werden als Erwähnungen verknüpft. */
  about?: readonly string[] | undefined;
  /** Seite, aus der die Tatsache stammt. */
  source?: string | undefined;
  /** Memory, die damit überholt ist (bekommt den Status „Superseded“). */
  replaces?: string | undefined;
  /** Mehr Text zur Tatsache (Markdown). */
  detail?: string | undefined;
  /** Als „To review“ ablegen (heikle Inhalte von Agenten). */
  review?: boolean | undefined;
}

export interface RememberResult {
  id: string;
  /** saved = neu; duplicate = stand schon da; linked = stand schon da, neue Verknüpfungen ergänzt. */
  outcome: "saved" | "duplicate" | "linked";
  status: MemoryStatus;
  title: string;
}

export class RememberError extends Error {}

/** Seiten-IDs aus den Zeilen „About: …“ eines Memory-Rumpfs. */
export function aboutIDs(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    if (!/^About:/.test(line.trim())) continue;
    for (const m of line.matchAll(/\(based:\/\/page\/([^)\s]+)\)/g)) if (!out.includes(m[1]!)) out.push(m[1]!);
  }
  return out;
}

/** Dieselbe Aussage: gleich nach Normalisieren oder fast dieselben Wörter (Stammformen, ohne Füllwörter). */
export function sameFact(a: string, b: string): boolean {
  const x = normalizedWords(a), y = normalizedWords(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  if (ta.size < 3 || tb.size < 3) return false;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common += 1;
  return common / (ta.size + tb.size - common) >= 0.8;
}

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

  /** Wie `body`, aber Erwähnungen als Links `based://page/<id>` (für Memories: die Verknüpfungen bleiben lesbar). */
  private linkedBody(id: string): string {
    const ex = new MarkdownExporter(this.store, { pageLink: (pid) => ({ title: titleOf(this.store, pid), url: PAGE_LINK + pid }) });
    return ex.exportBlocks(this.contentBlocks(id, false), 0).replace(/^\n+|\n+$/g, "");
  }

  private putMarkdown(tx: Tx, parent: string, md: string, position: "start" | "end" = "end", mentions = false) {
    // `mentions`: Links auf based://page/<id> werden Erwähnungen (und damit Kanten für Backlinks und den Graphen).
    const importer = mentions
      ? new MarkdownImporter({ resolveLink: (target) => {
          const id = target.startsWith(PAGE_LINK) ? target.slice(PAGE_LINK.length) : target;
          const b = this.store.blocks.get(id);
          return b && (b.type === "page" || b.type === "databasePage") ? id : undefined;
        } })
      : new MarkdownImporter();
    const items = importer.parse(md);
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
      const body = this.linkedBody(row.id);
      const about = aboutIDs(body);
      return { id: row.id, title: titleOf(this.store, row.id), kind, body, status: this.statusOf(row, db), ...(about.length ? { about } : {}), updatedAt: row.updatedAt };
    }).sort((a, b) => b.updatedAt - a.updatedAt).map(({ updatedAt: _u, ...m }) => m);
  }

  private optionName(row: Block, db: string, property: string): string | undefined {
    const pid = this.propID(db, property);
    const v = pid ? (row.values?.[pid] as { select?: { _0: string } } | undefined) : undefined;
    return v?.select ? this.store.databases.get(db)?.properties.find((p) => p.id === pid)?.options?.find((o) => o.id === v.select!._0)?.name : undefined;
  }

  private statusOf(row: Block, db: string): MemoryStatus {
    const name = this.optionName(row, db, "Status");
    return name && (MEMORY_STATUSES as readonly string[]).includes(name) ? (name as MemoryStatus) : "Active";
  }

  /** Wert einer Auswahl-Spalte; Spalte und Option werden bei Bedarf angelegt. */
  private selectValue(db: string, property: string, option: string, all: readonly string[]): Record<string, PropertyValue> {
    let pid = this.propID(db, property);
    if (!pid) {
      pid = addProperty(this.store, db, property, "select");
      if (pid) for (const o of all) addOption(this.store, db, pid, o);
    }
    if (!pid) return {};
    const opt = this.store.databases.get(db)?.properties.find((p) => p.id === pid)?.options?.find((o) => o.name === option)?.id ?? addOption(this.store, db, pid, option);
    return opt ? { [pid]: { select: { _0: opt } } as PropertyValue } : {};
  }

  /** Memories, die zählen (ohne überholte und ohne „To review“). */
  activeMemories(): MemoryRecord[] {
    return this.memories().filter((m) => (m.status ?? "Active") === "Active");
  }

  isMemory(id: string): boolean {
    const ids = this.find();
    return !!ids && this.store.blocks.get(id)?.parent === "d:" + ids.memoriesDB;
  }

  setMemoryStatus(id: string, status: MemoryStatus): void {
    const ids = this.find();
    if (!ids || !this.isMemory(id)) throw new RememberError(`No memory with id ${id}`);
    const v = this.selectValue(ids.memoriesDB, "Status", status, MEMORY_STATUSES);
    for (const [pid, value] of Object.entries(v)) setValue(this.store, id, pid, value);
  }

  /**
   * BSD-541: eine Tatsache merken – eine Zeile je Tatsache, mit Verknüpfungen zu den Seiten, um die es geht.
   * Regeln: steht dieselbe Aussage schon da, wird nichts verdoppelt (fehlende Verknüpfungen werden ergänzt);
   * `replaces` setzt die alte Memory auf „Superseded“ statt sie zu überschreiben; `review` legt sie als „To review“ ab.
   */
  remember(input: RememberInput): RememberResult {
    const fact = input.fact.replace(/\s+/g, " ").trim();
    if (!fact) throw new RememberError("Nothing to remember: `fact` is empty.");
    const isPage = (id: string) => {
      const b = this.store.blocks.get(id);
      return !!b && (b.type === "page" || b.type === "databasePage") && !isTrashed(this.store, id);
    };
    const about = [...new Set(input.about ?? [])];
    const bad = [...about, ...(input.source ? [input.source] : [])].filter((id) => !isPage(id));
    if (bad.length) throw new RememberError(`No page with id ${bad.join(", ")} (use ids from search or recall).`);
    if (input.replaces !== undefined && !this.isMemory(input.replaces)) throw new RememberError(`No memory with id ${input.replaces} to replace.`);
    const ids = this.ensure();
    const db = ids.memoriesDB;
    const link = (id: string) => `[${(titleOf(this.store, id) || "Untitled").replace(/[[\]]/g, "")}](${PAGE_LINK}${id})`;

    const existing = this.memories().find((m) => m.id !== input.replaces && m.status !== "Superseded"
      && (sameFact(m.title, fact) || m.body.split("\n").some((line) => sameFact(line.replace(/^[-*]\s+/, ""), fact))));
    if (existing) {
      const missing = about.filter((id) => !(existing.about ?? []).includes(id));
      if (missing.length) this.store.transact("Update memory", (tx) => this.putMarkdown(tx, existing.id, `About: ${missing.map(link).join(", ")}`, "end", true));
      return { id: existing.id, outcome: missing.length ? "linked" : "duplicate", status: existing.status ?? "Active", title: existing.title };
    }

    let title = fact, rest = "";
    if (fact.length > MEMORY_TITLE_CHARS) {
      const cut = fact.slice(0, MEMORY_TITLE_CHARS);
      const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("; "));
      title = end > 40 ? cut.slice(0, end + 1) : cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : MEMORY_TITLE_CHARS) + "…";
      rest = fact;
    }
    const status: MemoryStatus = input.review ? "To review" : "Active";
    const values = { ...this.selectValue(db, "Type", input.kind ?? "Notes", MEMORY_KINDS), ...this.selectValue(db, "Status", status, MEMORY_STATUSES) };
    const lines = [
      rest,
      input.detail?.trim() ?? "",
      about.length ? `About: ${about.map(link).join(", ")}` : "",
      input.source ? `Source: ${link(input.source)}` : "",
      input.replaces ? `Replaces: ${link(input.replaces)}` : "",
    ].filter(Boolean);
    const id = addRow(this.store, db, { title, values })!;
    if (lines.length) this.store.transact("New memory", (tx) => this.putMarkdown(tx, id, lines.join("\n\n"), "end", true));
    if (input.replaces) this.setMemoryStatus(input.replaces, "Superseded");
    return { id, outcome: "saved", status, title };
  }

  /** Memory speichern – NUR nach Bestätigung des Nutzers aufrufen. Ähnlicher Titel → an diese Memory anhängen. */
  saveMemory(m: { title: string; kind: MemoryKind; body: string; updates?: string | undefined; source?: string | undefined }): string {
    const ids = this.ensure();
    const db = ids.memoriesDB;
    const existing = (m.updates && this.memories().find((x) => x.id === m.updates)) || this.memories().find((x) => similarTitles(x.title, m.title));
    // `source` (gelernt aus einer Seite): Verknüpfung, damit man sieht, woher es kommt – und es wieder vergessen kann.
    const from = m.source ? this.learnedLine(m.source) : undefined;
    const body = from ? `${m.body}\n\n${from}` : m.body;
    if (existing) {
      this.store.transact("Update memory", (tx) => this.putMarkdown(tx, existing.id, body, "end", true));
      return existing.id;
    }
    const values: Record<string, PropertyValue> = {};
    const pid = this.propID(db, "Type");
    if (pid) {
      const opt = this.store.databases.get(db)?.properties.find((p) => p.id === pid)?.options?.find((o) => o.name === m.kind)?.id ?? addOption(this.store, db, pid, m.kind);
      if (opt) values[pid] = { select: { _0: opt } } as PropertyValue;
    }
    const id = addRow(this.store, db, { title: m.title, values })!;
    this.store.transact("New memory", (tx) => this.putMarkdown(tx, id, body, "end", true));
    return id;
  }

  /**
   * Aus Notizen Gelerntes ablegen (memory/learn.ts) – ohne Nachfrage, deshalb: Heikles nur als „To review“ (zählt
   * erst nach Freigabe), alles andere wie `saveMemory`, mit der Seite als Quelle.
   */
  saveLearned(m: MemorySuggestion, source?: string): string {
    if (!m.sensitive) return this.saveMemory({ title: m.title, kind: m.kind, body: m.body, updates: m.updates, source });
    const from = source ? this.learnedLine(source) : undefined;
    return this.remember({ fact: `${m.title}: ${m.body}`, kind: m.kind, review: true, detail: from ?? LEARNED_PREFIX + " your notes" }).id;
  }

  private learnedLine(source: string): string | undefined {
    const src = this.store.blocks.get(source);
    if (!src || (src.type !== "page" && src.type !== "databasePage")) return undefined;
    return `${LEARNED_PREFIX} [${(titleOf(this.store, src.id) || "Untitled").replace(/[[\]]/g, "")}](${PAGE_LINK}${src.id})`;
  }

  /** Memories, die das Lernen aus Notizen angelegt oder ergänzt hat (Zeile „Learned from: …“), dazu der Schreibstil. */
  learnedMemories(): MemoryRecord[] {
    return this.memories().filter((m) => m.status !== "Superseded" && (isLearned(m.body) || normalizedWords(m.title) === normalizedWords(STYLE_TITLE)));
  }

  /** Alles Gelernte in den Papierkorb (wiederherstellbar). Gibt die Anzahl zurück. */
  forgetLearned(): number {
    const ids = this.learnedMemories().map((m) => m.id);
    return ids.length ? trashPages(this.store, ids).length : 0;
  }

  /** Die eine Memory „Writing style“: der Rumpf wird ersetzt (kein Anhängen – der Stil ist immer der aktuelle). */
  setStyle(body: string): string {
    const ids = this.ensure();
    const existing = this.memories().find((x) => normalizedWords(x.title) === normalizedWords(STYLE_TITLE));
    if (existing) {
      this.setBody(existing.id, body, "Update memory");
      return existing.id;
    }
    const id = addRow(this.store, ids.memoriesDB, { title: STYLE_TITLE, values: { ...this.selectValue(ids.memoriesDB, "Type", "Preference", MEMORY_KINDS), ...this.selectValue(ids.memoriesDB, "Status", "Active", MEMORY_STATUSES) } })!;
    this.store.transact("New memory", (tx) => this.putMarkdown(tx, id, body));
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
