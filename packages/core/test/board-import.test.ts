// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-566: Obsidian Canvas und Excalidraw-Zeichnungen werden Boards – Formen, Text, Karten für Notizen, Bilder,
// Verbindungen; was ein Board nicht kennt, steht im Bericht.
import { describe, expect, it } from "vitest";
import { boardObjectsOf, ImportFiles, importNotionItems, isBoardPage, MemoryAssetSink, MemoryPersistence, plainText, WorkspaceStore } from "../src/index.js";
import { boardColorName, canvasToBoard, lzDecompressFromBase64, readExcalidraw } from "../src/interop/board-import.js";
import { EXCALIDRAW_PACKED, excalidrawNote } from "./fixtures/excalidraw.js";

const enc = new TextEncoder();
const CANVAS = JSON.stringify({
  nodes: [
    { id: "a", type: "text", text: "# Idea\nSee [[Plan|the plan]]", x: 0, y: 0, width: 250, height: 120, color: "4" },
    { id: "b", type: "file", file: "Notes/Plan.md", x: 400, y: 0, width: 300, height: 200 },
    { id: "c", type: "file", file: "attachments/pic.png", x: 0, y: 300, width: 200, height: 150 },
    { id: "d", type: "link", url: "https://example.com", x: 400, y: 300, width: 200, height: 80 },
    { id: "g", type: "group", label: "Cluster", x: -50, y: -50, width: 800, height: 300, color: "#7c3aed" },
    { id: "m", type: "file", file: "missing.pdf", x: 0, y: 600, width: 100, height: 100 },
    { id: "w", type: "widget", x: 0, y: 0, width: 1, height: 1 },
  ],
  edges: [
    { id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", label: "leads to", color: "1" },
    { id: "e2", fromNode: "a", toNode: "nowhere" },
  ],
});

function load(m: Record<string, string | Uint8Array>, path: string) {
  const s = new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
  const files = new ImportFiles(Object.entries(m).map(([k, v]) => [k, typeof v === "string" ? enc.encode(v) : v] as const));
  const r = importNotionItems(s, [{ files, path }], { assets: new MemoryAssetSink() });
  return { s, r };
}
const page = (s: WorkspaceStore, title: string) => [...s.blocks.values()].find((b) => b.type === "page" && plainText(b.text) === title)!;

describe("Board-Import (BSD-566)", () => {
  it("LZ-String: gepackte Szene des Plugins wird gelesen; Kaputtes ergibt null oder Unsinn, keinen Absturz", () => {
    const json = lzDecompressFromBase64(EXCALIDRAW_PACKED.replace(/\s+/g, ""));
    expect(JSON.parse(json!).elements).toHaveLength(9);
    expect(() => lzDecompressFromBase64("N4KAkARALg")).not.toThrow();
    expect(lzDecompressFromBase64("")).toBe("");
  });

  it("Farben: Canvas-Vorgaben und Hex nach Farbton, transparent bleibt leer", () => {
    expect(boardColorName("1", "fill")).toBe("red");
    expect(boardColorName("5", "fill")).toBe("blue");
    expect(boardColorName("#1e1e1e", "stroke")).toBe("ink");
    expect(boardColorName("#a5d8ff", "fill")).toBe("blue");
    expect(boardColorName("#ffec99", "fill")).toBe("orange");
    expect(boardColorName("transparent", "fill")).toBeUndefined();
    expect(boardColorName("#ffffff", "fill")).toBeUndefined();
  });

  it("Canvas allein: Arten, Gruppe hinten, Verbindung mit Seiten und Beschriftung, Hinweise", () => {
    const warnings: string[] = [];
    let n = 0;
    const objs = canvasToBoard(CANVAS, {
      newID: () => `o${n++}`, warn: (w) => warnings.push(w),
      page: (t) => (t === "Notes/Plan.md" ? { id: "P", title: "Plan" } : undefined),
      file: (t) => (t === "attachments/pic.png" ? { ref: "based-asset:h", name: "pic.png", mime: "image/png", size: 3 } : undefined),
    }, "Board.canvas");
    expect(objs.map((o) => o.kind)).toEqual(["frame", "shape", "page", "image", "shape", "shape", "connector"]);
    expect([...objs].sort((a, b) => (a.z < b.z ? -1 : 1))[0]!.kind).toBe("frame");
    const text = objs[1]!;
    expect(text.kind === "shape" && text.text).toBe("# Idea\nSee the plan");
    expect(text.style).toMatchObject({ shape: "rect", color: "green", fill: "green" });
    expect(objs[2]).toMatchObject({ kind: "page", ref: "P", text: "Plan", x: 400, w: 300 });
    expect(objs[3]).toMatchObject({ kind: "image", ref: "based-asset:h" });
    const c = objs[6]!;
    expect(c.kind === "connector" && [c.from.side, c.to.side, c.label, c.style?.color]).toEqual(["right", "left", "leads to", "red"]);
    expect(warnings.join("\n")).toMatch(/missing file “missing.pdf”/);
    expect(warnings.join("\n")).toMatch(/1 widget card skipped/);
  });

  it("Excalidraw: Formen mit Text, Pfeil als Verbindung, Freihand als Tinte, Bild über Embedded Files", () => {
    const scene = readExcalidraw(excalidrawNote());
    expect(scene.files.get("0123456789abcdef0123456789abcdef01234567")).toBe("pic.png");
    expect(scene.elements.some((e) => e.id === "gone")).toBe(false);
  });

  it("Vault: Canvas und Zeichnung werden Board-Seiten; Karte verlinkt die Notiz, Hinweise für Unbekanntes", () => {
    const { s, r } = load({
      "Vault/.obsidian/app.json": "{}",
      "Vault/Notes/Plan.md": "The plan.",
      "Vault/Board.canvas": CANVAS,
      "Vault/Sketch.excalidraw.md": excalidrawNote(),
      "Vault/Broken.excalidraw.md": "---\nexcalidraw-plugin: parsed\n---\n```compressed-json\nN4KAkARALg\n```",
      "Vault/attachments/pic.png": "PNG",
      "Vault/pic.png": "PNG",
    }, "Vault");
    const root = s.blocks.get(r.rootIDs[0]!)!;
    expect(s.children("b:" + root.id).map((id) => plainText(s.blocks.get(id)!.text))).toEqual(["Notes", "Board", "Broken", "Sketch"]);

    const board = page(s, "Board");
    expect(isBoardPage(board)).toBe(true);
    const objs = boardObjectsOf(s, board.id);
    expect(objs).toHaveLength(7);
    const card = objs.find((o) => o.kind === "page")!;
    expect(card.kind === "page" && card.ref).toBe(page(s, "Plan").id);
    // Die Karte ist ein echter Link (Backlinks).
    expect((s.blocks.get(card.id)!.props as { linkTarget?: string }).linkTarget).toBe(page(s, "Plan").id);
    expect(objs.find((o) => o.kind === "image")!.kind === "image" && (objs.find((o) => o.kind === "image") as { ref?: string }).ref).toMatch(/^based-asset:/);

    const sketch = boardObjectsOf(s, page(s, "Sketch").id);
    const kinds = sketch.map((o) => o.kind).sort();
    expect(kinds).toEqual(["connector", "image", "ink", "shape", "shape", "text"]);
    const rect = sketch.find((o) => o.kind === "shape" && o.text === "Start")!;
    expect(rect.style).toMatchObject({ shape: "rect", fill: "blue" });
    expect(sketch.find((o) => o.kind === "shape" && o.style?.shape === "oval")!.style).toMatchObject({ color: "red" });
    const arrow = sketch.find((o) => o.kind === "connector")!;
    expect(arrow.kind === "connector" && arrow.from.id).toBe(rect.id);
    expect(sketch.find((o) => o.kind === "ink")!.style).toMatchObject({ color: "green" });
    expect(sketch.find((o) => o.kind === "text")).toMatchObject({ text: "Loose note", style: { color: "blue" } });

    expect(isBoardPage(page(s, "Broken"))).toBe(true);
    expect(boardObjectsOf(s, page(s, "Broken").id)).toHaveLength(0);
    const w = r.warnings.join("\n");
    expect(w).toMatch(/Couldn't read the drawing in Broken.excalidraw.md/);
    expect(w).toMatch(/Sketch.excalidraw.md: 1 embeddable element skipped/);
    expect(w).not.toMatch(/isn't supported yet/);
  });
});
