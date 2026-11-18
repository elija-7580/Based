// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-580: Stand der Suche nach Bedeutung lesen, Aktionen schicken, Zustand und Text je Schritt.
import { describe, expect, it } from "vitest";
import { brainHint, brainModel, brainPercent, brainStatus, brainStep, type BrainStatus } from "./semanticSearch.js";

const MODEL = { id: "multilingual-e5-small", name: "Multilingual E5 small", license: "MIT", size: 135_000_000 };
const base: BrainStatus = { model: MODEL, installed: false, downloading: false, ready: false, sections: 0, pages: 0, pending: 0, bytes: 0 };
const cfg = { url: "http://127.0.0.1:8787/", token: "t" };

function fake(responses: { status?: number; body: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    const r = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

describe("Search by meaning (BSD-580)", () => {
  it("ein Zustand je Schritt", () => {
    expect(brainStep(undefined)).toBe("no-server");
    expect(brainStep({ ...base, model: null })).toBe("no-model");
    expect(brainStep(base)).toBe("off");
    expect(brainStep({ ...base, error: "cancelled" })).toBe("off");
    expect(brainStep({ ...base, downloading: true, loaded: 67_500_000 })).toBe("downloading");
    expect(brainStep({ ...base, installed: true })).toBe("indexing");
    expect(brainStep({ ...base, installed: true, ready: true, pending: 12 })).toBe("indexing");
    expect(brainStep({ ...base, installed: true, ready: true, pages: 3, sections: 9 })).toBe("ready");
    expect(brainStep({ ...base, installed: true, error: "no ONNX runtime" })).toBe("error");
  });

  it("Texte: Größe, Fortschritt, Stand des Index, Ort", () => {
    expect(brainHint("off", base, { local: true, desktop: true })).toContain("(135 MB) from huggingface.co and runs it on this Mac");
    expect(brainPercent({ ...base, downloading: true, loaded: 67_500_000 })).toBe(50);
    expect(brainHint("downloading", { ...base, downloading: true, loaded: 67_500_000 }, { local: true, desktop: true })).toBe("Downloading the model (135 MB)… 50 %");
    expect(brainHint("indexing", { ...base, installed: true }, { local: true, desktop: true })).toBe("Loading the model…");
    expect(brainHint("indexing", { ...base, installed: true, ready: true, pending: 1200 }, { local: false, desktop: false })).toContain("1,200 pages to go");
    expect(brainHint("ready", { ...base, installed: true, ready: true, pages: 1, sections: 4, bytes: 2_000_000 }, { local: true, desktop: true })).toBe("Ready. 1 page in 4 sections, 2 MB on this Mac.");
    expect(brainHint("no-server", undefined, { local: false, desktop: false })).toContain("Sync & server");
  });

  it("Server: Stand lesen; 404, Gast oder Fehler heißt „bietet es nicht an“", async () => {
    const ok = fake([{ body: { ...base, installed: true, ready: true, runtime: "wasm" } }]);
    expect(await brainStatus(cfg, ok.fetcher)).toMatchObject({ installed: true, ready: true, runtime: "wasm" });
    expect(ok.calls[0]!.url).toBe("http://127.0.0.1:8787/local/brain");
    expect((ok.calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("Bearer t");
    expect(await brainStatus(cfg, fake([{ status: 404, body: {} }]).fetcher)).toBeUndefined();
    expect(await brainStatus(undefined)).toBeUndefined();
  });

  it("Aktion: POST mit action, danach der neue Stand; Fehler des Servers kommt als Meldung", async () => {
    const f = fake([{ status: 202, body: {} }, { body: { ...base, downloading: true, loaded: 1 } }]);
    expect(await brainModel(cfg, "download", f.fetcher)).toMatchObject({ downloading: true });
    expect(f.calls[0]!.url).toBe("http://127.0.0.1:8787/local/brain/model");
    expect(f.calls[0]!.init!.body).toBe(JSON.stringify({ action: "download" }));
    await expect(brainModel(cfg, "remove", fake([{ status: 409, body: { error: "no embedding model in the catalog" } }]).fetcher)).rejects.toThrow("no embedding model in the catalog");
  });
});
