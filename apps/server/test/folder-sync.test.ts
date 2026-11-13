// BSD-334: Ordner-Sync (iCloud Drive) im based-server – zwei Server (zwei Macs) teilen einen Ordner. Änderungen der
// Clients (per Sync v2, Herkunft „remote“) gehen in den Ordner, die des anderen Macs kommen in den Store und damit per
// Pull zu den Clients; Anhänge reisen unter assets/<hash>; kein Echo; Zustand übersteht den Neustart.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPage, renamePage, type WireRecord } from "@based/core";
import { sha256Hex } from "@based/sync";
import { parseOptions } from "../src/main.js";
import { get, startApp } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

async function two(folder: string, dbA?: string) {
  const a = await startApp({ folderSync: { dir: folder, device: "macA", intervalMs: 3_600_000 }, ...(dbA ? { db: dbA } : {}) });
  const b = await startApp({ folderSync: { dir: folder, device: "macB", intervalMs: 3_600_000 } });
  apps.push(a, b);
  return { a, b };
}

describe("Ordner-Sync im Server (BSD-334)", () => {
  it("Client-Änderung (Sync v2) auf Mac A kommt über den Ordner auf Mac B an und ist dort per Pull abrufbar", async () => {
    const folder = mkdtempSync(join(tmpdir(), "based-icloud-"));
    const { a, b } = await two(folder);
    // wie ein Push eines Clients: Records mit Stempel, Herkunft „remote“
    const now = 800_000_000;
    const page: WireRecord = { kind: "block", data: { id: "P1", type: "page", parent: "w", sk: "a0", text: "From a client of A", createdAt: now, updatedAt: now, stamp: { millis: Date.now(), counter: 0, node: "client-a" } } };
    a.sync.store.applyRemote([page]);
    await a.folderSync!.round();
    await b.folderSync!.round();
    expect(b.sync.store.blocks.get("P1")?.text).toBe("From a client of A");
    const pull = await get(`${b.url}/sync/v2/pull?after=0&limit=5000`);
    expect(JSON.stringify(pull.body)).toContain("From a client of A");
    // eigene Änderung auf B (z. B. Agent auf dem Server) geht zurück zu A; was B aus dem Ordner hatte, schreibt B nicht zurück
    renamePage(b.sync.store, "P1", "Renamed on B");
    const q = createPage(b.sync.store, { title: "Made on B" });
    await b.folderSync!.round();
    await a.folderSync!.round();
    expect(a.sync.store.blocks.get("P1")?.text).toBe("Renamed on B");
    expect(a.sync.store.blocks.get(q)?.text).toBe("Made on B");
    const segsA = readdirSync(join(folder, "devices", "macA")).filter((f) => f.endsWith(".jsonl"));
    await a.folderSync!.round();
    expect(readdirSync(join(folder, "devices", "macA")).filter((f) => f.endsWith(".jsonl"))).toEqual(segsA);
    expect((await get(`${a.url}/folder-sync`)).body).toMatchObject({ device: "macA", error: null });
  });

  it("Anhänge: einmal in assets/<hash>, der andere Mac holt sie, wenn ein Record sie braucht", async () => {
    const folder = mkdtempSync(join(tmpdir(), "based-icloud-"));
    const { a, b } = await two(folder);
    const bytes = Buffer.from("pretend this is a photo");
    const hash = await sha256Hex(new Uint8Array(bytes));
    await a.assets.write(hash, 0, bytes.length, bytes);
    const now = 800_000_000;
    a.sync.store.applyRemote([{ kind: "block", data: { id: "IMG", type: "image", parent: "w", sk: "a1", props: { asset: { id: hash, name: "photo.png", size: bytes.length } }, createdAt: now, updatedAt: now, stamp: { millis: Date.now(), counter: 0, node: "client-a" } } }]);
    await a.folderSync!.round();
    expect(readdirSync(join(folder, "assets"))).toEqual([hash]);
    await b.folderSync!.round();
    expect(b.assets.status(hash).complete).toBe(true);
  });

  it("Zustand übersteht den Neustart (kein erneutes Lesen), Optionen", async () => {
    const folder = mkdtempSync(join(tmpdir(), "based-icloud-"));
    const dbDir = mkdtempSync(join(tmpdir(), "based-icloud-db-"));
    const { a, b } = await two(folder, join(dbDir, "a.sqlite"));
    createPage(b.sync.store, { title: "One" });
    await b.folderSync!.round();
    await a.folderSync!.round();
    expect(a.folderSync!.sync.state().seen.macB).toBe(1);
    await a.close();
    apps.splice(apps.indexOf(a), 1);
    const again = await startApp({ db: join(dbDir, "a.sqlite"), folderSync: { dir: folder, device: "macA", intervalMs: 3_600_000 } });
    apps.push(again);
    expect(again.folderSync!.sync.state().seen.macB).toBe(1);
    expect(parseOptions(["--token", "t", "--folder-sync", "/x/Based", "--folder-device", "mac-1"], {})).toMatchObject({ folderSync: "/x/Based", folderDevice: "mac-1" });
    expect(() => parseOptions(["--token", "t", "--folder-sync", "relative"], {})).toThrow(/absolute/);
    expect(() => parseOptions(["--token", "t", "--folder-sync", "/x", "--folder-device", "../evil"], {})).toThrow(/letters/);
  });
});
