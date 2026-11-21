// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-632: „Send to Based“ – das gespeicherte Bündel an basednotes.app schicken (POST /api/report, Vertrag und
// Einordnung der Antworten im Kern: packages/core/src/bugReport.ts). Was nicht ankommt, bleibt in der Warteschlange
// (reportStore.queue) und geht beim nächsten Start bzw. wenn das Netz zurück ist erneut raus.
// Mac-App: Tauri-HTTP-Plugin (Rust, ohne CORS; Recht für genau diese Adresse in capabilities/default.json),
// Browser: fetch (der Server erlaubt jeden Ursprung).
import { canSendReport, REPORT_URL, reportRequestBody, reportSendResult, type BugBundle, type ReportSendResult } from "@based/core";
import { isTauri } from "../desktop.js";
import { diagnosticsLog } from "./diagnostics.js";
import { reportsChanged, reportStore } from "./reportStore.js";

type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; json(): Promise<unknown> }>;

async function fetcher(): Promise<Fetcher> {
  if (isTauri()) {
    const http = await import("@tauri-apps/plugin-http");
    return (url, init) => http.fetch(url, init);
  }
  return (url, init) => fetch(url, init);
}

const pngBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
  r.onerror = () => reject(r.error ?? new Error("read failed"));
  r.readAsDataURL(blob);
});

async function post(f: Fetcher, bundle: BugBundle, shot?: string): Promise<ReportSendResult> {
  try {
    const res = await f(REPORT_URL, { method: "POST", headers: { "content-type": "application/json" }, body: reportRequestBody(bundle, shot) });
    const body = await res.json().catch(() => undefined);
    return reportSendResult(res.status, body, bundle.id);
  } catch (e) {
    diagnosticsLog.add("warning", `report send failed: ${e instanceof Error ? e.message : String(e)}`);
    return reportSendResult(0, undefined, bundle.id);
  }
}

/** Ein Bündel senden; zu groß → ohne Bildschirmfoto noch einmal. */
export async function sendBundle(bundle: BugBundle, screenshot?: Blob, f?: Fetcher): Promise<ReportSendResult> {
  if (!canSendReport(bundle)) return { kind: "rejected", status: 400 };
  const go = f ?? (await fetcher());
  const shot = screenshot && bundle.screenshot ? await pngBase64(screenshot).catch(() => undefined) : undefined;
  let result = await post(go, bundle, shot);
  if (result.kind === "too-large" && shot) {
    const { screenshot: _dropped, ...rest } = bundle;
    result = await post(go, rest);
  }
  return result;
}

/**
 * Den gespeicherten Bericht `id` senden. Kommt er an (oder lehnt der Server ihn ab), raus aus der Warteschlange;
 * sonst hinein. Gibt das Ergebnis zurück.
 */
export async function sendSaved(id: string): Promise<ReportSendResult> {
  const store = await reportStore();
  const saved = await store.load(id);
  if (!saved) return { kind: "rejected", status: 404 };
  const result = await sendBundle(saved.bundle, saved.screenshot);
  await store.queue(id, result.kind === "later").catch(() => undefined);
  diagnosticsLog.add(result.kind === "sent" ? "info" : "warning", `problem report ${id}: ${result.kind === "sent" ? `sent${result.duplicate ? " (already there)" : ""}` : result.kind === "later" ? `queued (${result.reason})` : result.kind}`);
  reportsChanged();
  return result;
}

let flushing: Promise<void> | undefined;

/** Warteschlange abarbeiten (Start, wieder online). Hält bei „später“ an, damit das Ratenlimit nicht leerläuft. */
export function flushReportOutbox(): Promise<void> {
  flushing ??= (async () => {
    try {
      const ids = await (await reportStore()).queued();
      for (const id of ids) {
        const r = await sendSaved(id);
        if (r.kind === "later") break;
      }
    } catch (e) {
      diagnosticsLog.add("warning", `report outbox: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      flushing = undefined;
    }
  })();
  return flushing;
}

let installed = false;

/** Einmal beim Start: Warteschlange nach dem Laden senden und erneut, sobald das Netz zurück ist. */
export function installReportOutbox(win: Window = globalThis as unknown as Window, delayMs = 4000) {
  if (installed) return;
  installed = true;
  win.setTimeout(() => void flushReportOutbox(), delayMs);
  win.addEventListener("online", () => void flushReportOutbox());
}
