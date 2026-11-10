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

describe("Cover-Höhe", async () => {
  const { coverHeight, setCoverHeight, setPageCover } = await import("../src/index.js");
  it("Standard 1 für alte Seiten ohne Wert, begrenzt 0,5…3, 1 wird nicht gespeichert, Entfernen des Covers räumt auf", () => {
    const s = mk();
    expect(coverHeight(s, "p")).toBe(1);
    setPageCover(s, "p", { color: { _0: "blue" } });
    setCoverHeight(s, "p", 1.756);
    expect(s.blocks.get("p")?.props?.format?.coverHeight).toBe(1.76);
    expect(coverHeight(s, "p")).toBe(1.76);
    setCoverHeight(s, "p", 9);
    expect(coverHeight(s, "p")).toBe(3);
    setCoverHeight(s, "p", 1);
    expect(s.blocks.get("p")?.props?.format?.coverHeight).toBeUndefined();
    setCoverHeight(s, "p", 0.1);
    expect(coverHeight(s, "p")).toBe(0.5);
    setPageCover(s, "p", undefined);
    expect(s.blocks.get("p")?.props?.format?.coverHeight).toBeUndefined();
  });
});

describe("Cover und Bild-Icon (BSD-201 Teil 2)", async () => {
  const { pageCover, setCoverPosition, setPageCover, setPageIconImage } = await import("../src/index.js");
  it("Cover wie Swift PageCover (_0), Position, Entfernen räumt die Position mit auf", () => {
    const s = mk();
    setPageCover(s, "p", { color: { _0: "blue" } });
    expect(s.blocks.get("p")?.props?.cover).toEqual({ color: { _0: "blue" } });
    setPageCover(s, "p", { asset: { _0: { id: "A1", name: "beach.jpg", size: 10, mime: "image/jpeg" } } });
    expect(pageCover(s, "p")).toEqual({ asset: { _0: { id: "A1", name: "beach.jpg", size: 10, mime: "image/jpeg" } } });
    setCoverPosition(s, "p", 0.2);
    expect(s.blocks.get("p")?.props?.format).toEqual({ hideOutline: true, coverPosition: 0.2 });
    setCoverPosition(s, "p", 0.5);
    expect(s.blocks.get("p")?.props?.format).toEqual({ hideOutline: true });
    setCoverPosition(s, "p", 0.8);
    setPageCover(s, "p", undefined);
    expect(s.blocks.get("p")?.props?.cover).toBeUndefined();
    expect(s.blocks.get("p")?.props?.format).toEqual({ hideOutline: true });
    s.undo();
    expect(pageCover(s, "p")).toMatchObject({ asset: {} });
    expect(pageCover(s, "p")).toBeDefined();
  });
  it("Bild als Icon wie Swift PageIcon.asset / .url", () => {
    const s = mk();
    setPageIconImage(s, "p", { asset: { id: "I1", name: "logo.png" } });
    expect(s.blocks.get("p")?.props?.icon).toEqual({ asset: { id: "I1", name: "logo.png" } });
    setPageIconImage(s, "p", { url: "https://example.com/i.png" });
    expect(s.blocks.get("p")?.props?.icon).toEqual({ url: "https://example.com/i.png" });
  });
});
