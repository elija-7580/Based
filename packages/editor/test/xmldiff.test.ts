// BSD-154: kleinster Diff zwischen Y-XML-Bäumen.
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { syncChildren } from "../src/yjs/xmldiff.js";

function tree(doc: Y.Doc, items: [string, string, Record<string, string>?][]) {
  const f = doc.getXmlFragment("f");
  doc.transact(() => {
    f.delete(0, f.length);
    f.insert(0, items.map(([id, text, attrs]) => {
      const el = new Y.XmlElement("blockcontainer");
      el.setAttribute("id", id);
      for (const [k, v] of Object.entries(attrs ?? {})) el.setAttribute(k, v);
      const t = new Y.XmlText();
      t.insert(0, text);
      el.insert(0, [t]);
      return el;
    }));
  });
  return f;
}

describe("syncChildren", () => {
  it("gleicht Reihenfolge, Text und Attribute an und lässt Unverändertes stehen", () => {
    const live = new Y.Doc(), target = new Y.Doc();
    const lf = tree(live, [["a", "Alpha"], ["b", "Beta"], ["c", "Gamma"]]);
    const keep = lf.get(0);
    const tf = tree(target, [["c", "Gamma"], ["a", "Alpha!"], ["d", "Delta", { level: "2" }]]);
    live.transact(() => syncChildren(lf, tf));
    expect(lf.toString()).toBe(tf.toString());
    expect(lf.toArray().includes(keep)).toBe(true); // „a“ wurde angepasst, nicht ersetzt
  });

  it("Textänderung in der Mitte behält Formatierung", () => {
    const live = new Y.Doc(), target = new Y.Doc();
    const lt = live.getText("t"), tt = target.getText("t");
    lt.insert(0, "Hallo ");
    lt.insert(6, "Welt", { bold: true });
    tt.insert(0, "Hallo schöne ");
    tt.insert(13, "Welt", { bold: true });
    const lx = new Y.XmlText(), tx = new Y.XmlText();
    live.getXmlFragment("f").insert(0, [lx]);
    target.getXmlFragment("f").insert(0, [tx]);
    lx.applyDelta(lt.toDelta());
    tx.applyDelta(tt.toDelta());
    live.transact(() => syncChildren(live.getXmlFragment("f"), target.getXmlFragment("f")));
    expect(lx.toDelta()).toEqual(tx.toDelta());
  });
});
