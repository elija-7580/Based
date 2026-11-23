// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Apple Watch (apps/watch) → iPhone-Hülle (apps/mobile) → Workspace. Die Uhr schickt Sprachnotizen und diktierte
// Notizen als Dateien an das iPhone (WatchConnectivity); das Plugin `based-watch` der Hülle legt sie in einen
// Eingang im Container der App. Hier werden sie zu Seiten: eine Sprachnotiz zu einer Seite mit Meeting-Block und der
// Aufnahme als Spur (abspielbar, transkribiert wie jede Aufnahme), ein Diktat zu einer Seite mit dem Text.
// Nichts geht verloren: ein Eintrag verlässt den Eingang erst, wenn seine Seite steht (`done`); bricht die App
// dazwischen ab, verhindert die Liste der erledigten Kennungen eine zweite Seite.

/** Ein Eintrag im Eingang der Hülle (Metadaten der Uhr). */
export interface WatchInboxItem {
  /** Stabile Kennung der Uhr (UUID). */
  id: string;
  /** Aufnahmezeit, Sekunden seit 1970. */
  at: number;
  /** Sekunden Ton (0 bei Text). */
  dur: number;
  /** `m4a` (Sprachnotiz) oder `txt` (Diktat). */
  ext: string;
}

/** Was die Hülle anbietet (Befehle des Plugins `based-watch`). */
export interface WatchInboxBridge {
  pending(): Promise<WatchInboxItem[]>;
  /** Inhalt eines Eintrags. */
  read(id: string): Promise<Uint8Array>;
  /** Eintrag ist im Workspace: aus dem Eingang löschen. */
  done(id: string): Promise<void>;
}

/** Wohin die Einträge gehen (Store-Befehl und Meeting-Dienst). */
export interface WatchInboxTarget {
  createCapture(at: number, text?: string): Promise<string | undefined>;
  /** Aufnahme in den Meeting-Block der Seite legen; `undefined` = hier gibt es keine Aufnahmen (Meeting-Dienst fehlt). */
  importAudio: ((pageID: string, file: { data: Blob; mime: string; duration: number; name: string }) => Promise<boolean>) | undefined;
  /** Kennungen, die schon eine Seite haben (überlebt Neustarts). */
  ledger: { get(): string[]; set(ids: string[]): void };
  /** Seite verwerfen, deren Aufnahme nicht gespeichert werden konnte (der Eintrag bleibt im Eingang). */
  discard(pageID: string): Promise<void>;
}

const LEDGER_LIMIT = 500;
const MIME: Record<string, string> = { m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", wav: "audio/wav", caf: "audio/x-caf" };

export function isWatchInboxItem(x: unknown): x is WatchInboxItem {
  const v = x as Partial<WatchInboxItem> | null;
  return !!v && typeof v.id === "string" && v.id.length > 0 && typeof v.at === "number" && Number.isFinite(v.at)
    && typeof v.dur === "number" && typeof v.ext === "string";
}

/**
 * Holt alles aus dem Eingang in den Workspace; liefert die neuen Seiten (älteste Notiz zuerst). Ein Eintrag, der
 * scheitert, bleibt liegen und kommt beim nächsten Lauf wieder; die übrigen laufen weiter.
 */
export async function drainWatchInbox(bridge: WatchInboxBridge, target: WatchInboxTarget): Promise<string[]> {
  const items = (await bridge.pending()).filter(isWatchInboxItem).sort((a, b) => a.at - b.at);
  const pages: string[] = [];
  for (const item of items) {
    try {
      if (target.ledger.get().includes(item.id)) {
        await bridge.done(item.id);
        continue;
      }
      const text = item.ext === "txt";
      if (!text && !target.importAudio) continue;
      const bytes = await bridge.read(item.id);
      const at = item.at * 1000;
      let page: string | undefined;
      if (text) {
        const content = new TextDecoder().decode(bytes).trim();
        if (content) page = await target.createCapture(at, content);
        else { await bridge.done(item.id); continue; }
      } else {
        page = await target.createCapture(at);
        if (page) {
          const mime = MIME[item.ext] ?? "audio/mp4";
          const data = new Blob([bytes as BlobPart], { type: mime });
          const ok = await target.importAudio!(page, { data, mime, duration: item.dur, name: `voice-note-${item.id.slice(0, 8)}.${item.ext}` });
          if (!ok) { await target.discard(page); page = undefined; }
        }
      }
      if (!page) continue;
      target.ledger.set([...target.ledger.get(), item.id].slice(-LEDGER_LIMIT));
      pages.push(page);
      await bridge.done(item.id);
    } catch {
      // bleibt im Eingang
    }
  }
  return pages;
}

/** Ereignis, das die Hülle auslöst, wenn die Uhr etwas geliefert hat (Swift: `WatchPlugin`). */
export const WATCH_INBOX_EVENT = "based:watch-inbox";

/** Befehle des Plugins über Tauri (nur in der Handy-Hülle aufrufen). */
export function tauriWatchBridge(): WatchInboxBridge {
  const call = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<T>(`plugin:based-watch|${cmd}`, args);
  };
  return {
    async pending() {
      const r = await call<{ items?: unknown }>("pending");
      return Array.isArray(r?.items) ? r.items.filter(isWatchInboxItem) : [];
    },
    async read(id) {
      const r = await call<{ data: string }>("read", { id });
      const bin = atob(r.data);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    },
    async done(id) {
      await call("done", { id });
    },
  };
}

/**
 * In der Handy-Hülle: Eingang beim Start leeren, wenn die Uhr liefert und wenn die App wieder nach vorn kommt.
 * Läufe überlappen nicht; ein Anlass während eines Laufs löst genau einen weiteren aus.
 */
export function startWatchInbox(bridge: WatchInboxBridge, target: WatchInboxTarget, win: Pick<Window, "addEventListener" | "removeEventListener"> & { document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener"> } = window): () => void {
  let running = false;
  let again = false;
  let stopped = false;
  const run = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    running = true;
    void drainWatchInbox(bridge, target).catch(() => []).then(() => {
      running = false;
      if (again) { again = false; run(); }
    });
  };
  const onVisible = () => { if (win.document.visibilityState === "visible") run(); };
  win.addEventListener(WATCH_INBOX_EVENT, run);
  win.document.addEventListener("visibilitychange", onVisible);
  run();
  return () => {
    stopped = true;
    win.removeEventListener(WATCH_INBOX_EVENT, run);
    win.document.removeEventListener("visibilitychange", onVisible);
  };
}
