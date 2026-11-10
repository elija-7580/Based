// BSD-201 Teil 2: Cover über dem Titel (Farbe, hochgeladenes Bild, Bild-Link; Verlauf aus Swift wird angezeigt) mit
// „Change cover“ und „Reposition“ (senkrecht ziehen), und das Bild-Icon. Werte wie Swift (PageCover, PageIcon).
import { useEffect, useRef, useState } from "react";
import { ASSET_URL_PREFIX } from "@based/editor";
import { pageCover, setCoverPosition, setPageCover, setPageIconImage, type CoverAsset, type PageCoverValue, type WorkspaceStore } from "@based/core";
import { assets } from "../assetBridge.js";

/** Farben fürs Cover: nur Töne, für die es Tokens gibt (Status-Tönungen); weitere Farben/Verläufe sind eine Designfrage. */
export const COVER_COLORS: { id: string; label: string; css: string }[] = [
  { id: "gray", label: "Gray", css: "var(--status-neutral)" },
  { id: "blue", label: "Blue", css: "var(--status-ready)" },
  { id: "pink", label: "Pink", css: "var(--status-review)" },
  { id: "orange", label: "Orange", css: "var(--status-blocked)" },
  { id: "default", label: "Plain", css: "var(--surface-raised)" },
];
const GRADIENTS = ["var(--status-ready), var(--status-review)", "var(--status-neutral), var(--status-ready)", "var(--status-review), var(--status-blocked)", "var(--status-blocked), var(--status-neutral)"];

export function coverBackground(c: PageCoverValue): string | undefined {
  if ("color" in c) return (COVER_COLORS.find((x) => x.id === c.color._0.replace(/Background$/, "")) ?? COVER_COLORS[4]!).css;
  if ("gradient" in c) return `linear-gradient(135deg, ${GRADIENTS[Math.abs(c.gradient._0) % GRADIENTS.length]})`;
  return undefined;
}

/** Bild-URL für ein Asset bzw. einen Link (Assets werden lokal aufgelöst). */
export function useImageURL(src: { asset: CoverAsset } | { url: string } | undefined): string | undefined {
  const key = src ? ("asset" in src ? "a:" + src.asset.id : "u:" + src.url) : "";
  const [url, setURL] = useState<string | undefined>();
  useEffect(() => {
    if (!src) { setURL(undefined); return; }
    if ("url" in src) { setURL(src.url); return; }
    let alive = true;
    void assets()?.resolveFileUrl(ASSET_URL_PREFIX + src.asset.id).then((u) => { if (alive) setURL(u); }, () => undefined);
    return () => { alive = false; };
  }, [key]); // src steckt vollständig in key
  return url;
}

async function uploadImage(file: File): Promise<CoverAsset | undefined> {
  const a = assets();
  if (!a) return undefined;
  const id = (await a.uploadFile(file)).slice(ASSET_URL_PREFIX.length);
  return { id, name: file.name || "image", size: file.size, ...(file.type ? { mime: file.type } : {}) };
}

export function CoverPicker({ store, pageID, onClose, hasCover }: { store: WorkspaceStore; pageID: string; onClose: () => void; hasCover: boolean }) {
  const [link, setLink] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const set = (c: PageCoverValue | undefined) => { setPageCover(store, pageID, c); onClose(); };
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="cover-picker menu" role="dialog" aria-label="Cover" data-testid="cover-picker">
      <p className="menu-foot t-meta">Color</p>
      <div className="cover-swatches">
        {COVER_COLORS.map((c) => <button key={c.id} type="button" className="cover-swatch" aria-label={c.label} style={{ background: c.css }} onClick={() => set({ color: { _0: c.id } })} />)}
      </div>
      <button type="button" className="menu-item" onClick={() => file.current?.click()}>Upload image…</button>
      <input ref={file} type="file" accept="image/*" hidden data-testid="cover-file" onChange={async (e) => {
        const f = e.target.files?.[0];
        if (!f) return;
        const a = await uploadImage(f);
        if (a) set({ asset: { _0: a } });
      }} />
      <form className="cover-link" onSubmit={(e) => { e.preventDefault(); if (/^https?:\/\//.test(link.trim())) set({ url: { _0: link.trim() } }); }}>
        <input className="field" aria-label="Image link" placeholder="Paste an image link…" value={link} onChange={(e) => setLink(e.target.value)} />
        <button type="submit" className="btn ghost">Apply</button>
      </form>
      {hasCover ? <button type="button" className="menu-item danger" onClick={() => set(undefined)}>Remove cover</button> : null}
    </div>
  );
}

export function PageCoverBand({ store, pageID, readOnly, position }: { store: WorkspaceStore; pageID: string; readOnly: boolean; position: number }) {
  const cover = pageCover(store, pageID);
  const image = cover && "asset" in cover ? { asset: cover.asset._0 } : cover && "url" in cover ? { url: cover.url._0 } : undefined;
  const url = useImageURL(image);
  const [picker, setPicker] = useState(false);
  // Wie Notion: „Reposition“ schaltet in einen Modus; im Modus das Bild ziehen, dann „Save position“ oder „Cancel“.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<number | undefined>();
  const drag = useRef<{ y: number; pos: number; id: number } | undefined>(undefined);
  useEffect(() => {
    if (!editing) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); setEditing(false); setDraft(undefined); }
      else if (e.key === "Enter") { e.preventDefault(); save(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  if (!cover) return null;
  const pos = draft ?? position;
  const save = () => { if (draft !== undefined) setCoverPosition(store, pageID, draft); setEditing(false); setDraft(undefined); };
  const cancel = () => { setEditing(false); setDraft(undefined); };
  return (
    <div className="page-cover" data-testid="page-cover" style={image ? undefined : { background: coverBackground(cover) }}
      data-repositioning={editing ? "" : undefined}
      onPointerDown={(e) => {
        if (!editing || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, pos, id: e.pointerId };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        // Bild folgt dem Zeiger: nach unten ziehen zeigt mehr vom oberen Bildteil.
        setDraft(Math.min(1, Math.max(0, d.pos - (e.clientY - d.y) / Math.max(1, e.currentTarget.clientHeight))));
      }}
      onPointerUp={(e) => { if (drag.current?.id === e.pointerId) drag.current = undefined; }}
      onPointerCancel={() => { drag.current = undefined; }}>
      {image && url ? <img src={url} alt="" draggable={false} style={{ objectPosition: `center ${(pos * 100).toFixed(1)}%` }} /> : null}
      {editing ? <div className="page-cover-hint t-meta" aria-live="polite">Drag image to reposition</div> : null}
      {!readOnly ? (
        <div className="page-cover-actions" data-visible={editing ? "" : undefined}>
          {editing ? (
            <>
              <button type="button" className="btn" onClick={save}>Save position</button>
              <button type="button" className="btn ghost" onClick={cancel}>Cancel</button>
            </>
          ) : (
            <>
              <button type="button" className="btn" onClick={() => setPicker((o) => !o)}>Change cover</button>
              {image ? <button type="button" className="btn" onClick={() => { setPicker(false); setEditing(true); }}>Reposition</button> : null}
            </>
          )}
        </div>
      ) : null}
      {picker ? <CoverPicker store={store} pageID={pageID} hasCover onClose={() => setPicker(false)} /> : null}
    </div>
  );
}

/** Bild als Seiten-Icon hochladen. */
export async function uploadPageIcon(store: WorkspaceStore, pageID: string, file: File): Promise<boolean> {
  const a = await uploadImage(file);
  if (!a) return false;
  setPageIconImage(store, pageID, { asset: a });
  return true;
}
