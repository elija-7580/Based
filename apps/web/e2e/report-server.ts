// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-632: „Send to Based“ gegen den echten Server (apps/website/server/waitlist.mjs) – lokal, auf einem freien Port,
// ohne Notion-Zugang (der Dienst speichert dann nur). Die App schickt an https://basednotes.app/api/report; der Test
// leitet genau diese Adresse auf den lokalen Dienst um. Nie geht ein Bericht an den echten basednotes.app.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page } from "@playwright/test";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "website", "server", "waitlist.mjs");
export const REPORT_ROUTE = "https://basednotes.app/api/report";

export interface ReportServer {
  base: string;
  /** Gespeichertes Bündel (JSON) bzw. ob das Foto da ist. */
  report(id: string): Record<string, unknown> | undefined;
  hasScreenshot(id: string): boolean;
  stop(): Promise<void>;
}

export async function startReportServer(): Promise<ReportServer> {
  const dir = mkdtempSync(join(tmpdir(), "based-report-server-"));
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    env: { ...process.env, PORT: "0", WAITLIST_DB: join(dir, "w.sqlite"), BETA_DIR: join(dir, "beta"), WAITLIST_STATS_TOKEN: "", NOTION_TOKEN: "", NOTION_BACKLOG_DATA_SOURCE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += String(d); });
  const port = await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /waitlist service on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error(`report server exited ${c}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`)));
  });
  const reports = join(dir, "reports");
  return {
    base: `http://127.0.0.1:${port}`,
    report: (id) => {
      const f = join(reports, `${id}.json`);
      return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, unknown>) : undefined;
    },
    hasScreenshot: (id) => existsSync(join(reports, `${id}.png`)),
    stop: async () => {
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r));
      child.kill();
      await exited;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Anfragen an basednotes.app/api/report zum lokalen Dienst umleiten (oder, ohne Dienst, mit `status` beantworten). */
export async function routeReports(target: Page | BrowserContext, to: ReportServer | { status: number }) {
  await target.unroute(REPORT_ROUTE).catch(() => undefined);
  await target.route(REPORT_ROUTE, async (route) => {
    if ("status" in to) return route.fulfill({ status: to.status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ error: "unavailable" }) });
    const res = await route.fetch({ url: `${to.base}/api/report` });
    return route.fulfill({ response: res });
  });
}
