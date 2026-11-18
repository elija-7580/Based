// ADR 0017 Stufe B, Messung: Öffnen voll geladen gegen nach Bedarf (Datei aus bench.ts, 20 000 Seiten × 25 Blöcke).
// Aufruf (aus apps/cli): node --expose-gc --import tsx ../../spikes/storage-bench/lazy-open.mts
import { copyFileSync } from "node:fs";
import { openNodeDatabase } from "../../packages/sync/src/drivers/node.ts";
import { openWorkspace } from "../../packages/sync/src/persistence.ts";
import { buildOutline, LinkIndex, pageTitles, unlinkedMentions } from "../../packages/core/src/index.ts";
const src = "/tmp/based-bench/w-20000x25.sqlite", path = "/tmp/based-bench/lazy-open.sqlite";
copyFileSync(src, path);
const mb = () => { (globalThis as { gc?: () => void }).gc?.(); return (process.memoryUsage().heapUsed / 1048576).toFixed(0) + " MB"; };
const t = <T,>(label: string, f: () => T): T => { const a = performance.now(); const r = f(); console.log(label.padEnd(58), (performance.now() - a).toFixed(0).padStart(6) + " ms", "· Heap", mb()); return r; };
for (const lazy of [false, true, true]) {
  console.log(lazy ? "— nach Bedarf" : "— voll geladen");
  const db = openNodeDatabase(path);
  const { store } = t("  öffnen", () => openWorkspace(db, { node: "bench", lazy, propertyRecords: false }));
  t("  Gliederung + Titel", () => { buildOutline(store); return Object.keys(pageTitles(store)).length; });
  const pages = [...store.skeletonBlocks()].map((b) => b.id);
  t("  50 Seiten öffnen (alle Blöcke darunter)", () => { let n = 0; for (let i = 0; i < 50; i++) n += store.descendants(pages[(i * 397) % pages.length]!).length; return n; });
  const links = t("  Link-Index bauen (erste Seite mit Backlinks)", () => LinkIndex.fromStore(store));
  t("  Backlinks einer Seite", () => links.backlinks(store, pages[5]!).length);
  t("  unverlinkte Erwähnungen einer Seite (je Seitenöffnen)", () => unlinkedMentions(store, pages[5]!).length);
  t("  in 20 Blöcken tippen", () => { for (let i = 0; i < 20; i++) { const id = store.children("b:" + pages[(i * 397) % pages.length]!)[0]!; store.setText(id, "typed " + i); } });
  console.log("  geladen", store.blocks.loadedSize, "von", store.blocks.size, "· alles nachgeladen:", store.fullLoads);
  db.close();
}
