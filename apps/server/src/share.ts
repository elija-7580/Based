// Teilen auf dem TS-based-server (docs/sharing.md, Swift `ShareService`). Personen und Links bekommen eine Rolle auf
// einer Seite; die Rolle gilt für alles darin (Unterseiten, Datenbanken, Zeilen), die höchste gewinnt.
//
//   owner   BASED_TOKEN: alles
//   user    hat eine Einladung angenommen, meldet sich mit einem eigenen Geräte-Token (`bdu_…`) an
//   link    wer einen Access-Link (`bdl_…`) hat (anonym)
//
// Freigaben sind Records des Servers (Nutzer, Grants, Links) in der `meta`-Tabelle unter `share.v1` – im selben
// JSON wie Swift (Datum = Sekunden seit 2001), also austauschbar mit dem Swift-Server. Sie sind keine Workspace-
// Records und gehen nie an Geräte. Geheimnisse (Link-Geheimnisse, Geräte-Tokens) liegen nur als SHA-256 vor.
// Prüfung = ReBAC-Tupel (Subjekt, Rolle, Seite), den Seitenbaum hinauf ausgewertet.
import { createHash, randomBytes } from "node:crypto";
import { isPageLike, isTrashed, keyOf, parseKey, type RecordKeyString, type WireRecord, type WorkspaceStore } from "@based/core";
import { asText, type SqlitePersistence } from "@based/sync";
import { OLDEST_SEQ_KEY, type DecodedPush, type PullPage, type PushReply, type SyncService, type WireDeletion } from "./sync.js";

export type ShareRole = "view" | "comment" | "edit" | "full";
export const SHARE_ROLES: readonly ShareRole[] = ["view", "comment", "edit", "full"];
const RANK: Record<ShareRole, number> = { view: 0, comment: 1, edit: 2, full: 3 };
export const ROLE_LABEL: Record<ShareRole, string> = { view: "Can view", comment: "Can comment", edit: "Can edit", full: "Full access" };
export const isRole = (s: unknown): s is ShareRole => typeof s === "string" && s in RANK;
const maxRole = (a: ShareRole | undefined, b: ShareRole | undefined) => (a === undefined ? b : b === undefined ? a : RANK[a] >= RANK[b] ? a : b);
export const canEdit = (r: ShareRole | undefined) => r !== undefined && RANK[r] >= RANK.edit;
export const canShare = (r: ShareRole | undefined) => r === "full";

export type LinkKind = "access" | "invite" | "publish";

/** Swift `Date` in JSON: Sekunden seit 2001-01-01 (Foundation `timeIntervalSinceReferenceDate`). */
export type SwiftDate = number;
const REFERENCE_MS = Date.UTC(2001, 0, 1);
export const toSwiftDate = (ms: number): SwiftDate => (ms - REFERENCE_MS) / 1000;
export const fromSwiftDate = (d: SwiftDate): number => d * 1000 + REFERENCE_MS;

export interface ShareUser {
  id: string;
  name: string;
  createdAt: SwiftDate;
  tokenHashes: string[];
  lastSeen?: SwiftDate;
}

export interface ShareGrant {
  id: string;
  pageID: string;
  userID: string;
  role: ShareRole;
  createdAt: SwiftDate;
}

export interface SharingLink {
  id: string;
  kind: LinkKind;
  pageID: string;
  role: ShareRole;
  secretHash: string;
  label?: string;
  createdAt: SwiftDate;
  expiresAt?: SwiftDate;
  revokedAt?: SwiftDate;
  /** Einladungen: wie viele noch beitreten dürfen (fehlt = unbegrenzt). */
  usesLeft?: number;
  lastUsed?: SwiftDate;
  /** BSD-236: Veröffentlichung zeigt fremde Embeds (iframes) – Opt-in je Seite; fehlt = nein. */
  allowEmbeds?: boolean;
}

export interface ShareState {
  users: ShareUser[];
  grants: ShareGrant[];
  links: SharingLink[];
}

export type SharePrincipal = { kind: "owner" } | { kind: "user"; user: ShareUser } | { kind: "link"; link: SharingLink };
export const OWNER: SharePrincipal = { kind: "owner" };

export class ShareError extends Error {
  constructor(readonly status: 400 | 403 | 404, message: string) {
    super(message);
    this.name = "ShareError";
  }
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** Zufallskennung, base64url ohne Auffüllung (Swift `SecureToken.make`). */
export const secureToken = (prefix = "", bytes = 24) => prefix + randomBytes(bytes).toString("base64url");

export const META_KEY = "share.v1";

export function principalLabel(p: SharePrincipal): string {
  return p.kind === "owner" ? "Owner" : p.kind === "user" ? p.user.name : (p.link.label ?? "Link");
}

export class ShareService {
  state: ShareState;

  /** BSD-284: Elternverweis je Block (zum Erkennen von Verschiebungen). */
  private readonly parents = new Map<string, string>();
  /** BSD-285: Block einer Datenbank bzw. Ansicht – damit sich nach einer Löschung noch sagen lässt, wo sie lag. */
  private readonly dbBlocks = new Map<string, string>();
  private readonly viewBlocks = new Map<string, string>();
  private deletedSincePrune = 0;
  private readonly unobserve: () => void;
  /** BSD-284: Long-Polls wecken, wenn eine Freigabe neuen Inhalt sichtbar macht (setzt die App). */
  onScopeChange?: () => void;

  constructor(
    readonly store: WorkspaceStore,
    readonly persistence: SqlitePersistence,
    readonly nowMillis: () => number = Date.now,
  ) {
    this.state = ShareService.load(persistence);
    persistence.db.exec("CREATE TABLE IF NOT EXISTS share_moves (id TEXT PRIMARY KEY, seq INTEGER NOT NULL)");
    persistence.db.exec("CREATE TABLE IF NOT EXISTS share_deleted (key TEXT PRIMARY KEY, chain TEXT NOT NULL, seq INTEGER NOT NULL)");
    for (const [id, b] of store.blocks) this.parents.set(id, b.parent);
    for (const [id, d] of store.databases) this.dbBlocks.set(id, d.blockID);
    for (const [id, v] of store.views) this.viewBlocks.set(id, v.blockID);
    this.unobserve = store.observe((change) => this.noteMoves(change.keys));
  }

  close() {
    this.unobserve();
  }

  /**
   * BSD-284: Ein Block, der den Elternverweis wechselt, kann in den Bereich eines Gastes wandern. Sein Inhalt steht
   * dann nicht im Change-Log (unverändert). Der Server merkt sich die Verschiebung mit ihrer Log-Position; der Pull
   * schickt den lesbaren Teilbaum dann einmal mit – nicht bei jeder Änderung (eine Datenbank mit 50 000 Zeilen).
   */
  private noteMoves(keys: readonly RecordKeyString[]) {
    let seq: number | undefined;
    // BSD-285: erst die Lage gelöschter Records festhalten (die Zwischenspeicher kennen sie noch), dann aktualisieren.
    const gone: [RecordKeyString, string[]][] = [];
    for (const key of keys) {
      if (this.store.record(key)) continue;
      const chain = this.cachedChain(key);
      if (chain) gone.push([key, chain]);
    }
    for (const key of keys) {
      const i = key.indexOf(":");
      const kind = key.slice(0, i), id = key.slice(i + 1);
      if (kind === "database") {
        const d = this.store.databases.get(id);
        if (d) this.dbBlocks.set(id, d.blockID); else this.dbBlocks.delete(id);
        continue;
      }
      if (kind === "view") {
        const v = this.store.views.get(id);
        if (v) this.viewBlocks.set(id, v.blockID); else this.viewBlocks.delete(id);
        continue;
      }
      if (kind !== "block") continue;
      const b = this.store.blocks.get(id);
      const old = this.parents.get(id);
      if (!b) { this.parents.delete(id); continue; }
      this.parents.set(id, b.parent);
      if (old === undefined || old === b.parent) continue;
      seq ??= this.persistence.maxSeq();
      this.persistence.db.run("INSERT OR REPLACE INTO share_moves(id, seq) VALUES(?, ?)", [id, seq]);
    }
    if (gone.length > 0) {
      seq ??= this.persistence.maxSeq();
      for (const [key, chain] of gone) this.persistence.db.run("INSERT OR REPLACE INTO share_deleted(key, chain, seq) VALUES(?, ?, ?)", [key, JSON.stringify(chain), seq]);
      this.deletedSincePrune += gone.length;
      if (this.deletedSincePrune >= 500) {
        this.deletedSincePrune = 0;
        // Nur so lange, wie das Change-Log die Löschung führt (Tombstone-GC, BSD-104).
        this.persistence.db.run("DELETE FROM share_deleted WHERE seq <= ?", [this.persistence.metaInt(OLDEST_SEQ_KEY)]);
      }
    }
  }

  /** BSD-285: Block-IDs vom Record bis ganz oben, aus den Zwischenspeichern (auch für eben gelöschte Records). */
  private cachedChain(key: RecordKeyString): string[] | undefined {
    const i = key.indexOf(":");
    const kind = key.slice(0, i), id = key.slice(i + 1);
    let cur: string | undefined;
    const out: string[] = [];
    if (kind === "block") { if (!this.parents.has(id)) return undefined; out.push(id); cur = this.parents.get(id); }
    else if (kind === "database") { const b = this.dbBlocks.get(id); if (b === undefined) return undefined; cur = "b:" + b; }
    else if (kind === "view") { const b = this.viewBlocks.get(id); if (b === undefined) return undefined; cur = "b:" + b; }
    else return undefined;
    for (let guard = 0; cur && guard < 512; guard++) {
      if (cur.startsWith("b:")) { const b = cur.slice(2); out.push(b); cur = this.parents.get(b); }
      else if (cur.startsWith("d:")) { const b = this.dbBlocks.get(cur.slice(2)); cur = b === undefined ? undefined : "b:" + b; }
      else cur = undefined;
    }
    return out;
  }

  /** BSD-285: Lag der gelöschte Record im Bereich des Principals? `undefined` = unbekannt (vor dieser Version). */
  private deletionVisible(direct: Map<string, ShareRole>, key: string): boolean | undefined {
    const row = this.persistence.db.all("SELECT chain FROM share_deleted WHERE key = ?", [key])[0];
    if (!row) return undefined;
    const chain = JSON.parse(asText(row.chain) ?? "[]") as string[];
    return chain.some((id) => direct.has(id));
  }

  /** Verschobene oder neu freigegebene Blöcke mit Log-Position in (after, upTo]. */
  private movedBetween(after: number, upTo: number): string[] {
    return this.persistence.db.all("SELECT id FROM share_moves WHERE seq > ? AND seq <= ?", [after, upTo]).map((r) => asText(r.id) ?? "");
  }

  /**
   * BSD-284: Neue Freigabe für einen schon verbundenen Nutzer: die Seite bekommt einen frischen Log-Eintrag (Inhalt
   * unverändert, gleicher Stempel) und gilt als „hineingewandert“ – sein nächster Pull bringt sie mit Inhalt.
   */
  private relogForScope(pageID: string) {
    const rec = this.store.record(keyOf("block", pageID));
    if (!rec) return;
    this.persistence.write([rec], [], new Map(), false);
    this.persistence.db.run("INSERT OR REPLACE INTO share_moves(id, seq) VALUES(?, ?)", [pageID, this.persistence.maxSeq()]);
    this.onScopeChange?.();
  }

  static load(persistence: SqlitePersistence): ShareState {
    const raw = persistence.meta(META_KEY);
    if (raw) {
      try {
        const v = JSON.parse(raw) as Partial<ShareState>;
        return { users: v.users ?? [], grants: v.grants ?? [], links: v.links ?? [] };
      } catch {
        // kaputt: leer beginnen (der Owner kann neu teilen); nichts überschreiben, bis sich etwas ändert
      }
    }
    return { users: [], grants: [], links: [] };
  }

  private save() {
    this.persistence.setMeta(META_KEY, JSON.stringify(this.state));
  }

  private get now(): SwiftDate {
    return toSwiftDate(this.nowMillis());
  }

  isActive(l: SharingLink): boolean {
    return l.revokedAt === undefined && (l.expiresAt === undefined || l.expiresAt > this.now) && (l.usesLeft === undefined || l.usesLeft > 0);
  }

  // MARK: Principals

  /** Ein Geräte-Token (`bdu_…`) oder ein Access-Link-Geheimnis (`bdl_…`). Den Owner-Token prüft der Router. */
  principal(token: string): SharePrincipal | undefined {
    if (!token) return undefined;
    const h = sha256(token);
    if (token.startsWith("bdu_")) {
      const user = this.state.users.find((u) => u.tokenHashes.includes(h));
      if (!user) return undefined;
      user.lastSeen = this.now; // nur im Speicher; gespeichert mit der nächsten Änderung
      return { kind: "user", user };
    }
    if (token.startsWith("bdl_")) {
      const link = this.state.links.find((l) => l.secretHash === h);
      return link && link.kind === "access" && this.isActive(link) ? { kind: "link", link } : undefined;
    }
    return undefined;
  }

  link(secret: string): SharingLink | undefined {
    if (!secret) return undefined;
    const h = sha256(secret);
    return this.state.links.find((l) => l.secretHash === h);
  }

  publishedLink(id: string): SharingLink | undefined {
    return this.state.links.find((l) => l.id === id && l.kind === "publish" && this.isActive(l));
  }

  // MARK: Rollen

  private directRoles(p: SharePrincipal): Map<string, ShareRole> {
    const out = new Map<string, ShareRole>();
    if (p.kind === "link") out.set(p.link.pageID, p.link.role);
    else if (p.kind === "user") {
      for (const g of this.state.grants) if (g.userID === p.user.id) out.set(g.pageID, maxRole(out.get(g.pageID), g.role)!);
    }
    return out;
  }

  /** Seiten mit direkter Rolle (ohne solche, die in einer anderen liegen). */
  roots(p: SharePrincipal): { pageID: string; role: ShareRole }[] {
    const direct = this.directRoles(p);
    return [...direct.entries()]
      .filter(([id]) => !this.chainOfParent("b:" + id).slice(1).some((a) => direct.has(a)))
      .map(([pageID, role]) => ({ pageID, role }))
      .sort((a, b) => (a.pageID < b.pageID ? -1 : 1));
  }

  /**
   * Wo ein Elternverweis im Seitenbaum hängt: Block-IDs vom Verweis bis ganz oben. `pending` erlaubt Records, die
   * derselbe Push erst anlegt (eine neue Seite mit Inhalt).
   */
  chainOfParent(parent: string, pending: Map<RecordKeyString, WireRecord> = new Map()): string[] {
    const out: string[] = [];
    let cur: string | undefined = parent;
    for (let guard = 0; cur && guard < 512; guard++) {
      if (cur.startsWith("b:")) {
        const id = cur.slice(2);
        out.push(id);
        const p = pending.get(keyOf("block", id));
        cur = p?.kind === "block" ? p.data.parent : this.store.blocks.get(id)?.parent;
      } else if (cur.startsWith("d:")) {
        const id = cur.slice(2);
        const p = pending.get(keyOf("database", id));
        const db = p?.kind === "database" ? p.data : this.store.databases.get(id);
        cur = db ? "b:" + db.blockID : undefined;
      } else cur = undefined; // "w"
    }
    return out;
  }

  chainOf(r: WireRecord, pending?: Map<RecordKeyString, WireRecord>): string[] {
    switch (r.kind) {
      case "block": return [r.data.id, ...this.chainOfParent(r.data.parent, pending)];
      case "database": return this.chainOfParent("b:" + r.data.blockID, pending);
      case "view": return this.chainOfParent("b:" + r.data.blockID, pending);
      case "workspace": return [];
    }
  }

  role(p: SharePrincipal, r: WireRecord, pending?: Map<RecordKeyString, WireRecord>): ShareRole | undefined {
    if (p.kind === "owner") return "full";
    if (r.kind === "workspace") return undefined;
    const direct = this.directRoles(p);
    if (direct.size === 0) return undefined;
    let best: ShareRole | undefined;
    for (const id of this.chainOf(r, pending)) best = maxRole(best, direct.get(id));
    return best;
  }

  rolePage(p: SharePrincipal, pageID: string): ShareRole | undefined {
    const b = this.store.blocks.get(pageID);
    return b ? this.role(p, { kind: "block", data: b }) : undefined;
  }

  canRead(p: SharePrincipal, r: WireRecord): boolean {
    if (p.kind === "owner") return true;
    if (r.kind === "block" && isTrashed(this.store, r.data.id)) return false;
    return this.role(p, r) !== undefined;
  }

  // MARK: Verwalten

  createLink(kind: LinkKind, pageID: string, role: ShareRole, by: SharePrincipal, opts: { label?: string | undefined; expiresInDays?: number | undefined; uses?: number | undefined } = {}) {
    const page = this.store.blocks.get(pageID);
    if (!page || !isPageLike(page)) throw new ShareError(404, "Not found.");
    const mine = this.rolePage(by, pageID);
    if (!canShare(mine)) throw new ShareError(403, "Sharing needs full access to the page.");
    if (RANK[role] > RANK[mine!]) throw new ShareError(403, "You can't give more access than you have.");
    if (kind === "publish" && role !== "view") throw new ShareError(400, "Published pages are read-only.");
    if (kind === "access" && role === "full") throw new ShareError(400, "Anonymous links can't have full access; use an invite.");
    if (opts.expiresInDays !== undefined && !(opts.expiresInDays > 0)) throw new ShareError(400, "expiresInDays must be positive.");
    if (opts.uses !== undefined && !(Number.isInteger(opts.uses) && opts.uses > 0)) throw new ShareError(400, "uses must be a positive integer.");
    // Eine Seite hat höchstens einen aktiven Publish-Link: erneutes Veröffentlichen gibt denselben zurück.
    if (kind === "publish") {
      const existing = this.state.links.find((l) => l.kind === "publish" && l.pageID === pageID && this.isActive(l));
      if (existing) return { link: existing, secret: undefined };
    }
    const secret = secureToken("bdl_");
    const link: SharingLink = { id: secureToken("", 9), kind, pageID, role, secretHash: sha256(secret), createdAt: this.now };
    if (opts.label) link.label = opts.label.slice(0, 80);
    if (opts.expiresInDays !== undefined) link.expiresAt = this.now + opts.expiresInDays * 86_400;
    if (kind === "invite" && opts.uses !== undefined) link.usesLeft = opts.uses;
    this.state.links.push(link);
    this.save();
    return { link, secret };
  }

  revokeLink(id: string, by: SharePrincipal) {
    const l = this.state.links.find((x) => x.id === id);
    if (!l) throw new ShareError(404, "Not found.");
    if (!canShare(this.rolePage(by, l.pageID)) && by.kind !== "owner") throw new ShareError(403, "Needs full access.");
    if (l.revokedAt === undefined) {
      l.revokedAt = this.now;
      this.save();
    }
  }

  /** BSD-236: fremde Embeds auf einer veröffentlichten Seite erlauben (nur Publish-Links, volle Rechte). */
  setLinkEmbeds(id: string, allow: boolean, by: SharePrincipal) {
    const l = this.state.links.find((x) => x.id === id);
    if (!l) throw new ShareError(404, "Not found.");
    if (l.kind !== "publish") throw new ShareError(400, "Only published pages can show embeds.");
    if (!canShare(this.rolePage(by, l.pageID)) && by.kind !== "owner") throw new ShareError(403, "Needs full access.");
    if (allow) l.allowEmbeds = true; else delete l.allowEmbeds;
    this.save();
    return l;
  }

  /** Einladung angenommen: neuer Nutzer mit der Rolle des Links und einem Geräte-Token (nur jetzt sichtbar). */
  acceptInvite(secret: string, name: string): { user: ShareUser; token: string; pageID: string } {
    const clean = name.trim();
    if (clean === "" || clean.length > 80) throw new ShareError(400, "Enter your name.");
    const l = this.link(secret);
    if (!l || l.kind !== "invite") throw new ShareError(404, "Not found.");
    if (!this.isActive(l)) throw new ShareError(403, "This invite has expired or was revoked.");
    const token = secureToken("bdu_", 32);
    const user: ShareUser = { id: secureToken("", 9), name: clean, createdAt: this.now, tokenHashes: [sha256(token)], lastSeen: this.now };
    this.state.users.push(user);
    this.state.grants.push({ id: secureToken("", 9), pageID: l.pageID, userID: user.id, role: l.role, createdAt: this.now });
    l.lastUsed = this.now;
    if (l.usesLeft !== undefined) l.usesLeft -= 1;
    this.save();
    return { user, token, pageID: l.pageID };
  }

  setGrant(userID: string, pageID: string, role: ShareRole | null, by: SharePrincipal) {
    if (!this.state.users.some((u) => u.id === userID)) throw new ShareError(404, "Not found.");
    const mine = this.rolePage(by, pageID);
    if (!canShare(mine)) throw new ShareError(403, "Sharing needs full access to the page.");
    if (role !== null && RANK[role] > RANK[mine!]) throw new ShareError(403, "You can't give more access than you have.");
    const before = this.state.grants.some((g) => g.userID === userID && g.pageID === pageID);
    this.state.grants = this.state.grants.filter((g) => !(g.userID === userID && g.pageID === pageID));
    if (role !== null) this.state.grants.push({ id: secureToken("", 9), pageID, userID, role, createdAt: this.now });
    this.save();
    if (role !== null && !before) this.relogForScope(pageID);
  }

  /** Alle Freigaben einer Seite, auch die von Seiten darüber geerbten. */
  access(pageID: string): { grants: ShareGrant[]; links: SharingLink[] } {
    const ids = new Set(this.chainOfParent("b:" + pageID));
    return {
      grants: this.state.grants.filter((g) => ids.has(g.pageID)),
      links: this.state.links.filter((l) => ids.has(l.pageID) && this.isActive(l)),
    };
  }

  // MARK: Sync, nach Rolle gefiltert

  /** Alles, was der Principal sieht, plus Change-Log-Position (erstes Laden). */
  snapshot(p: SharePrincipal, sync: SyncService): PullPage {
    return { records: this.store.allRecords().filter((r) => this.canRead(p, r)), deletions: [], next: sync.seq, more: false };
  }

  /** Records, die mit einem Block den sichtbaren Bereich verlassen: Inhalt, Unterseiten, Datenbanken, Zeilen, Ansichten. */
  private subtreeKeys(id: string): RecordKeyString[] {
    const out: RecordKeyString[] = [];
    const stack = [id];
    for (let guard = 0; stack.length > 0 && guard < 100_000; guard++) {
      const cur = stack.pop()!;
      out.push(keyOf("block", cur));
      stack.push(...this.store.children("b:" + cur));
      const dbID = this.store.blocks.get(cur)?.props?.databaseID;
      const db = dbID ? this.store.databases.get(dbID) : undefined;
      if (db && db.blockID === cur) {
        out.push(keyOf("database", db.id));
        for (const v of this.store.views.values()) if (v.databaseID === db.id) out.push(keyOf("view", v.id));
        stack.push(...this.store.children("d:" + db.id));
      }
    }
    return out;
  }

  /**
   * Das Change-Log, wie der Principal es sieht. Geänderte Records, die er nicht (mehr) lesen darf, kommen als
   * ungestempelte Löschung; eine Seite, die den geteilten Bereich verlässt, nimmt ihren Inhalt mit.
   */
  pull(p: SharePrincipal, sync: SyncService, after: number, limit: number): PullPage {
    const page = sync.pull(after, limit);
    if (p.kind === "owner") return page;
    const records: WireRecord[] = [];
    // BSD-285: Löschungen nur aus dem Bereich des Gastes (sonst sähe er, wie viel anderswo gelöscht wird).
    const direct = this.directRoles(p);
    const deletions: WireDeletion[] = page.deletions.filter((d) => this.deletionVisible(direct, `${d.kind}:${d.id}`) !== false);
    const seen = new Set<string>(deletions.map((d) => `${d.kind}:${d.id}`));
    const drop = (key: RecordKeyString) => {
      if (seen.has(key)) return;
      seen.add(key);
      deletions.push(parseKey(key));
    };
    for (const r of page.records) {
      if (this.canRead(p, r)) {
        records.push(r);
        continue;
      }
      if (r.kind === "workspace") continue; // Gäste haben keinen Workspace-Record
      if (r.kind === "block" && isPageLike(r.data)) for (const k of this.subtreeKeys(r.data.id)) drop(k);
      else drop(keyOf(r.kind, r.data.id));
    }
    // BSD-284: hineingewanderte Blöcke bringen ihren (unveränderten) Inhalt mit.
    const moved = this.movedBetween(after, page.next);
    if (moved.length > 0) {
      const have = new Set<string>(records.map((r) => keyOf(r.kind, r.data.id)));
      for (const id of moved) {
        const b = this.store.blocks.get(id);
        if (!b || !this.canRead(p, { kind: "block", data: b } as WireRecord)) continue;
        for (const k of this.subtreeKeys(id)) {
          if (have.has(k)) continue;
          const r = this.store.record(k);
          if (r && this.canRead(p, r)) { records.push(r); have.add(k); }
        }
      }
    }
    return { ...page, records, deletions };
  }

  /**
   * Übernimmt, was der Principal ändern darf: Bearbeiten (oder voll) dort, wo der Record jetzt ist, *und* dort, wo er
   * hingeht; kein Workspace-Record, nichts für Lesen/Kommentieren. Abgelehnte Records kommen als Server-Kopie zurück
   * (der Client rollt zurück).
   */
  push(p: SharePrincipal, sync: SyncService, body: DecodedPush): PushReply & { rejected: RecordKeyString[] } {
    if (p.kind === "owner") return { ...sync.pushDecoded(body), rejected: [] };
    const pending = new Map<RecordKeyString, WireRecord>();
    for (const r of body.records) {
      const key = keyOf(r.kind, r.data.id);
      if (!this.store.record(key)) pending.set(key, r);
    }
    const direct = this.directRoles(p);
    const allowed: WireRecord[] = [];
    const rejected: RecordKeyString[] = [];
    for (const r of body.records) {
      const key = keyOf(r.kind, r.data.id);
      let destination = this.role(p, r, pending);
      const old = r.kind === "block" ? this.store.blocks.get(r.data.id) : undefined;
      if (r.kind === "block" && old && old.parent !== r.data.parent) {
        // Verschieben braucht Bearbeiten am Ziel (eine geteilte Seite lässt sich nicht aus dem Bereich ziehen).
        destination = undefined;
        for (const id of this.chainOfParent(r.data.parent, pending)) destination = maxRole(destination, direct.get(id));
      }
      const existing = this.store.record(key);
      const current = existing ? this.role(p, existing) : destination;
      if (canEdit(destination) && canEdit(current)) allowed.push(r);
      else rejected.push(key);
    }
    const deletions: RecordKeyString[] = [];
    // BSD-282: Wer nur bearbeiten darf, legt Seiten, Zeilen und Datenbanken in den Papierkorb (das ist eine Änderung
    // am Record), löscht sie aber nicht endgültig. Dazu gehört alles, was eine solche Löschung mitnähme (der Inhalt
    // der Seite) oder verwaisen ließe (ein Block, unter dem nach diesem Push noch eine Seite hängt).
    const kept = new Set<string>();
    const movedTo = new Map<string, string>();
    for (const r of allowed) if (r.kind === "block") movedTo.set(r.data.id, r.data.parent);
    const wanted: { key: RecordKeyString; record: WireRecord; role: ShareRole | undefined }[] = [];
    for (const k of body.deletions) {
      const r = this.store.record(k);
      const role = r ? this.role(p, r) : undefined;
      if (!r || !canEdit(role)) { rejected.push(k); continue; }
      wanted.push({ key: k, record: r, role });
      if (canShare(role)) continue;
      if (r.kind === "block" && this.store.isTrashable(r.data)) kept.add(r.data.id);
      else if (r.kind === "database") kept.add(r.data.blockID);
    }
    for (const w of wanted) {
      if (canShare(w.role)) { deletions.push(w.key); continue; }
      const chain = this.chainOf(w.record);
      const keepsPage = w.record.kind === "block" && this.holdsPage(w.record.data.id, movedTo);
      if (keepsPage || chain.some((id) => kept.has(id))) rejected.push(w.key);
      else deletions.push(w.key);
    }
    const stamps = new Map([...body.stamps].filter(([k]) => deletions.includes(k)));
    const reply = sync.pushDecoded({ records: allowed, deletions, stamps });
    for (const k of rejected) {
      const r = this.store.record(k);
      if (r && this.canRead(p, r)) reply.newer.push(r);
    }
    return { ...reply, rejected };
  }

  /**
   * Hängt unter dem Block (ihn selbst ausgenommen) noch eine Seite, Zeile oder eigene Datenbank? `movedTo`: neue
   * Eltern aus demselben Push (der Client zieht eingebettete Seiten vor dem Löschen heraus, BSD-99).
   */
  private holdsPage(id: string, movedTo: Map<string, string>): boolean {
    const stack = [...this.store.children("b:" + id)];
    while (stack.length) {
      const cur = stack.pop()!;
      const b = this.store.blocks.get(cur);
      if (!b) continue;
      const parent = movedTo.get(cur);
      if (parent !== undefined && parent !== b.parent && !this.chainOfParent(parent).includes(id)) continue;
      if (this.store.isTrashable(b)) return true;
      stack.push(...this.store.children("b:" + cur));
    }
    return false;
  }

  // MARK: Veröffentlichen

  /** Gehört die Datei (SHA-256) zu einem Record, den der Principal lesen darf? */
  canReadAsset(p: SharePrincipal, hash: string): boolean {
    if (p.kind === "owner") return true;
    for (const r of this.store.allRecords()) {
      if (r.kind === "workspace" || !JSON.stringify(r.data).includes(hash)) continue;
      if (this.canRead(p, r)) return true;
    }
    return false;
  }
}

/** Öffentliche Sicht eines Links (ohne Geheimnis-Hash). */
export function linkJSON(l: SharingLink, active: boolean) {
  return {
    id: l.id,
    kind: l.kind,
    role: l.role,
    pageID: l.pageID,
    label: l.label ?? null,
    active,
    createdAt: new Date(fromSwiftDate(l.createdAt)).toISOString(),
    ...(l.expiresAt !== undefined ? { expiresAt: new Date(fromSwiftDate(l.expiresAt)).toISOString() } : {}),
    ...(l.usesLeft !== undefined ? { usesLeft: l.usesLeft } : {}),
    ...(l.kind === "publish" ? { path: `/p/${l.id}`, allowEmbeds: l.allowEmbeds === true } : {}),
  };
}
