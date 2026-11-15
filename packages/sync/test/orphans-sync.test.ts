// BSD-437: Nach dem Pull rettet der Sync-Client verwaiste Blöcke in den Papierkorb (Swift syncV2 → rescueOrphans).
import { describe, expect, it } from "vitest";
import { createPage, deleteForever, RECOVERED_BLOCKS_PAGE_ID, trashedPages, trashPages, type WorkspaceStore } from "@based/core";
import { openWorkspace, SyncClient, type SqlitePersistence } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";
import { FakeServer } from "./fake-server.js";

const device = (node: string) => openWorkspace(openNodeDatabase(), { node });
const client = (d: { store: WorkspaceStore; persistence: SqlitePersistence }, server: FakeServer) =>
  new SyncClient(d.store, d.persistence, { baseURL: "https://based.test/", token: server.token, fetch: server.fetch });

describe("BSD-437 Sync rettet Waisen", () => {
  it("A löscht die Seite endgültig, B ändert darin später: auf A landet B's Block im Papierkorb statt unsichtbar", async () => {
    const server = new FakeServer();
    const a = device("a"), b = device("b");
    const page = createPage(a.store, { title: "Shared" });
    a.store.transact("add", (tx) => tx.put({ kind: "block", data: { id: "line", type: "text", parent: "b:" + page, sk: "a0", text: "v1", createdAt: 0, updatedAt: 0 } }));
    await client(a, server).syncOnce();
    await client(b, server).syncOnce();
    // A: Seite endgültig löschen; B (offline) ändert danach den Block
    trashPages(a.store, [page]);
    deleteForever(a.store, [page]);
    await new Promise((r) => setTimeout(r, 5));
    b.store.setText("line", "v2 – written later on B");
    await client(a, server).syncOnce();
    await client(b, server).syncOnce();
    await client(a, server).syncOnce();
    const line = a.store.blocks.get("line");
    expect(line?.text).toBe("v2 – written later on B");
    expect(line?.parent).toBe("b:" + RECOVERED_BLOCKS_PAGE_ID);
    expect(trashedPages(a.store).map((x) => x.id)).toContain(RECOVERED_BLOCKS_PAGE_ID);
  });
});
