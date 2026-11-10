// BSD-78: Dateien im Editor. Hochladen: Datei → Store-Worker (lokaler Blob-Speicher, Upload-Warteschlange) →
// `based-asset:<sha256>` im Block. Anzeigen: `based-asset:<id>` → Bytes aus dem Worker (lokal oder vom Sync-Server
// geholt) → Blob-URL. Ist die Datei noch nicht da (anderes Gerät hat sie noch nicht hochgeladen, offline), bleibt
// der Block ein Platzhalter mit Hinweis und die Anfrage wird mit wachsendem Abstand wiederholt.
import { ASSET_URL_PREFIX } from "@based/editor";
import { safeBlobType } from "@based/sync";
import type { StoreClient } from "./worker/client.js";
import type { AssetsInfo } from "./worker/protocol.js";

/** Hinweis im Platzhalter, je nach Grund. */
export function assetNotice(code: string): string {
  switch (code) {
    case "loading": return "Loading file…";
    case "missing": return "This file hasn't been uploaded yet by the device it was added on.";
    case "offline": return "Offline — this file loads when the sync server is reachable.";
    case "no-server": return "This file is on another device. Connect a sync server in Settings to load it.";
    case "unsupported": return "This sync server doesn't store files.";
    case "unauthorized": return "The sync server rejected the token.";
    case "not-addressable": return "This file is only stored on the device it was added on.";
    case "corrupt": return "This file is damaged on the sync server.";
    default: return "This file can't be loaded right now.";
  }
}

/** Gründe, bei denen ein späterer Versuch helfen kann. */
const RETRY = new Set(["missing", "offline", "no-server", "unsupported", "unauthorized", "http"]);

/** Kurzer Zusatz für die Sync-Anzeige („2 files uploading“); leer, wenn nichts aussteht. */
export function assetsLabel(a: AssetsInfo | undefined): string {
  if (!a) return "";
  const n = (count: number, what: string) => `${count} ${count === 1 ? "file" : "files"} ${what}`;
  const parts: string[] = [];
  if (a.uploads > 0) parts.push(n(a.uploads, a.paused ? `waiting to upload (${a.paused === "offline" ? "offline" : a.paused === "unsupported" ? "server doesn't store files" : a.paused})` : "uploading"));
  if (a.downloads > 0) parts.push(n(a.downloads, "downloading"));
  if (a.failed > 0) parts.push(n(a.failed, "too large for the server"));
  return parts.join(" · ");
}

export interface AssetBridge {
  uploadFile(file: File): Promise<string>;
  resolveFileUrl(url: string): Promise<string>;
}

export interface AssetBridgeOptions {
  /** Wartezeiten zwischen Versuchen (Tests: kurz). */
  retry?: { minMs: number; maxMs: number };
  /** Elemente, die diese URL gerade zeigen (Platzhalter); ohne sie endet das Wiederholen. */
  elements?: (url: string) => Element[];
  createObjectURL?: (blob: Blob) => string;
}

/** Medien-Elemente der Blöcke mit dieser URL (BlockNote schreibt die Block-Props als `data-url` an den Block). */
const mediaElements = (url: string): Element[] => {
  if (typeof document === "undefined") return [];
  const out: Element[] = [];
  for (const block of document.querySelectorAll("[data-url]")) {
    if (block.getAttribute("data-url") !== url) continue;
    const media = block.querySelectorAll("img, video, audio");
    if (media.length > 0) out.push(...media);
    else out.push(block);
  }
  return out;
};

export function createAssetBridge(client: StoreClient, opts: AssetBridgeOptions = {}): AssetBridge {
  const urls = new Map<string, string>();
  const pending = new Map<string, Promise<string>>();
  const retry = opts.retry ?? { minMs: 3_000, maxMs: 60_000 };
  const elements = opts.elements ?? mediaElements;
  const objectURL = opts.createObjectURL ?? ((b: Blob) => URL.createObjectURL(b));
  const blobURL = (bytes: ArrayBuffer) => objectURL(new Blob([bytes], { type: safeBlobType(new Uint8Array(bytes, 0, Math.min(bytes.byteLength, 16))) }));

  // Hinweis am Medium (Zustand, alt, title) und am Block (`data-asset-notice`, als Platzhalter gezeichnet, assets.css).
  const note = (url: string, code: string) => {
    for (const el of elements(url)) {
      el.setAttribute("data-asset-state", code);
      if (el.tagName === "IMG") el.setAttribute("alt", assetNotice(code));
      el.setAttribute("title", assetNotice(code));
      el.closest?.("[data-url]")?.setAttribute("data-asset-notice", assetNotice(code));
    }
  };
  const clear = (url: string) => {
    for (const el of elements(url)) {
      el.removeAttribute("data-asset-state");
      el.removeAttribute("title");
      el.closest?.("[data-url]")?.removeAttribute("data-asset-notice");
    }
  };

  async function load(url: string, id: string): Promise<string> {
    let delay = retry.minMs;
    for (let attempt = 0; ; attempt++) {
      note(url, attempt === 0 ? "loading" : "waiting");
      const r = await client.assetGet(id);
      if (r.ok) {
        const out = blobURL(r.bytes);
        urls.set(id, out);
        clear(url);
        return out;
      }
      note(url, r.code);
      if (!RETRY.has(r.code)) throw new Error(r.message);
      await new Promise((res) => setTimeout(res, delay));
      delay = Math.min(delay * 2, retry.maxMs);
      // Niemand zeigt die Datei mehr (Seite geschlossen): aufhören, ohne abzulehnen – wer sie später zeigt,
      // beginnt neu. (Ablehnen würde einen Block treffen, der genau jetzt erscheint.)
      if (elements(url).length === 0) {
        pending.delete(id);
        return new Promise<string>(() => undefined);
      }
    }
  }

  return {
    async uploadFile(file) {
      const bytes = await file.arrayBuffer();
      const info = await client.assetPut(file.name, bytes, file.type || undefined);
      if (!urls.has(info.id)) urls.set(info.id, blobURL(bytes));
      return ASSET_URL_PREFIX + info.id;
    },
    resolveFileUrl(url) {
      if (!url.startsWith(ASSET_URL_PREFIX)) return Promise.resolve(url);
      const id = url.slice(ASSET_URL_PREFIX.length);
      const known = urls.get(id);
      if (known) return Promise.resolve(known);
      let p = pending.get(id);
      if (!p) {
        p = load(url, id).finally(() => pending.get(id) === p && pending.delete(id));
        pending.set(id, p);
      }
      return p;
    },
  };
}

let bridge: AssetBridge | undefined;
/** Einmal beim Start (main.tsx): verbindet den Editor-Steckplatz mit dem Store. */
export function connectAssets(client: StoreClient) {
  bridge = createAssetBridge(client);
}
export const assets = (): AssetBridge | undefined => bridge;
