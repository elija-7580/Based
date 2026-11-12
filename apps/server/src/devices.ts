// BSD-315: eigene Geräte des Besitzers (Handy im Tailnet). Jedes Gerät bekommt ein eigenes Token (`bdo_…`), nie das
// Haupt-Token; gespeichert wird nur der SHA-256-Hash. Ein Geräte-Token gilt wie der Besitzer für alle Routen außer
// der Geräteverwaltung selbst und ist einzeln widerrufbar.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqlDatabase } from "@based/sync";

export interface OwnerDevice { id: string; name: string; createdAt: number; lastSeenAt: number | undefined }

const hash = (t: string) => createHash("sha256").update(t).digest("hex");

export class OwnerDevices {
  private readonly seen = new Map<string, number>();
  constructor(private readonly db: SqlDatabase, private readonly now: () => number = Date.now) {
    db.exec("CREATE TABLE IF NOT EXISTS owner_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created REAL NOT NULL, last_seen REAL)");
  }

  /** Neues Gerät; das Token gibt es nur hier, einmal. */
  add(name: string): { device: OwnerDevice; token: string } {
    const clean = name.trim().slice(0, 80) || "Device";
    const token = "bdo_" + randomBytes(32).toString("base64url");
    const device: OwnerDevice = { id: randomUUID(), name: clean, createdAt: this.now(), lastSeenAt: undefined };
    this.db.run("INSERT INTO owner_devices(id, name, hash, created, last_seen) VALUES(?, ?, ?, ?, NULL)", [device.id, clean, hash(token), device.createdAt]);
    return { device, token };
  }

  list(): OwnerDevice[] {
    return this.db.all("SELECT id, name, created, last_seen FROM owner_devices ORDER BY created").map((r) => ({
      id: String(r.id), name: String(r.name), createdAt: Number(r.created), lastSeenAt: this.seen.get(String(r.id)) ?? (r.last_seen == null ? undefined : Number(r.last_seen)),
    }));
  }

  remove(id: string): boolean {
    const before = this.db.all("SELECT id FROM owner_devices WHERE id = ?", [id]).length;
    this.db.run("DELETE FROM owner_devices WHERE id = ?", [id]);
    this.seen.delete(id);
    return before > 0;
  }

  /** Gerät zu einem Token (oder `undefined`); merkt sich „zuletzt gesehen“ (höchstens einmal pro Minute auf Platte). */
  check(token: string): OwnerDevice | undefined {
    if (!token.startsWith("bdo_")) return undefined;
    const r = this.db.all("SELECT id, name, created, last_seen FROM owner_devices WHERE hash = ?", [hash(token)])[0];
    if (!r) return undefined;
    const id = String(r.id), now = this.now();
    const last = this.seen.get(id) ?? (r.last_seen == null ? 0 : Number(r.last_seen));
    this.seen.set(id, now);
    if (now - last > 60_000) this.db.run("UPDATE owner_devices SET last_seen = ? WHERE id = ?", [now, id]);
    return { id, name: String(r.name), createdAt: Number(r.created), lastSeenAt: now };
  }
}
