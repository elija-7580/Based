// BSD-163 / BSD-198: Agent-Brain-Seite des Store-Hosts (Muster wie worker/chat.ts). Skills und Memories liegen als
// echte Datenbanken im Store (AgentBrain), der Skill-Router und der lokale Index laufen hier neben den Daten; der
// Hauptthread bekommt nur Ergebnisse. Schützt die Brain-Seiten vor dem Löschen und repariert nach Änderungen.
import { isPageLike, isTrashed, parseKey, plainText, titleOf, type StoreChange, type WorkspaceStore } from "@based/core";
import {
  AgentBrain, BrainTools, CHAT_TYPE, chunkTexts, deletableIDs, LocalSemanticIndex, SkillCodecError, skillFoldersFromZip, skillFoldersToZip, SkillRouter,
  type Citation, type MemoryKind, type MemoryRecord, type SemanticHit, type SkillCorrection, type SkillFolder, type SkillRecord, type SkillRouting, type ToolResult, type ToolSpec,
} from "@based/brain";
import type { JSONValue } from "@based/core";

export type BrainAction =
  | { op: "status" }
  | { op: "ensure" }
  | { op: "skills" }
  | { op: "saveSkill"; name: string; description: string; body: string }
  | { op: "setSkillEnabled"; id: string; enabled: boolean }
  /** SKILL.md-Dateien oder ZIPs (ein oder mehrere Skill-Ordner). */
  | { op: "importSkills"; files: { name: string; bytes: ArrayBuffer }[] }
  /** Alle (oder die genannten) Skills als ZIP. */
  | { op: "exportSkills"; ids?: string[] }
  | { op: "route"; query: string; corrections?: SkillCorrection[] }
  | { op: "skillsByID"; ids: string[] }
  | { op: "memories" }
  | { op: "saveMemory"; title: string; kind: MemoryKind; body: string; updates?: string }
  | { op: "personNames" }
  | { op: "resolveCitations"; markers: { kind: "block" | "page"; id: string }[] }
  | { op: "related"; pageID: string; limit?: number }
  | { op: "toolSpecs" }
  | { op: "tool"; name: string; input: JSONValue };

export interface BrainStatus {
  exists: boolean;
  rootID?: string;
  skills: number;
  memories: number;
}

export interface SkillImportReport {
  imported: { id: string; name: string; created: boolean }[];
  errors: string[];
}

export type ResolvedCitation = Omit<Citation, "number">;

export class BrainHost {
  readonly brain: AgentBrain;
  private index: LocalSemanticIndex | undefined;
  private indexDirty = new Set<string>();
  private router: { revision: number; router: SkillRouter } | undefined;
  private repairQueued = false;
  /** Gibt es (oder gab es) einen Brain? Ohne wird nach Änderungen nichts geprüft (große Workspaces, Importe). */
  private active = false;
  readonly tools: BrainTools;

  constructor(private readonly store: WorkspaceStore) {
    this.brain = new AgentBrain(store);
    if (this.brain.exists) {
      this.brain.protect();
      this.active = true;
    }
    this.tools = new BrainTools(store, this.brain, () => this.semantic());
  }

  handle(a: BrainAction): unknown {
    const b = this.brain;
    if (a.op === "ensure" || a.op === "saveSkill" || a.op === "importSkills" || a.op === "saveMemory") this.active = true;
    switch (a.op) {
      case "status": {
        const ids = b.find();
        return (ids ? { exists: true, rootID: ids.root, skills: b.skills().length, memories: b.memories().length } : { exists: false, skills: 0, memories: 0 }) satisfies BrainStatus;
      }
      case "ensure": return b.ensure();
      case "skills": return b.skills() satisfies SkillRecord[];
      case "saveSkill": return b.saveSkill({ name: a.name, description: a.description, body: a.body });
      case "setSkillEnabled": return b.setSkillEnabled(a.id, a.enabled);
      case "importSkills": return this.importSkills(a.files);
      case "exportSkills": {
        const ids = a.ids ?? b.skills().map((s) => s.id);
        const folders = ids.map((id) => b.exportSkill(id)).filter((f): f is SkillFolder => !!f);
        return skillFoldersToZip(folders).buffer;
      }
      case "route": return this.route(a.query, a.corrections ?? []) satisfies SkillRouting;
      case "skillsByID": return b.skills().filter((s) => a.ids.includes(s.id));
      case "memories": return b.memories() satisfies MemoryRecord[];
      case "saveMemory": return b.saveMemory({ title: a.title, kind: a.kind, body: a.body, updates: a.updates });
      case "personNames": return b.personNames();
      case "resolveCitations": return this.resolveCitations(a.markers);
      case "related": return this.related(a.pageID, a.limit ?? 5);
      case "toolSpecs": return this.tools.specs satisfies ToolSpec[];
      case "tool": return this.tools.call(a.name, a.input) satisfies ToolResult;
    }
  }

  private importSkills(files: { name: string; bytes: ArrayBuffer }[]): SkillImportReport {
    const out: SkillImportReport = { imported: [], errors: [] };
    for (const f of files) {
      try {
        const bytes = new Uint8Array(f.bytes);
        const folders: SkillFolder[] = /\.zip$/i.test(f.name) ? skillFoldersFromZip(bytes, f.name) : [{ name: f.name.replace(/\.md$/i, "").replace(/^SKILL$/i, ""), files: { "SKILL.md": bytes } }];
        for (const folder of folders) {
          const r = this.brain.importSkill(folder);
          out.imported.push({ id: r.id, name: r.name, created: r.created });
        }
      } catch (e) {
        out.errors.push(`${f.name}: ${e instanceof SkillCodecError || e instanceof Error ? e.message : String(e)}`);
      }
    }
    return out;
  }

  private route(query: string, corrections: SkillCorrection[]): SkillRouting {
    if (!this.brain.exists) return { candidates: [], selected: [], preselected: false };
    if (!this.router || this.router.revision !== this.store.revision) {
      this.router = { revision: this.store.revision, router: new SkillRouter(this.brain.skills(true)) };
    }
    return this.router.router.route(query, { corrections });
  }

  private resolveCitations(markers: { kind: "block" | "page"; id: string }[]): Record<string, ResolvedCitation | null> {
    const out: Record<string, ResolvedCitation | null> = {};
    const s = this.store;
    for (const m of markers) {
      const key = `${m.kind}:${m.id}`;
      const b = s.blocks.get(m.id);
      if (!b || isTrashed(s, m.id)) { out[key] = null; continue; }
      if (m.kind === "page" || isPageLike(b)) { out[key] = { pageID: m.id, title: titleOf(s, m.id), snippet: "" }; continue; }
      const page = containingPage(s, m.id);
      if (!page) { out[key] = null; continue; }
      const raw = plainText(b.text).trim();
      out[key] = { pageID: page, blockID: m.id, title: titleOf(s, page), snippet: raw.length > 120 ? raw.slice(0, 117) + "…" : raw };
    }
    return out;
  }

  // MARK: Lokaler Index (BSD-62)

  semantic(): LocalSemanticIndex {
    if (!this.index) {
      this.index = new LocalSemanticIndex();
      for (const b of this.store.blocks.values()) if (isPageLike(b)) this.indexPage(b.id);
      this.indexDirty.clear();
    }
    for (const id of this.indexDirty) this.indexPage(id);
    this.indexDirty.clear();
    return this.index;
  }

  private indexPage(id: string) {
    const s = this.store;
    const b = s.blocks.get(id);
    if (!b || !isPageLike(b) || isTrashed(s, id)) {
      this.index?.removePage(id);
      return;
    }
    const texts: string[] = [];
    const visit = (parent: string) => {
      for (const k of s.children(parent)) {
        const c = s.blocks.get(k);
        if (!c || isPageLike(c) || c.type === CHAT_TYPE) continue;
        const t = plainText(c.text);
        if (t) texts.push(t);
        visit("b:" + k);
      }
    };
    visit("b:" + id);
    this.index!.setPage(id, titleOf(s, id), chunkTexts(texts));
  }

  private related(pageID: string, limit: number): (SemanticHit & { title: string })[] {
    return this.semantic().related(pageID, limit).filter((h) => !isTrashed(this.store, h.pageID)).map((h) => ({ ...h, title: titleOf(this.store, h.pageID) }));
  }

  // MARK: Änderungen, Schutz

  /** Löschen nur, was nicht zum Brain gehört; `refused` meldet die UI. */
  guardDelete(ids: string[]): { allowed: string[]; refused: string[] } {
    return deletableIDs(this.store, ids);
  }

  noteChange(change: StoreChange) {
    for (const key of change.keys) {
      const { kind, id } = parseKey(key);
      if (kind !== "block") continue;
      if (this.index) this.indexDirty.add(containingPage(this.store, id) ?? id);
      // Ein Brain kommt über Sync oder Import dazu.
      if (!this.active && (this.store.blocks.get(id)?.props as { brain?: string } | undefined)?.brain) this.active = true;
    }
    if (this.active && !this.repairQueued) {
      this.repairQueued = true;
      queueMicrotask(() => {
        this.repairQueued = false;
        if (!this.store.isReadOnly) this.brain.repair();
      });
    }
  }
}

/** Die Seite, auf der ein Block steht (die Seite selbst, wenn es eine ist). */
function containingPage(store: WorkspaceStore, id: string): string | undefined {
  let cur = store.blocks.get(id);
  for (let i = 0; cur && i < 200; i++) {
    if (isPageLike(cur)) return cur.id;
    if (!cur.parent.startsWith("b:")) return undefined;
    cur = store.blocks.get(cur.parent.slice(2));
  }
  return undefined;
}
