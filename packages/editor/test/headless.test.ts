// @vitest-environment node
// BSD-220: `@based/editor/headless` läuft ohne DOM, und die Typ-Fassade (headless-api.ts) passt zur Laufzeit.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as runtime from "../src/headless.js";
import type * as api from "../src/headless-api.js";

// Typprüfung (tsc): jede Laufzeit-Funktion erfüllt ihre Deklaration und umgekehrt.
const _check: typeof api.createConverter = runtime.createConverter;
const _back: typeof runtime.createConverter = runtime.createConverter as typeof api.createConverter;
void _check;
void _back;

describe("@based/editor/headless", () => {
  it("Konverter ohne DOM: Blöcke → Y-XML → Blöcke", () => {
    const c = runtime.createConverter();
    const doc = new Y.Doc();
    const f = doc.getXmlFragment(runtime.FRAGMENT);
    c.toFragment([{ id: "a", type: "paragraph", props: {}, content: [{ type: "text", text: "Hallo", styles: { bold: true } }], children: [] }], f);
    const back = c.fromFragment(f);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: "a", type: "paragraph", content: [{ type: "text", text: "Hallo", styles: { bold: true } }] });
  });
});
