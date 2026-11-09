// BSD-10: Gleichungen offline mit KaTeX (MIT). Schriften und CSS kommen aus dem Paket und werden von Vite
// mitgebündelt – kein CDN, kein Netzzugriff. Ein Fehler im TeX wird angezeigt statt zu werfen.
import katex from "katex";
import "katex/dist/katex.min.css";
import "./equation.css";
import { memo } from "react";

export type TeXResult = { html: string } | { error: string };

const cache = new Map<string, TeXResult>();

/** TeX → HTML (KaTeX). `trust: false`: keine Links/HTML aus dem Ausdruck. Ergebnisse werden zwischengespeichert. */
export function renderTeX(expression: string, displayMode: boolean): TeXResult {
  const key = (displayMode ? "D" : "I") + expression;
  const hit = cache.get(key);
  if (hit) return hit;
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
