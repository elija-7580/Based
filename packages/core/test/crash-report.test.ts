// BSD-276: Absturz-/Hängerbericht – opt-in, einmal je Sitzung, ohne Inhalte.
import { describe, expect, it } from "vitest";
import { buildCrashReport, crashKind, crashReportSummary, crashReportText, CRASH_LOG_LIMIT, shouldOfferCrashReport, type SessionRecord } from "../src/index.js";

const T0 = Date.UTC(2026, 10, 12, 18, 0, 0);
const app = { shell: "desktop" as const, version: "0.9.0", commit: "abc1234", platform: "macOS" };

describe("Absturzbericht (BSD-276)", () => {
  it("Art: Absturz, Hänger oder nichts", () => {
    expect(crashKind(undefined)).toBeUndefined();
    expect(crashKind({ startedAt: T0, lastBeat: T0 + 1000, clean: true, stalls: 0 })).toBeUndefined();
    expect(crashKind({ startedAt: T0, lastBeat: T0 + 1000, clean: true, stalls: 2 })).toBe("freeze");
    expect(crashKind({ startedAt: T0, lastBeat: T0 + 1000, clean: false, stalls: 0 })).toBe("crash");
  });

  it("Hinweis nur mit Einwilligung und nur einmal je Sitzung", () => {
    const prev: SessionRecord = { startedAt: T0, lastBeat: T0 + 1000, clean: false, stalls: 0, log: [{ at: T0 + 5, level: "error", message: "TypeError" }] };
    expect(shouldOfferCrashReport(prev, false, undefined)).toBe(false);
    expect(shouldOfferCrashReport(prev, true, undefined)).toBe(true);
    expect(shouldOfferCrashReport(prev, true, T0)).toBe(false);
    expect(shouldOfferCrashReport(prev, true, T0 - 5)).toBe(true);
    expect(shouldOfferCrashReport({ ...prev, clean: true }, true, undefined)).toBe(false);
  });

  it("Ende ohne Anzeichen (Update-Neustart, Sofort beenden) bietet nichts an; Hänger oder Fehler schon", () => {
    const quiet: SessionRecord = { startedAt: T0, lastBeat: T0 + 1000, clean: false, stalls: 0, log: [{ at: T0 + 5, level: "info", message: "boot: ready" }] };
    expect(shouldOfferCrashReport(quiet, true, undefined)).toBe(false);
    expect(shouldOfferCrashReport({ startedAt: T0, lastBeat: T0 + 1000, clean: false, stalls: 0 }, true, undefined)).toBe(false);
    expect(shouldOfferCrashReport({ ...quiet, stalls: 1 }, true, undefined)).toBe(true);
    expect(shouldOfferCrashReport({ ...quiet, log: [{ at: T0 + 5, level: "error", message: "boom" }] }, true, undefined)).toBe(true);
  });

  it("Bericht enthält keine Titel oder Texte aus dem Workspace", () => {
    const secrets = ["Geheimes Tagebuch", "Gehaltsliste Ada", "ada@example.com", "bdu_ABCDEFGHIJ1234", "after=secret"];
    const prev: SessionRecord = {
      startedAt: T0, lastBeat: T0 + 65_000, clean: false, stalls: 1,
      log: [
        { at: T0 + 10, level: "info", message: "boot: outline +120 ms" },
        { at: T0 + 20, level: "error", message: `TypeError: page “Geheimes Tagebuch” failed for ada@example.com` },
        { at: T0 + 30, level: "warning", message: `sync https://based.example/pull?after=secret token bdu_ABCDEFGHIJ1234 "Gehaltsliste Ada"` },
      ],
    };
    const r = buildCrashReport({ prev, app, now: T0 + 120_000 })!;
    expect(r.kind).toBe("crash");
    expect(r.session).toEqual({ startedAt: "2026-11-12T18:00:00.000Z", lastSignOfLife: "2026-11-12T18:01:05.000Z", durationSeconds: 65, freezes: 1, endedNormally: false });
    expect(r.log).toHaveLength(3);
    expect(r.log[0]!.message).toBe("boot: outline +120 ms");
    const text = crashReportText(r);
    for (const s of secrets) expect(text).not.toContain(s);
    // keine Felder für Inhalte, Aufzeichnung, Foto oder User-Agent
    for (const k of ["doc", "blocks", "recording", "screenshot", "userAgent", "note"]) expect(text).not.toContain(`"${k}"`);
    expect(JSON.parse(text)).toEqual(r);
  });

  it("Log begrenzt, kaputte Zeilen übersprungen, ohne Absturz kein Bericht", () => {
    const log = Array.from({ length: 80 }, (_, i) => ({ at: T0 + i, level: "info" as const, message: `line ${i}` }));
    const prev = { startedAt: T0, lastBeat: T0, clean: true, stalls: 3, log: [...log, { at: "x", level: "info", message: 1 } as never] };
    const r = buildCrashReport({ prev, app: { shell: "web", platform: "MacIntel" }, now: T0 })!;
    expect(r.kind).toBe("freeze");
    expect(r.log).toHaveLength(CRASH_LOG_LIMIT);
    expect(r.log.at(-1)!.message).toBe("line 79");
    expect(r.app).toEqual({ shell: "web", platform: "MacIntel" });
    expect(crashReportSummary(r)).toBe("Session 2026-11-12 18:00–18:00 UTC · 3 freezes");
    expect(crashReportSummary({ ...r, session: { ...r.session, freezes: 0, lastSignOfLife: "2026-11-13T01:02:00.000Z" } })).toBe("Session 2026-11-12 18:00–2026-11-13 01:02 UTC");
    expect(buildCrashReport({ prev: { ...prev, stalls: 0 }, app, now: T0 })).toBeUndefined();
  });
});
