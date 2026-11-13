// ADR 0016 (E7): Echtzeit im neuen Editor – Y.Text je Block über `/collab` (TextSession, Rolle Gerät) und Präsenz:
// wo die anderen gerade schreiben (farbige Schreibmarke mit Namen). Ohne `collab` (aus, kein Server, offline) läuft
// der Editor wie bisher nur über Records und Sync v2.
import type { WorkspaceStore } from "@based/core";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CollabSource, PresenceChannel } from "../yjs/collab.js";
import { TextSession } from "../yjs/text-session.js";
import type { EditorController } from "./controller.js";
import { pointAt, selectionIn } from "./dom.js";

/** Was ein Gerät über sich verrät (Awareness): Knoten, Name, Schreibmarke. */
interface PeerState {
  node?: string;
  name?: string;
  cursor?: { block: string; from: number; to: number } | null;
}

const PEER_COLORS = 6;
const colorOf = (node: string) => {
  let h = 0;
  for (let i = 0; i < node.length; i++) h = (h * 31 + node.charCodeAt(i)) >>> 0;
  return h % PEER_COLORS;
};

/**
 * Verbindet den Editor mit dem Echtzeit-Dokument der Seite. Liefert den Präsenz-Kanal (oder `undefined`).
 * Änderungen anderer verschieben die eigene Schreibmarke mit (Delta von Y.Text), statt sie springen zu lassen.
 */
export function useRealtime(store: WorkspaceStore, pageID: string, collab: CollabSource | undefined, ctrl: EditorController, name: string | undefined): PresenceChannel | undefined {
  const [presence, setPresence] = useState<PresenceChannel | undefined>();
  useEffect(() => {
    if (!collab) return;
    let closed = false;
    let release: (() => void) | undefined;
    let session: TextSession | undefined;
    let channel: PresenceChannel | undefined;
    void collab.open(pageID).then((h) => {
      if (!h) return;
      if (closed) {
        h.release();
        return;
      }
      release = () => h.release();
      session = new TextSession(store, pageID, {
        doc: h.doc,
        role: "device",
        onRemoteEdit: (id, delta) => ctrl.shiftCaret(id, delta),
      });
      channel = h.presence;
      channel?.setLocalStateField("node", store.clock.node);
      channel?.setLocalStateField("name", name ?? "Someone");
      setPresence(channel);
    }).catch(() => undefined);
    return () => {
      closed = true;
      channel?.setLocalStateField("cursor", null);
      session?.close();
      release?.();
      setPresence(undefined);
    };
  }, [collab, store, pageID, ctrl, name]);

  // Eigene Schreibmarke veröffentlichen (höchstens einmal pro Frame).
  useEffect(() => {
    if (!presence || !ctrl.root) return;
    const doc = ctrl.root.ownerDocument;
    let frame = 0;
    const publish = () => {
      frame = 0;
      const field = doc.activeElement instanceof HTMLElement ? doc.activeElement.closest<HTMLElement>("[data-editable-id]") : null;
      const id = field?.dataset.editableId;
      const sel = field ? selectionIn(field) : undefined;
      presence.setLocalStateField("cursor", id && sel && ctrl.root?.contains(field) ? { block: id, from: sel.from, to: sel.to } : null);
    };
    const onSel = () => {
      if (!frame) frame = requestAnimationFrame(publish);
    };
    doc.addEventListener("selectionchange", onSel);
    return () => {
      doc.removeEventListener("selectionchange", onSel);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [presence, ctrl]);
  return presence;
}

interface Mark { key: number; color: number; name: string; left: number; top: number; height: number; boxes: { left: number; top: number; width: number; height: number }[] }

/** Schreibmarken der anderen über dem Editor (Koordinaten relativ zum Editor). */
export function PresenceLayer({ presence, ctrl, store, root }: { presence: PresenceChannel; ctrl: EditorController; store: WorkspaceStore; root: HTMLElement | null }) {
  const version = useSyncExternalStore(
    (fn) => {
      presence.on("change", fn);
      const off = store.observe(() => fn());
      return () => { presence.off("change", fn); off(); };
    },
    () => presenceVersion(presence, store),
  );
  const [marks, setMarks] = useState<Mark[]>([]);
  const last = useRef("");
  useLayoutEffect(() => {
    if (!root) return;
    const box = root.getBoundingClientRect();
    const out: Mark[] = [];
    for (const [client, raw] of presence.getStates()) {
      if (client === presence.clientID) continue;
      const st = raw as PeerState;
      const c = st.cursor;
      if (!c || !st.node) continue;
      const el = ctrl.editable(c.block);
      if (!el || !el.isConnected) continue;
      const range = el.ownerDocument.createRange();
      try {
        const a = pointAt(el, c.from), b = pointAt(el, Math.max(c.from, c.to));
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);
      } catch {
        continue;
      }
      const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0);
      const caret = (() => {
        const r2 = range.cloneRange();
        r2.collapse(false);
        return r2.getClientRects()[0] ?? rects[rects.length - 1] ?? el.getBoundingClientRect();
      })();
      out.push({
        key: client,
        color: colorOf(st.node),
        name: st.name ?? "Someone",
        left: caret.right - box.left,
        top: caret.top - box.top,
        height: caret.height || 20,
        boxes: c.to > c.from ? rects.map((r) => ({ left: r.left - box.left, top: r.top - box.top, width: r.width, height: r.height })) : [],
      });
    }
    const sig = JSON.stringify(out);
    if (sig !== last.current) {
      last.current = sig;
      setMarks(out);
    }
  }, [version, root, presence, ctrl]);
  return (
    <div className="bx2-presence" aria-hidden="true" data-testid="presence">
      {marks.map((m) => (
        <div key={m.key} className={"bx2-peer bx2-peer-" + m.color} data-peer={m.name}>
          {m.boxes.map((b, i) => <div key={i} className="bx2-peer-sel" style={{ left: b.left, top: b.top, width: b.width, height: b.height }} />)}
          <div className="bx2-peer-caret" style={{ left: m.left, top: m.top, height: m.height }}>
            <div className="bx2-peer-name">{m.name}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

let counter = 0;
const versions = new WeakMap<object, { sig: string; v: number }>();
/** Ändert sich, wenn sich Präsenz oder Store ändern (für useSyncExternalStore ohne neue Objekte pro Abfrage). */
function presenceVersion(presence: PresenceChannel, store: WorkspaceStore): number {
  const sig = JSON.stringify([...presence.getStates()].map(([k, v]) => [k, (v as PeerState).cursor ?? null])) + ":" + storeTick(store);
  const cur = versions.get(presence);
  if (cur && cur.sig === sig) return cur.v;
  const next = { sig, v: ++counter };
  versions.set(presence, next);
  return next.v;
}

const ticks = new WeakMap<WorkspaceStore, { n: number }>();
function storeTick(store: WorkspaceStore): number {
  let t = ticks.get(store);
  if (!t) {
    const tick = { n: 0 };
    ticks.set(store, (t = tick));
    store.observe(() => { tick.n++; });
  }
  return t.n;
}
