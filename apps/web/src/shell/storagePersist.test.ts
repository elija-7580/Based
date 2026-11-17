// ADR 0017 A3: dauerhafter Web-Speicher – Anfrage erst nach einer Eingabe, ehrliche Zeile in den Einstellungen.
import { describe, expect, it } from "vitest";
import { browserKeep, installBrowserKeep, keepRow, resolveKeep } from "./storagePersist.js";

describe("dauerhafter Web-Speicher", () => {
  it("liest erst nur; fragt an, wenn gewünscht; Fehler und fehlende API stürzen nicht ab", async () => {
    let asked = 0;
    const no = { persisted: async () => false, persist: async () => { asked += 1; return true; } };
    expect(await resolveKeep(no, false)).toBe("notKept");
    expect(asked).toBe(0);
    expect(await resolveKeep(no, true)).toBe("kept");
    expect(asked).toBe(1);
    expect(await resolveKeep({ persisted: async () => true, persist: async () => { throw new Error("nicht nötig"); } }, true)).toBe("kept");
    expect(await resolveKeep({ persisted: async () => false, persist: async () => false }, true)).toBe("notKept");
    expect(await resolveKeep({ persisted: async () => { throw new Error("blocked"); }, persist: async () => true }, true)).toBe("notKept");
    expect(await resolveKeep(undefined, true)).toBe("unsupported");
    expect(await resolveKeep({}, true)).toBe("unsupported");
  });

  it("Zeile: geschützt, nicht geschützt mit und ohne Server, sonst nichts", () => {
    expect(keepRow("kept", false)?.value).toBe("Protected");
    expect(keepRow("notKept", false)?.hint).toMatch(/Connect a server or export/);
    expect(keepRow("notKept", true)?.hint).toMatch(/server keeps a copy/);
    expect(keepRow("unknown", false)).toBeUndefined();
    expect(keepRow("unsupported", true)).toBeUndefined();
  });

  it("fragt genau einmal nach der ersten Eingabe und meldet den Stand", async () => {
    let asked = 0;
    let granted = false;
    const handlers = new Map<string, () => void>();
    const win = {
      navigator: { storage: { persisted: async () => granted, persist: async () => { asked += 1; granted = true; return true; } } },
      addEventListener: (type: string, fn: () => void) => void handlers.set(type, fn),
      removeEventListener: (type: string) => void handlers.delete(type),
    };
    const seen: string[] = [];
    browserKeep.subscribe(() => seen.push(browserKeep.get()));
    installBrowserKeep(win as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(browserKeep.get()).toBe("notKept");
    expect(asked).toBe(0);
    handlers.get("keydown")!();
    handlers.get("pointerdown")?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toBe(1);
    expect(browserKeep.get()).toBe("kept");
    expect(handlers.size).toBe(0);
    expect(seen).toEqual(["notKept", "kept"]);
  });
});
