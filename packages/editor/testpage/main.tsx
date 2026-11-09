// BSD-154: Testseite für den Editor. Records und Y-Zustände liegen in localStorage, damit „neu laden“ echt ist.
// ?reset=1 setzt die Beispieldaten zurück, ?page=<id> öffnet eine andere Seite.
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceStore, type Persistence, type RecordKeyString, type WireRecord, recordKey, type Block } from "@based/core";
import { PageEditor, type YDocStore } from "../src/index.js";
import corpus from "../../../fixtures/records/corpus.jsonl?raw";
import "./page.css";

const RECORDS = "based-e2e-records";
const YDOCS = "based-e2e-ydoc:";

class LocalPersistence implements Persistence {
  private records = new Map<string, WireRecord>();
  constructor() {
    for (const r of JSON.parse(localStorage.getItem(RECORDS) ?? "[]") as WireRecord[]) this.records.set(recordKey(r), r);
  }
  loadAll() {
    return [...this.records.values()].map((r) => structuredClone(r));
  }
  write(upserts: WireRecord[], deletions: RecordKeyString[]) {
    for (const r of upserts) this.records.set(recordKey(r), structuredClone(r));
    for (const k of deletions) this.records.delete(k);
    localStorage.setItem(RECORDS, JSON.stringify([...this.records.values()]));
  }
  tombstone() {
    return undefined;
  }
}

const docStore: YDocStore = {
  load(id) {
    const s = localStorage.getItem(YDOCS + id);
    return s ? Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) : undefined;
  },
  save(id, state) {
    let bin = "";
    for (const b of state) bin += String.fromCharCode(b);
    localStorage.setItem(YDOCS + id, btoa(bin));
  },
};

/** Swift-Korpus (alle Blocktypen) plus die Testseiten. */
function corpusRecords(): WireRecord[] {
  return corpus.split("\n").filter(Boolean).map((l) => JSON.parse(l) as WireRecord);
}

function seed(): WireRecord[] {
  const t = 800_000_000;
  const b = (id: string, type: string, parent: string, sk: string, extra: Partial<Block> = {}): WireRecord =>
    ({ kind: "block", data: { id, type, parent, sk, createdAt: t, updatedAt: t, ...extra } as Block });
  return [
    b("p-test", "page", "w", "a0", { text: "Testseite" }),
    b("t-1", "text", "b:p-test", "a0", { text: "Erster Absatz" }),
    b("t-2", "text", "b:p-test", "a1", { text: "Zweiter Absatz" }),
    b("t-3", "text", "b:p-test", "a2", { text: "Dritter Absatz" }),
    b("p-other", "page", "w", "a1", { text: "Andere Seite" }),
    b("o-1", "text", "b:p-other", "a0", { text: "Text auf der anderen Seite" }),
  ];
}

const params = new URLSearchParams(location.search);
if (params.has("reset") || !localStorage.getItem(RECORDS)) {
  for (const k of Object.keys(localStorage)) if (k === RECORDS || k.startsWith(YDOCS)) localStorage.removeItem(k);
  localStorage.setItem(RECORDS, JSON.stringify([...seed(), ...(params.has("corpus") ? corpusRecords() : [])]));
}
const store = new WorkspaceStore({ persistence: new LocalPersistence(), node: "e2e" });
(window as unknown as { __based: unknown }).__based = { store };

function App() {
  const [page, setPage] = useState(params.get("page") ?? "p-test");
  return (
    <main className="page" data-testid="page">
      <PageEditor key={page} store={store} pageID={page} docStore={docStore} onOpenPage={setPage}
        people={[{ id: "user-1", name: "Elija" }]}
        renderEquation={({ expression }) => <span data-testid="equation">{expression}</span>} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
