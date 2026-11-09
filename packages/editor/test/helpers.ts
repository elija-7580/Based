// Testhilfen: Korpus aus fixtures/records (von Swift erzeugt) in einen Store laden.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryPersistence, parseRecord, WorkspaceStore, type WireRecord } from "@based/core";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/records/");

export function corpusRecords(): WireRecord[] {
  return readFileSync(fixtures + "corpus.jsonl", "utf8").split("\n").filter(Boolean).map((l) => parseRecord(JSON.parse(l)));
}

export function corpusStore(extra: WireRecord[] = []): WorkspaceStore {
  let t = 800_000_000;
  return new WorkspaceStore({ persistence: new MemoryPersistence([...corpusRecords(), ...extra]), node: "test", now: () => (t += 1) });
}
