// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-580: Einstellung „Search by meaning“ für `recall` (MCP). Das Modell lädt der lokale Server bzw. der verbundene
// based-server (GET /local/brain, POST /local/brain/model, apps/server/src/brain-index.ts) – nur auf ausdrücklichen
// Klick. Hier nur reine Logik (getestet): Stand lesen, Aktion schicken, nächster Schritt, Texte.
import type { ServerAccess } from "../meeting/whisper.js";
import { megabytes } from "../meeting/whisper.js";

/** Antwort von GET /local/brain. */
export interface BrainStatus {
  model: { id: string; name: string; license?: string; size: number } | null;
  installed: boolean;
  downloading: boolean;
  loaded?: number;
  error?: string;
  ready: boolean;
  runtime?: "native" | "wasm";
  sections: number;
  pages: number;
  pending: number;
  bytes: number;
}

const base = (cfg: ServerAccess) => cfg.url.replace(/\/+$/, "");

/** Stand auf einem Server; `undefined`: er bietet es nicht an (keine Route, Gast, nicht erreichbar). */
export async function brainStatus(cfg: ServerAccess | undefined, fetcher: typeof fetch = (...a) => fetch(...a)): Promise<BrainStatus | undefined> {
  if (!cfg?.url) return undefined;
  try {
    const r = await fetcher(`${base(cfg)}/local/brain`, { headers: { Authorization: `Bearer ${cfg.token}` } });
    if (!r.ok) return undefined;
    const b = (await r.json()) as Partial<BrainStatus>;
    return {
      model: b.model ?? null, installed: b.installed === true, downloading: b.downloading === true, ready: b.ready === true,
      sections: b.sections ?? 0, pages: b.pages ?? 0, pending: b.pending ?? 0, bytes: b.bytes ?? 0,
      ...(typeof b.loaded === "number" ? { loaded: b.loaded } : {}), ...(b.error ? { error: b.error } : {}), ...(b.runtime ? { runtime: b.runtime } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Modell laden, abbrechen oder entfernen. */
export async function brainModel(cfg: ServerAccess, action: "download" | "cancel" | "remove", fetcher: typeof fetch = (...a) => fetch(...a)): Promise<BrainStatus | undefined> {
  const r = await fetcher(`${base(cfg)}/local/brain/model`, { method: "POST", body: JSON.stringify({ action }), headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" } });
  const body = (await r.json().catch(() => ({}))) as Partial<BrainStatus> & { error?: string };
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
  return brainStatus(cfg, fetcher);
}

export type BrainStep = "no-server" | "no-model" | "off" | "downloading" | "indexing" | "ready" | "error";

/** Reine Regel: der Zustand für die Zeile. */
export function brainStep(s: BrainStatus | undefined): BrainStep {
  if (!s) return "no-server";
  if (!s.model) return "no-model";
  if (s.downloading) return "downloading";
  if (s.error && s.error !== "cancelled" && !s.ready) return "error";
  if (!s.installed) return "off";
  return !s.ready || s.pending > 0 ? "indexing" : "ready";
}

/** Fortschritt in Prozent, `undefined` ohne Größe. */
export function brainPercent(s: BrainStatus): number | undefined {
  if (!s.model?.size || s.loaded === undefined) return undefined;
  return Math.max(0, Math.min(100, Math.floor((s.loaded / s.model.size) * 100)));
}

const count = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;

/** Hinweis unter „Search by meaning“. `local`: Server auf diesem Mac. */
export function brainHint(step: BrainStep, s: BrainStatus | undefined, o: { local: boolean; desktop: boolean }): string {
  const size = megabytes(s?.model?.size);
  switch (step) {
    case "no-server":
      return o.desktop
        ? "Needs the local server. Turn it on above, then come back here."
        : "Needs a Based server. Connect one in Sync & server.";
    case "no-model":
      return "This server has no model for search by meaning.";
    case "off":
      return `Off. Connected apps find pages by shared words. Turn it on to also find pages that mean the same, in any language. Based downloads a model once${size ? ` (${size})` : ""} from huggingface.co${o.local ? " and runs it on this Mac" : ""}.`;
    case "downloading": {
      const pct = s ? brainPercent(s) : undefined;
      return `Downloading the model${size ? ` (${size})` : ""}…${pct === undefined ? "" : ` ${pct} %`}`;
    }
    case "indexing":
      if (!s?.ready && !s?.pending) return "Loading the model…";
      return `Indexing your pages… ${count(s?.pending ?? 0, "page")} to go.${s?.ready ? " Search by meaning already works for the pages done so far." : ""}`;
    case "ready":
      return `Ready. ${count(s?.pages ?? 0, "page")} in ${count(s?.sections ?? 0, "section")}, ${megabytes(s?.bytes) || "less than 1 MB"} on ${o.local ? "this Mac" : "the server"}.`;
    case "error":
      return `Couldn't turn it on: ${s?.error ?? "unknown error"}.`;
  }
}
