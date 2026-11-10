// BSD-201: Seiten-Optionen (Swift PageOps setPageIcon/setPageFormat).
import { describe, expect, it } from "vitest";
import { MemoryPersistence, pageFormat, setPageFormat, setPageIcon, WorkspaceStore, type Block } from "../src/index.js";

const mk = () => {
  let t = 1;
  return new WorkspaceStore({
    persistence: new MemoryPersistence([{ kind: "block", data: { id: "p", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0, props: { format: { hideOutline: true } } } as Block }]),
    node: "t", now: () => (t += 1),
  });
};

describe("Seiten-Optionen", () => {
  it("Icon setzen (als String wie Swift .emoji) und entfernen, je ein Undo-Schritt", () => {
    const s = mk();
    setPageIcon(s, "p", "🚀");
    expect(s.blocks.get("p")?.props?.icon).toBe("🚀");
    setPageIcon(s, "p", undefined);
    expect(s.blocks.get("p")?.props?.icon).toBeUndefined();
    s.undo();
    expect(s.blocks.get("p")?.props?.icon).toBe("🚀");
  });

  it("Format: Schrift, Small text, Full width, Sperre; Standard entfernt das Feld, andere bleiben", () => {
    const s = mk();
    setPageFormat(s, "p", { font: "serif", smallText: true, fullWidth: true, locked: true });
    expect(pageFormat(s, "p")).toEqual({ font: "serif", smallText: true, fullWidth: true, locked: true });
    expect(s.blocks.get("p")?.props?.format).toEqual({ hideOutline: true, font: "serif", smallText: true, fullWidth: true, locked: true });
    setPageFormat(s, "p", { font: "default", smallText: false, fullWidth: false, locked: false });
    expect(s.blocks.get("p")?.props?.format).toEqual({ hideOutline: true });
    expect(pageFormat(s, "p")).toEqual({ font: "default", smallText: false, fullWidth: false, locked: false });
  });
});
