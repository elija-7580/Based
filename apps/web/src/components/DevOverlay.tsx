// BSD-319: Entwickler-Ansicht (Settings → Diagnostics → For developers): Blockgrenzen und Fokus per CSS, schwebende
// Ebenen als Rahmen mit z-index, die letzten Ereignisse der Aufzeichnung. Fängt keine Klicks ab und landet weder im
// Layout-Schnappschuss noch im Bildschirmfoto eines Berichts.
import type { LayoutItem, RecordedEvent } from "@based/core";
import { formatHangMs, scrambleText } from "@based/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { layoutSnapshot, onRecorded, REPORT_EXCLUDE } from "../shell/bugReport.js";
import { devViewPref } from "../shell/storage.js";
import { hangMonitor } from "../shell/hangs.js";

const summary = (e: RecordedEvent): string => {
  switch (e.kind) {
    case "key": {
      const m = e.mods;
      const printable = [...e.key].length === 1 && !m.meta && !m.ctrl && !m.alt;
      return `key ${m.meta ? "⌘" : ""}${m.ctrl ? "⌃" : ""}${m.alt ? "⌥" : ""}${m.shift ? "⇧" : ""}${printable ? scrambleText(e.key) : e.key}`;
    }
    case "input": return `input ${e.inputType}`;
    case "composition": return `ime ${e.phase}`;
    case "paste": return `paste${e.html ? " html" : ""}${e.files ? ` ${e.files} files` : ""}`;
    case "select": return `select ${e.sel.block ? `${e.sel.block.slice(0, 6)} ` : ""}${e.sel.blocks ? `${e.sel.blocks.length} blocks` : `${e.sel.anchor}–${e.sel.head}`} (${e.cause})`;
    case "pointer": return `pointer ${e.phase} ${e.target}`;
    case "tr": return `tr ${e.docChanged ? "change" : "selection"} → ${e.sel.anchor}${e.sel.head !== e.sel.anchor ? `–${e.sel.head}` : ""}${e.meta ? ` [${e.meta.join(", ")}]` : ""}`;
    case "yjs": return `yjs ${e.bytes} B (${e.origin})`;
    case "change": {
      const n = Array.isArray(e.changes) ? e.changes.length : 0;
      return `change ${e.name ?? e.origin}${e.name && e.origin !== "local" ? ` (${e.origin})` : ""} · ${n} block${n === 1 ? "" : "s"}`;
    }
    case "focus": return `focus ${e.target}`;
    case "checkpoint": return `checkpoint ${e.root.slice(0, 8)}`;
  }
};

export function DevOverlay() {
  const on = useSyncExternalStore(devViewPref.subscribe, devViewPref.get);
  const [events, setEvents] = useState<string[]>([]);
  const [layers, setLayers] = useState<LayoutItem[]>([]);
  // BSD-418: der letzte Hänger live (Dauer, Quelle, Aktivität, Ursache)
  const lastHang = useSyncExternalStore(hangMonitor.subscribe, hangMonitor.getSnapshot).at(-1);
  useEffect(() => {
    const root = document.documentElement;
    if (!on) {
      delete root.dataset.devView;
      return;
    }
    root.dataset.devView = "";
    const off = onRecorded((e) => setEvents((prev) => [...prev.slice(-11), summary(e)]));
    const tick = () => setLayers(layoutSnapshot().filter((i) => i.kind === "floating" || i.kind === "handle"));
    tick();
    const id = setInterval(tick, 1500);
    return () => {
      off();
      clearInterval(id);
      delete root.dataset.devView;
    };
  }, [on]);
  if (!on) return null;
  return (
    <div className="dev-overlay" aria-hidden="true" {...{ [REPORT_EXCLUDE]: "" }} data-testid="dev-overlay">
      {layers.map((l, i) => (
        <div key={i} className="dev-layer" style={{ left: l.rect.x, top: l.rect.y, width: l.rect.w, height: l.rect.h }}>
          <span className="dev-layer-tag">{`${l.label} · z ${l.z ?? "auto"}${l.opaque ? " · opaque" : ""}`}</span>
        </div>
      ))}
      <div className="dev-events" data-testid="dev-events">
        <div className="dev-events-head">Developer view · last events</div>
        {lastHang ? <div className="dev-event" data-testid="dev-last-hang">{`Last hang ${formatHangMs(lastHang.ms)} · ${lastHang.source}${lastHang.activity ? ` · ${lastHang.activity}` : ""}${lastHang.culprit ? ` · ${lastHang.culprit}` : ""}`}</div> : null}
        {events.length === 0 ? <div className="dev-event">Type or click in a page</div> : events.map((e, i) => <div key={i} className="dev-event">{e}</div>)}
      </div>
    </div>
  );
}
