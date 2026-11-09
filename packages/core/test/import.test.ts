// BSD-156: was die Fixtures nicht abdecken – ZIP-Robustheit (Grenzen, unsichere/unbekannte Einträge, Abbruch),
// Worker-Aufteilung prepare/commit mit Fortschritt, Export-ZIP mit Fehlerbericht, Archiv-Paket hin und zurück.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  commitPreparedImport, extractZip, ImportCancelled, ImportFiles, importNotionItems, loadArchive, MemoryAssetSink, MemoryPersistence,
  planWorkspaceExport, prepareImport, readZipEntries, topLevelPages, WorkspaceStore, writeArchivePackage, writeExportZip, ZipError, importArchiveRecords,
} from "../src/index.js";

const enc = new TextEncoder();
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });

/** Ändert Flags/Methode eines Eintrags im zentralen Verzeichnis (für Testfälle). */
function patchCentral(zip: Uint8Array, name: string, f: (view: DataView, at: number) => void): Uint8Array {
  const out = zip.slice();
  const view = new DataView(out.buffer);
  const n = enc.encode(name);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const len = view.getUint16(i + 28, true);
    if (len === n.length && out.subarray(i + 46, i + 46 + len).every((b, k) => b === n[k])) f(view, i);
  }
  return out;
}

describe("ZIP", () => {
  const sample = zipSync({ "a.md": enc.encode("# A\n\nbody"), "dir/b.txt": [enc.encode("x".repeat(5000)), { level: 9 }], "../evil.md": enc.encode("no") });

  it("liest deflate und gespeichert, überspringt unsichere Pfade", () => {
    const r = extractZip(sample);
    expect(r.files.readText("a.md")).toBe("# A\n\nbody");
    expect(r.files.readText("dir/b.txt")).toBe("x".repeat(5000));
    expect(r.skipped).toEqual(["../evil.md — unsafe path"]);
    expect(r.count).toBe(2);
  });

  it("verschachtelte Teil-Archive werden Ordner", () => {
    const outer = zipSync({ "Export-Part-1.zip": [zipSync({ "p.md": enc.encode("x") }), { level: 0 }], "__MACOSX/._p.md": enc.encode("junk") });
    const r = extractZip(outer);
    expect(r.files.readText("Export-Part-1/p.md")).toBe("x");
    expect(r.files.isFile("Export-Part-1.zip")).toBe(false);
  });

  it("Grenzen: Anzahl, Größe, Kompressionsrate", () => {
    expect(() => extractZip(sample, { limits: { maxEntries: 1 } })).toThrow(ZipError);
    expect(() => extractZip(sample, { limits: { maxEntryBytes: 100 } })).toThrow(/larger than/);
    expect(() => extractZip(sample, { limits: { maxTotalBytes: 1000 } })).toThrow(/in total/);
    const bomb = zipSync({ "zeros.bin": [new Uint8Array(2_000_000), { level: 9 }] });
    expect(() => extractZip(bomb, { limits: { maxRatio: 100 } })).toThrow(/expands/);
  });

  it("verschlüsselte und unbekannt komprimierte Einträge werden gemeldet, nicht entpackt", () => {
    let z = patchCentral(sample, "a.md", (v, at) => v.setUint16(at + 8, v.getUint16(at + 8, true) | 1, true));
    z = patchCentral(z, "dir/b.txt", (v, at) => v.setUint16(at + 10, 12, true));
    const r = extractZip(z);
    expect(r.skipped).toContain("a.md — encrypted");
    expect(r.skipped).toContain("dir/b.txt — compression method 12");
  });

  it("kaputte Daten und Abbruch", () => {
    expect(() => readZipEntries(enc.encode("not a zip at all, definitely"))).toThrow(/not a ZIP/);
    const bad = sample.slice();
    bad[40] = bad[40]! ^ 0xff; // Bytes in a.md (gespeichert) → CRC passt nicht
    expect(() => extractZip(bad)).toThrow(ZipError);
    expect(() => extractZip(sample, { isCancelled: () => true })).toThrow(ImportCancelled);
  });
});

describe("Import im Worker: prepare, dann commit", () => {
  const files = new ImportFiles([
    ["Export/Page 11111111111111111111111111111111.html", enc.encode(`<html><body><article class="page sans"><header><h1 class="page-title">Page</h1></header>
      <div class="page-body"><p>Hello <strong>world</strong></p><figure class="image"><img src="Page%2011111111111111111111111111111111/pic.png"/></figure></div></article></body></html>`)],
    ["Export/Page 11111111111111111111111111111111/pic.png", new Uint8Array([1, 2, 3])],
    ["Export/Notes.md", enc.encode("# Notes\n\n- one\n- two")],
  ]);

  it("Fortschritt steigt bis 1, Ergebnis wie in einem Schritt, Records strukturiert klonbar", () => {
    const steps: number[] = [];
    const sink = new MemoryAssetSink();
    const prepared = prepareImport([{ files, path: "Export" }], { assets: sink, progress: (f) => steps.push(f) });
    expect(steps.at(-1)).toBe(1);
    expect(steps.every((x, i) => i === 0 || x >= steps[i - 1]!)).toBe(true);
    const cloned = structuredClone(prepared.markdown);
    expect(cloned?.records.length).toBeGreaterThan(0);
    const s = store();
    const r = commitPreparedImport(s, prepared);
    expect(r.pages).toBe(2);
    expect(sink.files.size).toBe(1);
    const page = s.blocks.get("11111111-1111-1111-1111-111111111111")!;
    expect(page.text).toBe("Page");
    const titles = [...s.blocks.values()].map((b) => b.text);
    expect(titles).toContain("Notes");
    // Wurzeln liegen nach der HTML-Seite, ohne doppelte Sortierschlüssel.
    const roots = s.children("w").map((id) => s.blocks.get(id)!.sk);
    expect(new Set(roots).size).toBe(roots.length);
  });

  it("Abbruch wirft ImportCancelled, der Store bleibt unberührt", () => {
    const s = store();
    expect(() => importNotionItems(s, [{ files, path: "Export" }], { isCancelled: () => true })).toThrow(ImportCancelled);
    expect(s.blocks.size).toBe(0);
  });
});

describe("Export und Archiv", () => {
  it("Export-ZIP mit eindeutigen Namen und Fehlerbericht für fehlende Dateien", () => {
    const s = store();
    s.transact("init", (tx) => {
      for (const [id, title] of [["a", "Notes"], ["b", "notes"]]) tx.put({ kind: "block", data: { id: id!, type: "page", parent: "w", sk: "a" + id, text: title!, createdAt: 0, updatedAt: 0 } });
      tx.put({ kind: "block", data: { id: "img", type: "image", parent: "b:a", sk: "a0", props: { asset: { id: "x1", name: "p.png" } }, createdAt: 0, updatedAt: 0 } });
      tx.put({ kind: "block", data: { id: "img2", type: "image", parent: "b:b", sk: "a0", props: { asset: { id: "x2", name: "p.png" } }, createdAt: 0, updatedAt: 0 } });
    });
    const plan = planWorkspaceExport(s, topLevelPages(s), "markdown");
    expect(plan.files.map((f) => f.path)).toEqual(["Notes.md", "notes (2).md"]);
    expect(plan.assets.map((a) => a.path)).toEqual(["assets/p.png", "assets/p (2).png"]);
    const { zip, report } = writeExportZip(plan, (ref) => (ref.id === "x1" ? new Uint8Array([7]) : undefined), new Date(0));
    expect(report.pages).toBe(2);
    expect(report.assets).toBe(1);
    expect(report.failures[0]?.path).toBe("assets/p (2).png");
    expect(extractZip(zip).files.read("assets/p.png")).toEqual(new Uint8Array([7]));
  });

  it(".based.zip hin und zurück, Herkunft import", () => {
    const src = store();
    src.transact("init", (tx) => {
      tx.put({ kind: "block", data: { id: "p", type: "page", parent: "w", sk: "a0", text: "Restored", createdAt: 0, updatedAt: 0 } });
      tx.put({ kind: "block", data: { id: "i", type: "image", parent: "b:p", sk: "a0", props: { asset: { id: "as1", name: "a.png" } }, createdAt: 0, updatedAt: 0 } });
    });
    const pkg = writeArchivePackage(src, () => new Uint8Array([1, 2]));
    expect(pkg.assets).toBe(1);
    const loaded = loadArchive(pkg.zip);
    expect(loaded.assets.map((a) => a.ref.id)).toEqual(["as1"]);
    const dst = store();
    const origins: string[] = [];
    dst.observe((c) => origins.push(c.origin));
    const r = importArchiveRecords(dst, loaded.read);
    expect(r.imported).toBeGreaterThan(1);
    expect(origins).toContain("import");
    expect(dst.blocks.get("p")?.stamp).toEqual(src.blocks.get("p")?.stamp);
    expect(dst.canUndo).toBe(false);
  });
});
