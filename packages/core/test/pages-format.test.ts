// BSD-168: Vorgaben für neue Seiten (Einstellungen → My settings → New pages) landen im selben Undo-Schritt.
import { describe, expect, it } from "vitest";
import { createPage, MemoryPersistence, pageFormat, WorkspaceStore } from "../src/index.js";

describe("createPage mit Vorgaben", () => {
  it("setzt Schrift, Small text und Full width; Standardwerte bleiben ungeschrieben", () => {
    let t = 1;
    const store = new WorkspaceStore({ node: "t", persistence: new MemoryPersistence(), now: () => (t += 1) });
    const a = createPage(store, { title: "A", format: { font: "serif", smallText: true, fullWidth: true } });
    expect(pageFormat(store, a)).toEqual({ font: "serif", smallText: true, fullWidth: true, locked: false });
    const b = createPage(store, { title: "B", format: { font: "default", smallText: false, fullWidth: false } });
    expect(store.blocks.get(b)!.props?.format).toBeUndefined();
    store.undo();
    store.undo();
    expect(store.blocks.has(a)).toBe(false);
  });
});
