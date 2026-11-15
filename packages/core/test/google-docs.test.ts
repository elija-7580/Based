// BSD-260 Teil 11: Google Docs als „Webseite (.html, gezippt)“ – Fett/Kursiv/Unterstrichen/Durchgestrichen stehen dort
// in Klassen-Regeln im <style> (`.c3{font-weight:700}`), Links sind über google.com/url?q=… umgeleitet. Notion-HTML
// bleibt unverändert (die Regeln gelten nur für allgemeines HTML).
import { describe, expect, it } from "vitest";
import { classRules, ImportFiles, prepareImport, preparedImportToWire, unwrapRedirect, type Block } from "../src/index.js";
import type { Run } from "../src/interop/runs.js";

function blocks(files: Record<string, string>) {
  const tree = new ImportFiles();
  for (const [p, d] of Object.entries(files)) tree.add(p, new TextEncoder().encode(d));
  const w = preparedImportToWire(prepareImport([{ files: tree, path: "Doc" }], { userID: null }));
  return (w.builder?.blocks ?? []) as Block[];
}
const runs = (b: Block | undefined) => (typeof b?.text === "string" ? [{ t: b.text }] : (b?.text ?? [])) as Run[];

const GDOC = `<html><head><meta content="text/html; charset=UTF-8" http-equiv="content-type"><style type="text/css">
ol{margin:0;padding:0}.c1{font-weight:700;color:#000000}.c2{font-style:italic}.c5,.c6{text-decoration:underline}
.c7{text-decoration:line-through}.c0{font-weight:400;font-style:normal}/* Kommentar */.title{font-size:26pt}
p.c9{margin:0}</style><title>Roadmap</title></head><body class="c8 doc-content">
<p class="c9"><span class="c0">Plain </span><span class="c1">bold</span><span class="c0"> and </span><span class="c2">italic</span><span class="c0">, </span><span class="c5">under</span><span class="c0"> </span><span class="c7">gone</span></p>
<p class="c9"><span class="c0">Inline </span><span style="font-weight:700">bold</span><span class="c0"> via style, </span><b style="font-weight:normal">not bold</b></p>
<p class="c9"><span class="c0"><a class="c4" href="https://www.google.com/url?q=https://example.org/plan&amp;sa=D&amp;source=editors&amp;ust=1&amp;usg=AOv">the plan</a></span></p>
</body></html>`;

describe("Google Docs (HTML)", () => {
  it("Klassen-Regeln: Fett, Kursiv, Unterstrichen, Durchgestrichen; Inline-Stil; font-weight:normal hebt <b> auf", () => {
    const bs = blocks({ "Doc/Roadmap.html": GDOC });
    const page = bs.find((b) => b.type === "page");
    expect(runs(page).map((r) => r.t).join("")).toBe("Roadmap");
    const paras = bs.filter((b) => b.parent === "b:" + page!.id);
    const marks = (b: Block | undefined) => runs(b).filter((r) => r.t.trim() !== "").map((r) => [r.t.trim(), Object.keys(r.m ?? {}).filter((k) => k !== "link").sort().join("")]);
    expect(marks(paras[0])).toEqual([["Plain", ""], ["bold", "b"], ["and", ""], ["italic", "i"], [",", ""], ["under", "u"], ["gone", "s"]]);
    expect(marks(paras[1])).toEqual([["Inline", ""], ["bold", "b"], ["via style, not bold", ""]]); // <b style="font-weight:normal"> ist nicht fett
    const link = runs(paras[2]).find((r) => r.t === "the plan");
    expect(link?.m?.link).toBe("https://example.org/plan");
  });

  it("Notion-HTML bleibt wie es ist (keine Klassen-Regeln, Links unverändert)", () => {
    const notion = `<html><head><style>.c1{font-weight:700}</style></head><body><article class="page"><header><h1 class="page-title">N</h1></header>
      <div class="page-body"><p><span class="c1">x</span> <a href="https://www.google.com/url?q=https://a.b">l</a></p></div></article></body></html>`;
    const bs = blocks({ "Doc/N.html": notion });
    const p = bs.find((b) => b.type === "text");
    expect(runs(p).find((r) => r.t === "x")?.m?.b).toBeUndefined();
    expect(runs(p).find((r) => r.t === "l")?.m?.link).toBe("https://www.google.com/url?q=https://a.b");
  });

  it("Helfer", () => {
    const r = classRules(".a,.b{font-weight:700} span.c{font-style:italic} #x{color:red} .d .e{font-weight:700}");
    expect([...r.keys()].sort()).toEqual(["a", "b", "c"]);
    expect(unwrapRedirect("https://www.google.com/url?q=https://x.org/a?b%3D1&sa=D")).toBe("https://x.org/a?b=1");
    expect(unwrapRedirect("https://www.google.com/url?q=javascript:alert(1)")).toBe("https://www.google.com/url?q=javascript:alert(1)");
    expect(unwrapRedirect("https://example.org/url?q=https://x")).toBe("https://example.org/url?q=https://x");
    expect(unwrapRedirect("relative.html")).toBe("relative.html");
  });
});
