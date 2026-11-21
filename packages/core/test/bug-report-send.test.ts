// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-632: „Send to Based“ – Body für POST /api/report, Antworten einordnen (Vertrag mit apps/website/server/report.mjs).
import { describe, expect, it } from "vitest";
import {
  buildBugBundle, bundleID, canSendReport, REPORT_ID, REPORT_MAX_BYTES, REPORT_URL, reportRequestBody, reportSendResult,
  type BugBundle,
} from "../src/index.js";

const SECRET = "Geheimes Tagebuch über Ada";

const bundle = (): BugBundle => buildBugBundle({
  id: bundleID(Date.UTC(2026, 10, 21, 3, 30, 5), () => 0.5), now: Date.UTC(2026, 10, 21, 3, 30, 5), note: "Liste sprang", realText: false,
  app: { shell: "desktop", version: "0.2.12" },
  env: { width: 1280, height: 820, dpr: 2, zoom: 1, theme: "light" },
  state: { root: "p1", blocks: [{ id: "b1", type: "text", text: SECRET }], menus: [] },
  layout: [],
  events: [{ t: 1, kind: "key", root: "p1", key: "G", mods: {} }, { t: 2, kind: "input", root: "p1", inputType: "insertText", data: SECRET }],
  log: [],
});

describe("Senden an uns", () => {
  it("geht an basednotes.app, höchstens 8 MB, ID wie bundleID", () => {
    expect(REPORT_URL).toBe("https://basednotes.app/api/report");
    expect(REPORT_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(bundle().id).toBe("20261121-033005-8000");
    expect(REPORT_ID.test(bundle().id)).toBe(true);
  });

  it("Body: Bündel ohne Nutzertext, Foto nur, wenn mitgegeben", () => {
    const b = bundle();
    const plain = JSON.parse(reportRequestBody(b)) as { bundle: BugBundle; screenshot?: string };
    expect(plain.bundle.id).toBe(b.id);
    expect(plain.screenshot).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain("Tagebuch");
    const withShot = JSON.parse(reportRequestBody(b, "iVBORw0KGgo=")) as { screenshot?: string };
    expect(withShot.screenshot).toBe("iVBORw0KGgo=");
  });

  it("ordnet die Antworten des Servers ein", () => {
    expect(reportSendResult(200, { ok: true, id: "x" }, "y")).toEqual({ kind: "sent", id: "x", duplicate: false });
    expect(reportSendResult(200, { ok: true, id: "x", duplicate: true }, "y")).toEqual({ kind: "sent", id: "x", duplicate: true });
    expect(reportSendResult(200, { ok: true }, "y")).toEqual({ kind: "sent", id: "y", duplicate: false });
    expect(reportSendResult(200, "<html>", "y").kind).toBe("later");
    expect(reportSendResult(413, { error: "too large" }, "y")).toEqual({ kind: "too-large" });
    expect(reportSendResult(400, { error: "bad request" }, "y")).toEqual({ kind: "rejected", status: 400 });
    expect(reportSendResult(404, undefined, "y")).toEqual({ kind: "rejected", status: 404 });
    expect(reportSendResult(429, { error: "slow down" }, "y").kind).toBe("later");
    expect(reportSendResult(502, undefined, "y").kind).toBe("later");
    expect(reportSendResult(0, undefined, "y")).toEqual({ kind: "later", reason: "offline" });
  });

  it("sendet nur Bündel mit Server-ID", () => {
    expect(canSendReport(bundle())).toBe(true);
    expect(canSendReport({ ...bundle(), id: "old-report" })).toBe(false);
  });
});
