// BSD-314: echtes Terminal der Coding-Sitzung (xterm.js, MIT). Verbindet sich per WebSocket mit
// /coding/terminal/<sitzung> auf dem Server; das Token geht als erste Nachricht, nie in der URL. Farben aus den
// Tokens (hell/dunkel), Größe folgt dem Fenster. xterm wird erst geladen, wenn das Terminal aufgeht.
import { Banner } from "@astryxdesign/core/Banner";
import { useEffect, useRef, useState } from "react";
import type { CodingModel } from "./model.js";

function themeFromTokens(el: HTMLElement) {
  const css = getComputedStyle(el);
  const v = (name: string) => css.getPropertyValue(name).trim() || undefined;
  return { background: v("--surface-raised") ?? v("--bg"), foreground: v("--ink"), cursor: v("--ink"), selectionBackground: v("--marker") };
}

export function TerminalView({ model, sessionId }: { model: CodingModel; sessionId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();
  const [ended, setEnded] = useState(false);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([import("@xterm/xterm"), import("@xterm/addon-fit"), import("@xterm/xterm/css/xterm.css")]);
      if (disposed) return;
      const term = new Terminal({ fontFamily: getComputedStyle(el).getPropertyValue("--font-mono").trim() || "monospace", fontSize: 13, cursorBlink: true, theme: themeFromTokens(el), allowProposedApi: false });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);
      fit.fit();
      const { url, token } = model.client.opts;
      const ws = new WebSocket(url.replace(/\/+$/, "").replace(/^http/, "ws") + `/coding/terminal/${encodeURIComponent(sessionId)}`);
      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token, cols: term.cols, rows: term.rows }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data)) as { type: string; data?: string; code?: number; message?: string };
        if (m.type === "output" && m.data) term.write(m.data);
        else if (m.type === "exit") setEnded(true);
        else if (m.type === "error") setError(m.message ?? "Terminal error");
      };
      ws.onclose = (e) => { if (e.code !== 1000 && e.code !== 1005 && !disposed) setEnded(true); };
      const input = term.onData((data) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data })); });
      const resize = term.onResize(({ cols, rows }) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows })); });
      const ro = new ResizeObserver(() => { try { fit.fit(); } catch { /* unsichtbar */ } });
      ro.observe(el);
      // Hell/dunkel umgeschaltet: Farben neu aus den Tokens
      const mo = new MutationObserver(() => { term.options.theme = themeFromTokens(el); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
      term.focus();
      cleanup = () => { ro.disconnect(); mo.disconnect(); input.dispose(); resize.dispose(); ws.close(1000); term.dispose(); };
    })().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => { disposed = true; cleanup(); };
  }, [model, sessionId]);

  return (
    <>
      {error ? <Banner status="error" title="Terminal" description={error} /> : null}
      {ended && !error ? <Banner status="info" title="Terminal ended" description="The shell exited or the session ended." /> : null}
      <div ref={host} className="coding-terminal" data-testid="coding-terminal" />
    </>
  );
}
