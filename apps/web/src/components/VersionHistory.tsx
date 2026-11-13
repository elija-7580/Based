// BSD-73: Seitenmenü → Version history, aufgebaut wie in der Swift-App (VersionHistorySheet.swift) und in Notion:
// links die gewählte Version als Lese-Ansicht, rechts die Versionen nach Tagen, unten „Restore“. Wiederherstellen
// verschiebt die aktuelle Fassung in eine Version (nichts geht verloren) und ist ein Undo-Schritt.
import { canonicalStringify, MemoryPersistence, plainText, WorkspaceStore, type Block, type HistoryVersion } from "@based/core";
import { BasedButton, BasedIconButton } from "@based/ui/astryx";
import { useEffect, useMemo, useState } from "react";
import { Icon } from "../icons.js";
import type { StoreClient } from "../worker/client.js";
import type { HistoryList, HistoryRestoreResult } from "../worker/protocol.js";
import { BlockView } from "./BlockView.js";
import "./history.css";

interface Props {
  client: StoreClient;
  pageID: string;
  /** Die Seite, wie sie jetzt ist (Replik), für „N blocks differ from now“. */
  current: WorkspaceStore | undefined;
  onClose: () => void;
  onRestored: (r: HistoryRestoreResult) => void;
}

const REASONS: Record<string, string> = { "before restore": "before restore", restored: "restored", opened: "opened" };

const dayLabel = (d: Date) => {
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
};
const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const when = (v: HistoryVersion) => new Date(v.at * 1000);

/** Inhalt eines Blocks ohne Zeiten und Stempel (für den Vergleich mit jetzt). */
const content = (b: Block) => canonicalStringify({ t: b.type, p: b.parent, x: b.text ?? "", o: b.props ?? {}, v: b.values ?? {} });

export function VersionHistory({ client, pageID, current, onClose, onRestored }: Props) {
  const [list, setList] = useState<HistoryList | undefined>();
  const [failed, setFailed] = useState<string | undefined>();
  const [selected, setSelected] = useState<number | undefined>();
  const [blocks, setBlocks] = useState<{ id: number; blocks: Block[]; missing: string[] } | undefined>();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    client.historyList(pageID).then((l) => {
      if (!alive) return;
      setList(l);
      // Wie Notion: die Version vor der neuesten (die neueste ist die Seite, wie sie ist).
      setSelected((l.versions[1] ?? l.versions[0])?.id);
    }, (e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [client, pageID]);

  useEffect(() => {
    if (selected === undefined) return;
    let alive = true;
    client.historyContent(pageID, selected).then((c) => alive && setBlocks({ id: selected, ...c }), (e: Error) => alive && setFailed(e.message));
    return () => {
      alive = false;
    };
  }, [client, pageID, selected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (confirm) setConfirm(false);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, onClose]);

  // Lese-Ansicht: ein kleiner Store nur mit den Blöcken der Version.
  const preview = useMemo(() => {
    if (!blocks || blocks.id !== selected) return undefined;
    return new WorkspaceStore({ node: "preview", persistence: new MemoryPersistence(blocks.blocks.map((data) => ({ kind: "block", data }))) });
  }, [blocks, selected]);

  const versions = list?.versions ?? [];
  const version = versions.find((v) => v.id === selected);
  const changed = useMemo(() => {
    if (!blocks || !current) return 0;
    const now = new Map<string, Block>();
    const walk = (id: string) => {
      for (const c of current.children("b:" + id)) {
        const b = current.blocks.get(c);
        if (!b || b.trashedAt !== undefined) continue;
        now.set(c, b);
        if (b.type !== "page" && b.type !== "databasePage") walk(c);
      }
    };
    walk(pageID);
    const then = blocks.blocks.slice(1);
    let n = 0;
    for (const b of then) {
      const cur = now.get(b.id);
      if (!cur || content(cur) !== content(b)) n += 1;
    }
    const ids = new Set(then.map((b) => b.id));
    for (const id of now.keys()) if (!ids.has(id)) n += 1;
    return n;
  }, [blocks, current, pageID]);

  const days: [string, HistoryVersion[]][] = [];
  for (const v of versions) {
    const label = dayLabel(when(v));
    const last = days[days.length - 1];
    if (last && last[0] === label) last[1].push(v);
    else days.push([label, [v]]);
  }

  const restore = async () => {
    if (selected === undefined) return;
    setBusy(true);
    try {
      onRestored(await client.historyRestore(pageID, selected));
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      setBusy(false);
      setConfirm(false);
    }
  };

  const isLatest = version !== undefined && version.id === versions[0]?.id;
  const title = blocks?.blocks[0];

  return (
    <div className="qf-backdrop vh-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label="Version history" className="vh" data-testid="version-history">
        <section className="vh-main">
          <header className="vh-head">
            <BasedIconButton label="Close" tooltip="Close (Esc)" icon={<Icon name="close" size={18} />} onClick={onClose} />
            <strong className="vh-when">{version ? `${dayLabel(when(version))}, ${time(when(version))}` : "Version history"}</strong>
            {isLatest ? <span className="t-desc">Latest</span> : null}
            <span className="spacer" />
            {version && changed > 0 ? <span className="t-desc vh-changed"><span className="vh-dot" aria-hidden="true" />{changed} {changed === 1 ? "block differs" : "blocks differ"} from now</span> : null}
          </header>
          <div className="vh-preview" data-testid="version-preview">
            {failed ? <p className="vh-error" role="alert">{failed}</p> : null}
            {list && versions.length === 0 ? (
              <div className="vh-empty">
                <strong>No versions yet</strong>
                <p className="t-desc">Versions are saved while you edit – after a pause, at least every 10 minutes, and when you open the page.</p>
              </div>
            ) : null}
            {blocks?.missing.length ? <p className="vh-error" role="alert">This version is incomplete: {blocks.missing.length} stored {blocks.missing.length === 1 ? "block is" : "blocks are"} missing.</p> : null}
            {preview && title ? (
              <>
                <h1 className="t-title vh-title">{plainText(title.text) || "Untitled"}</h1>
                <BlockView store={preview} pageID={title.id} readOnly onOpenPage={() => undefined} />
              </>
            ) : null}
          </div>
        </section>
        <aside className="vh-side" aria-label="Versions">
          <header className="vh-head"><strong>Version history</strong></header>
          <div className="vh-list" role="listbox" aria-label="Versions">
            {days.map(([day, items]) => (
              <div key={day} role="group" aria-label={day}>
                <div className="vh-day t-desc">{day}</div>
                {items.map((v) => {
                  const i = versions.indexOf(v);
                  const older = versions[i + 1];
                  const delta = older ? v.wordCount - older.wordCount : 0;
                  return (
                    <button key={v.id} type="button" role="option" aria-selected={v.id === selected} className="vh-row" onClick={() => setSelected(v.id)}>
                      <span className="vh-row-time">{time(when(v))}</span>
                      <span className="t-desc">
                        {v.wordCount} {v.wordCount === 1 ? "word" : "words"}
                        {delta ? <span className={delta > 0 ? "vh-plus" : "vh-minus"}> {delta > 0 ? `+${delta}` : delta}</span> : null}
                        {REASONS[v.reason] && v.reason !== "opened" ? ` · ${REASONS[v.reason]}` : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <footer className="vh-foot">
            {list?.error ? <p className="vh-error" role="alert">Couldn't save a version: {list.error}</p> : null}
            {confirm ? (
              <div className="vh-confirm" role="alertdialog" aria-label="Restore this version?">
                <strong>Restore this version?</strong>
                <p className="t-desc">The page goes back to how it was. The current state is kept as a version, and Undo reverts the restore.</p>
                <div className="vh-actions">
                  <BasedButton label="Cancel" variant="ghost" onClick={() => setConfirm(false)} />
                  <BasedButton label="Restore" variant="primary" busy={busy} onClick={() => void restore()} />
                </div>
              </div>
            ) : (
              <div className="vh-actions">
                {list?.stats ? <span className="t-desc" title="All pages. Unchanged blocks are stored once and shared between versions.">{list.stats.versions} {list.stats.versions === 1 ? "version" : "versions"}</span> : null}
                <span className="spacer" />
                <BasedButton label="Restore" variant="primary" disabled={!version || (isLatest && changed === 0) || Boolean(blocks?.missing.length)} onClick={() => setConfirm(true)} />
              </div>
            )}
          </footer>
        </aside>
      </div>
    </div>
  );
}
