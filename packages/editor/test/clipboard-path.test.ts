// BSD-211: Die Clipboard-Fixtures (Swift) zusätzlich durch den Editor-Pfad: HTML → BlockNote-Blöcke → Records.
// Verglichen werden Blocktyp, Text, Häkchen und Verschachtelung mit dem, was der Kern-Importer laut Fixture liefert.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MemoryPersistence, plainText, WorkspaceStore, type Block, type RichText, type WireRecord } from "@based/core";
import { htmlToBlocks } from "../src/ui/paste.js";
import { applyDocChanges, materializeDoc } from "../src/mapping/materialize.js";

interface Expected { type: string; text?: RichText; props?: { checked?: boolean }; children?: Expected[] }
const fixtures = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/clipboard/clipboard.json"), "utf8")) as {
  cases: { name: string; input: { op: string; html: string }; output: { blocks?: Expected[] } }[];
};

type Shape = { type: string; text: string; checked?: boolean; children: Shape[] };
const shapeExpected = (b: Expected): Shape => ({
  type: b.type, text: plainText(b.text), ...(b.props?.checked !== undefined ? { checked: b.props.checked } : {}), children: (b.children ?? []).map(shapeExpected),
});

const page: WireRecord = { kind: "block", data: { id: "P", type: "page", parent: "w", sk: "a0", createdAt: 0, updatedAt: 0 } };

function viaEditor(html: string): Shape[] {
  let n = 0;
  const blocks = htmlToBlocks(html, () => true, () => "id-" + ++n);
  const store = new WorkspaceStore({ persistence: new MemoryPersistence([page]), node: "t", now: () => 5 });
  applyDocChanges(store, materializeDoc(store, "P", blocks, { now: 5, newID: () => "row-" + ++n }));
  const tree = (parent: string): Shape[] => store.children(parent).map((id) => {
    const b = store.blocks.get(id) as Block;
    const checked = (b.props as { checked?: boolean } | undefined)?.checked;
    return { type: b.type, text: plainText(b.text), ...(b.type === "todo" ? { checked: checked === true } : {}), children: b.type === "table" ? [] : tree("b:" + id) };
  });
  return tree("b:P");
}

describe("Clipboard-Fixtures durch den Editor", () => {
  for (const c of fixtures.cases.filter((x) => x.input.op === "parse" && x.output.blocks)) {
    it(c.name, () => {
      const want = c.output.blocks!.map(shapeExpected).map((s) => (s.type === "table" ? { ...s, children: [] } : s));
      expect(viaEditor(c.input.html)).toEqual(want);
    });
  }
});
