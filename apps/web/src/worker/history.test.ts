// BSD-73: wann Seiten eine Version bekommen (PageHistory im Worker).
import { MemoryHistoryStorage, MemoryPersistence, VersionHistory, WorkspaceStore, type WireRecord } from "@based/core";
import { describe, expect, it } from "vitest";
import { PageHistory } from "./history.js";

const blk = (id: string, parent: string, type = "text"): WireRecord => ({ kind: "block", data: { id, type, parent, sk: "a0", text: id, createdAt: 0, updatedAt: 0 } });

function setup() {
  const store = new WorkspaceStore({ persistence: new MemoryPersistence([blk("P", "w", "page"), blk("t", "b:P"), blk("S", "b:P", "page"), blk("s", "b:S")]), node: "n" });
  let now = 1_000_000;
  const h = new PageHistory(store, new VersionHistory(new MemoryHistoryStorage()), { now: () => now });
  store.observe((c) => h.onChange(c));
  return { store, h, advance: (ms: number) => (now += ms) };
}

describe("PageHistory", () => {
  it("Öffnen, Pause, Höchstabstand; Sync-Änderungen zählen nicht", () => {
    const { store, h, advance } = setup();
    h.pageOpened("P");
    expect(h.history.versions("P").map((v) => v.reason)).toEqual(["opened"]);
    store.setText("t", "neu");
    advance(30_000);
    h.tick();
    expect(h.history.versions("P").length).toBe(1); // noch keine Minute Pause
    advance(31_000);
    h.tick();
    expect(h.history.versions("P").map((v) => v.reason)).toEqual(["edit", "opened"]);
    store.applyRemote([{ kind: "block", data: { ...store.blocks.get("t")!, text: "remote", stamp: { millis: 9e12, counter: 0, node: "z" } } }]);
    advance(120_000);
    h.tick();
    expect(h.history.versions("P").length).toBe(2);
  });

  it("Unterseite: eigener Verlauf; ihr Titel ändert auch die Elternseite", () => {
    const { store, h } = setup();
    store.setText("s", "in der Unterseite");
    h.flush();
    expect(h.history.versions("S").length).toBe(1);
    expect(h.history.versions("P").length).toBe(0);
    store.setText("S", "Neuer Titel");
    h.flush();
    expect(h.history.versions("S").length).toBe(2);
    expect(h.history.versions("P").length).toBe(1);
  });

  it("gelöschte Blöcke finden ihre Seite; höchstens 25 Seiten pro Takt", () => {
    const { store, h, advance } = setup();
    h.pageOpened("P");
    store.deleteBlocks(["t"]);
    expect(h.list("P").versions.map((v) => v.reason)).toEqual(["edit", "opened"]);
    store.transact("viele", (tx) => {
      for (let i = 0; i < 60; i++) tx.put(blk("X" + i, "w", "page"));
    });
    advance(61_000);
    h.tick();
    const count = () => Array.from({ length: 60 }, (_, i) => h.history.versions("X" + i).length).reduce((a, b) => a + b, 0);
    expect(count()).toBe(25);
    h.tick();
    h.tick();
    expect(count()).toBe(60);
  });

  it("Schreibfehler wird gemeldet, nicht verschluckt", () => {
    const { store, h } = setup();
    (h.history.storage as MemoryHistoryStorage).failNextPut = new Error("quota exceeded");
    store.setText("t", "x");
    expect(h.list("P").error).toBe("quota exceeded");
    expect(h.list("P").error).toBeUndefined(); // nächster Versuch klappt
    expect(h.history.versions("P").length).toBe(1);
  });
});
