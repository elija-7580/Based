// BSD-10: Gleichungen offline mit KaTeX (MIT). Schriften und CSS kommen aus dem Paket und werden von Vite
// mitgebündelt – kein CDN, kein Netzzugriff. Ein Fehler im TeX wird angezeigt statt zu werfen.
// BSD-280: KaTeX (≈ 0,6 MB) wird erst geladen, wenn die erste Gleichung erscheint – nicht im Start-Bundle.
import "./equation.css";
import { memo, useEffect, useState } from "react";

type KaTeX = typeof import("katex").default;
let katex: KaTeX | undefined;
let loading: Promise<void> | undefined;
/** KaTeX samt CSS nachladen (einmal). */
export function loadTeX(): Promise<void> {
  return (loading ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => { katex = m.default; }));
}
export const texReady = () => katex !== undefined;

export type TeXResult = { html: string } | { error: string };

const cache = new Map<string, TeXResult>();

/** TeX → HTML (KaTeX). `trust: false`: keine Links/HTML aus dem Ausdruck. Ergebnisse werden zwischengespeichert. */
export function renderTeX(expression: string, displayMode: boolean): TeXResult {
  const key = (displayMode ? "D" : "I") + expression;
  const hit = cache.get(key);
  if (hit) return hit;
  if (!katex) return { error: "loading" };
  let out: TeXResult;
  try {
    out = { html: katex.renderToString(expression, { displayMode, throwOnError: true, trust: false, strict: "ignore", output: "htmlAndMathml" }) };
  } catch (e) {
    out = { error: e instanceof Error ? e.message.replace(/^KaTeX parse error:\s*/, "") : String(e) };
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, out);
  return out;
}

/** Gleichung für `renderEquation` des Editors (Block und im Text). */
export const Equation = memo(function Equation({ expression, displayMode }: { expression: string; displayMode: boolean }) {
  const [ready, setReady] = useState(texReady);
  useEffect(() => {
    if (ready) return;
    let live = true;
    void loadTeX().then(() => { if (live) setReady(true); }, () => undefined);
    return () => { live = false; };
  }, [ready]);
  if (!ready) return <span className={"eq is-loading" + (displayMode ? " is-block" : "")} data-testid="equation-loading"><code className="t-code">{expression}</code></span>;
  const r = renderTeX(expression, displayMode);
  if ("error" in r) {
    return (
      <span className={"eq-error" + (displayMode ? " is-block" : "")} role="alert" data-testid="equation-error" title={r.error}>
        <code className="t-code">{expression}</code>
        <span className="eq-error-text">{r.error}</span>
      </span>
    );
  }
  return <span className={"eq" + (displayMode ? " is-block" : "")} data-testid="equation" dangerouslySetInnerHTML={{ __html: r.html }} />;
});
