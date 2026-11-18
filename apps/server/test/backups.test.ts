// BSD-274: Backups des Server-Stores – Ordner auf der Platte (atomar), „Jetzt sichern“, Vorschau, Wiederherstellen
// nach „Seite gelöscht und Papierkorb geleert“, vorher automatisch ein Stand (rückgängig machbar), Sichern beim Beenden.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARCHIVE_VERSION, createPage, emptyTrash, encodeArchive, keyOf, snapshotName, trashPages, type WireRecord } from "@based/core";
import { parseOptions } from "../src/main.js";
import { startApp, TOKEN } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });
const call = async (url: string, method = "GET") => {
  const r = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

describe("Backups (BSD-274)", () => {
  it("Jetzt sichern, Seite weg, Vorschau, Wiederherstellen; vorher ein Stand; beim Beenden gesichert", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-backups-"));
    const app = await startApp({ backupDir: dir, backupEvery: 3_600_000 });
    const store = app.sync.store;
    const id = createPage(store, { title: "Precious" });
    const made = await call(`${app.url}/backups`, "POST");
    expect(made.status).toBe(201);
    const name = (made.body.snapshot as { name: string }).name;
    expect(readdirSync(join(dir, "snapshots"))).toContain(name);
    expect(readdirSync(join(dir, "snapshots")).some((f) => f.endsWith(".tmp"))).toBe(false);
    trashPages(store, [id]);
    emptyTrash(store);
    expect(store.blocks.has(id)).toBe(false);
    expect((await call(`${app.url}/backups/${name}/preview`)).body.pages).toEqual({ added: 1, changed: 0, removed: 0 });
    expect((await call(`${app.url}/backups/..%2Fx/preview`)).status).toBe(400);
    // eine Sekunde später, damit der Stand vor dem Wiederherstellen einen eigenen Namen hat
    await new Promise((r) => setTimeout(r, 1100));
    const restored = await call(`${app.url}/backups/${name}/restore`, "POST");
    expect(restored.status).toBe(200);
    expect(restored.body.before).toMatch(/\.based\.jsonl$/);
    expect(store.blocks.get(id)?.text).toBe("Precious");
    const list = (await call(`${app.url}/backups`)).body as { snapshots: { name: string }[]; last: { name: string } };
    expect(list.snapshots.length).toBeGreaterThanOrEqual(2);
    // Beenden sichert die Änderung (Wiederherstellen) noch einmal
    await new Promise((r) => setTimeout(r, 1100));
    createPage(store, { title: "After" });
    const before = readdirSync(join(dir, "snapshots")).length;
    await app.close();
    apps.length = 0;
    expect(readdirSync(join(dir, "snapshots")).length).toBe(before + 1);
  });

  it("Option --backups / BASED_BACKUP_DIR; ohne: keine Routen", async () => {
    expect(parseOptions(["--token", "x".repeat(20), "--backups", "/tmp/b"], {}).backupDir).toBe("/tmp/b");
    expect(parseOptions(["--token", "x".repeat(20)], { BASED_BACKUP_DIR: "/tmp/c" }).backupDir).toBe("/tmp/c");
    const app = await startApp();
    apps.push(app);
    expect((await call(`${app.url}/backups`)).status).toBe(404);
  });

  it("BSD-449: gewählter Ordner – Backup landet dort; fehlt er (Laufwerk ab), sichtbarer Fehler und KEIN stiller Ersatzordner", async () => {
    const drive = mkdtempSync(join(tmpdir(), "based-drive-"));
    const chosen = join(drive, "My Backups");
    mkdirSync(chosen);
    const app = await startApp({ backupDir: chosen, backupCreate: false, backupEvery: 3_600_000 });
    apps.push(app);
    createPage(app.sync.store, { title: "On the drive" });
    const made = await call(`${app.url}/backups`, "POST");
    expect(made.status).toBe(201);
    expect(readdirSync(join(chosen, "snapshots"))).toContain((made.body.snapshot as { name: string }).name);
    expect((await call(`${app.url}/backups`)).body).toMatchObject({ dir: chosen, reachable: true });
    // Laufwerk abgezogen: Ordner weg
    rmSync(drive, { recursive: true, force: true });
    const list = await call(`${app.url}/backups`);
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject({ reachable: false, snapshots: [], error: expect.stringContaining("isn't available") });
    createPage(app.sync.store, { title: "Later" });
    const failed = await call(`${app.url}/backups`, "POST");
    expect(failed).toMatchObject({ status: 409, body: { error: expect.stringContaining("isn't available") } });
    expect(existsSync(chosen)).toBe(false); // nichts still angelegt
    expect(existsSync(drive)).toBe(false);
  });

  it("BSD-449: Standardordner wird angelegt; BASED_BACKUP_CREATE=0 schaltet das ab", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "based-docs-")), "Based Backups");
    const app = await startApp({ backupDir: dir, backupEvery: 3_600_000 });
    apps.push(app);
    expect((await call(`${app.url}/backups`)).body).toMatchObject({ reachable: true });
    createPage(app.sync.store, { title: "x" });
    expect((await call(`${app.url}/backups`, "POST")).status).toBe(201);
    expect(existsSync(join(dir, "snapshots"))).toBe(true);
    expect(parseOptions([], { BASED_TOKEN: "t", BASED_BACKUP_DIR: "/Volumes/X/B", BASED_BACKUP_CREATE: "0" })).toMatchObject({ backupDir: "/Volumes/X/B", backupCreate: false });
    expect(parseOptions([], { BASED_TOKEN: "t", BASED_BACKUP_DIR: "/b" }).backupCreate).toBe(true);
  });
  it("BSD-558: Wiederherstellen eines Stands, den das Aufräumen beim Sichern davor löscht – seine Dateien kommen trotzdem zurück", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-backups-"));
    const app = await startApp({ backupDir: dir, backupEvery: 3_600_000 });
    apps.push(app);
    // erster Stand beim Start abwarten (sonst schreibt er mitten in die vorbereiteten Stände)
    for (let i = 0; i < 50 && ((await call(`${app.url}/backups`)).body.snapshots as unknown[]).length === 0; i++) await new Promise((r) => setTimeout(r, 50));
    const store = app.sync.store;
    const png = Buffer.from("not really a png, but bytes " + Date.now());
    const hash = createHash("sha256").update(png).digest("hex");
    const pageID = createPage(store, { title: "Gallery" });
    store.transact("img", (tx) => tx.put({ kind: "block", data: { id: "img558", type: "image", parent: "b:" + pageID, sk: "b", createdAt: 0, updatedAt: 0, props: { asset: { id: hash, name: "cat.png" } } } } as WireRecord));
    const withImage = store.exportRecords();
    store.transact("weg", (tx) => tx.remove(keyOf("block", "img558")));
    expect(store.blocks.has("img558")).toBe(false);
    const without = store.exportRecords();
    // Stand S (mit Bild, Datei nur im Backup) ist der 10. neueste und nicht der neueste seiner Stunde, seines Tages,
    // seines Monats: der Stand vor dem Wiederherstellen schiebt ihn aus der Aufbewahrung.
    const hour = Math.floor((Date.now() - 12 * 3_600_000) / 3_600_000) * 3_600_000;
    const put = (at: number, records: WireRecord[]) => {
      const name = snapshotName(new Date(at));
      writeFileSync(join(dir, "snapshots", name), encodeArchive(records, "W", ARCHIVE_VERSION, 1, new Date(at)));
      return name;
    };
    const s = put(hour + 60_000, withImage);
    put(hour + 120_000, without);
    for (let h = 1; h <= 7; h++) put(Date.now() - h * 3_600_000, without);
    mkdirSync(join(dir, "assets"), { recursive: true });
    writeFileSync(join(dir, "assets", hash), png);
    expect(app.assets.locate(hash)).toBeUndefined();
    const list = (await call(`${app.url}/backups`)).body.snapshots as { name: string }[];
    expect(list.map((x) => x.name).indexOf(s)).toBe(9);
    await new Promise((r) => setTimeout(r, 1100)); // eigener Name für den Stand davor
    const restored = await call(`${app.url}/backups/${s}/restore`, "POST");
    expect(restored.status).toBe(200);
    expect(restored.body.missing).toEqual([]);
    expect(store.blocks.get("img558")).toBeDefined();
    expect(app.assets.locate(hash)?.size).toBe(png.length);
    expect(readdirSync(join(dir, "snapshots"))).not.toContain(s); // vom Aufräumen gelöscht – die Datei ist trotzdem da
  });
});
