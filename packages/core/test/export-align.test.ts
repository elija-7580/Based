// BSD-290: Ausrichtung eines Bildes (props.align) erscheint im HTML-Export; ohne align bleibt die Ausgabe wie bisher.
import { describe, expect, it } from "vitest";
import { HTMLExporter } from "../src/interop/export.js";
import { MemoryPersistence, WorkspaceStore, type Block } from "../src/index.js";

const img = (props: Block["props"]): Block =>
  ({ id: "b-img", type: "image", parent: "p:p-1", sk: "a0", props, createdAt: 0, updatedAt: 0 }) as unknown as Block;

describe("HTML-Export: Bildausrichtung", () => {
  const ex = new HTMLExporter(new WorkspaceStore({ persistence: new MemoryPersistence([]), node: "t" }));
  it("ohne align: unverändert", () => {
    expect(ex.block(img({ url: "https://example.com/a.png", caption: "Cap" }))).toBe(
      '<figure><img src="https://example.com/a.png" alt="Cap"><figcaption>Cap</figcaption></figure>\n');
  });
  it("Mitte und rechts als text-align, links und Unbekanntes ohne", () => {
    expect(ex.block(img({ url: "https://example.com/a.png", align: "center" }))).toContain('<figure style="text-align: center">');
    expect(ex.block(img({ url: "https://example.com/a.png", align: "right" }))).toContain('<figure style="text-align: right">');
    expect(ex.block(img({ url: "https://example.com/a.png", align: "left" }))).toContain("<figure><img");
    expect(ex.block(img({ url: "https://example.com/a.png", align: "x\" onload=\"y" }))).toContain("<figure><img");
  });
});
