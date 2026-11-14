// BSD-260 Teil 10: Apple-Notes-Export (eine HTML-Datei je Notiz, Titel als erste Zeile, Anhänge daneben) und andere
// einfache HTML-Notizen – der Titel steht nicht doppelt auf der Seite.
import { describe, expect, it } from "vitest";
import { ImportFiles, prepareImport, preparedImportToWire, plainText, type Block } from "../src/index.js";

function pages(files: Record<string, string | Uint8Array>) {
  const tree = new ImportFiles();
  for (const [p, d] of Object.entries(files)) tree.add(p, typeof d === "string" ? new TextEncoder().encode(d) : d);
  const w = preparedImportToWire(prepareImport([{ files: tree, path: "Notes" }], { userID: null }));
  const blocks = (w.builder?.blocks ?? []) as Block[];
  const text = (b: Block) => (typeof b.text === "string" ? b.text : plainText(b.text ?? []));
  return blocks.filter((b) => b.type === "page").map((p) => ({
    title: text(p),
    body: blocks.filter((b) => b.parent === "b:" + p.id).map((b) => `${b.type}:${text(b)}`),
  }));
}

describe("Apple Notes (HTML)", () => {
  it("Titelzeile fällt weg, Listen, Hervorhebungen und Bilder bleiben", () => {
    const html = `<html><head><meta charset="utf-8"></head><body><div><b><span style="font-size: 24px">Groceries</span></b></div>
      <div>Buy milk</div><div><br></div><ul class="Apple-dash-list"><li>Eggs</li><li>Bread</li></ul>
      <div><i>later</i> today</div><div><img src="Attachments/pic.png"></div></body></html>`;
    const [p] = pages({ "Notes/Groceries.html": html, "Notes/Attachments/pic.png": new Uint8Array([0x89, 0x50, 0x4e, 0x47]) });
    expect(p).toEqual({ title: "Groceries", body: ["text:Buy milk", "bulletedList:Eggs", "bulletedList:Bread", "text:later today", "image:"] });
  });

  it("mit <title> und Überschrift als erste Zeile (Google Docs) – auch dann nur einmal", () => {
    const [p] = pages({ "Notes/Plan.html": "<html><head><title>Q3 Plan</title></head><body><h1>Q3 Plan</h1><p>Goals</p></body></html>" });
    expect(p).toEqual({ title: "Q3 Plan", body: ["text:Goals"] });
  });

  it("erste Zeile anders als der Titel oder mit Bild: bleibt", () => {
    const [a] = pages({ "Notes/Trip.html": "<html><body><div>Packing list</div><div>Socks</div></body></html>" });
    expect(a!.body).toEqual(["text:Packing list", "text:Socks"]);
    const [b] = pages({ "Notes/Cat.html": `<html><body><div>Cat<img src="cat.png"></div></body></html>`, "Notes/cat.png": new Uint8Array([1]) });
    expect(b!.body.length).toBeGreaterThan(0);
  });
});
