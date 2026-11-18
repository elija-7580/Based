import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { codeOf, comboAccelerator, parseCombo } from "@based/ui";
import { firstCombo, groupKeymap, hudFor, KEY_GROUPS, KEYMAP, menuEntries, scopeOf, searchKeymap, visibleEntries } from "./keymap.js";
import { matchShortcut } from "./shortcuts.js";

/** Tastendruck (Mac) zu einer Kombination des Registers. */
function press(text: string) {
  const c = parseCombo(text);
  return { key: c.shift && c.key === "/" ? "?" : c.key, code: codeOf(c.key) ?? "", metaKey: c.mod, ctrlKey: c.ctrl, shiftKey: c.shift, altKey: c.alt };
}

describe("Tastatur-Register", () => {
  it("hat eindeutige Kennungen und nur bekannte Abschnitte", () => {
    const ids = KEYMAP.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const e of KEYMAP) expect(KEY_GROUPS).toContain(e.group);
  });

  it("an einer Stelle liegt keine Taste doppelt", () => {
    for (const scope of new Set(KEYMAP.map((e) => e.scope))) {
      const seen = new Map<string, string>();
      for (const e of KEYMAP.filter((x) => x.scope === scope)) for (const k of e.keys.split(" / ")) {
        expect(seen.get(k), `${scope}: ${k} bei ${e.id} und ${seen.get(k)}`).toBeUndefined();
        seen.set(k, e.id);
      }
    }
  });

  it("die App-Kürzel im Register lösen genau ihre Aktion aus (shortcuts.ts)", () => {
    const kinds: Record<string, string> = {
      quickFind: "quickFind", palette: "palette", newPage: "newPage", settings: "settings", shortcuts: "shortcuts", toggleTheme: "toggleTheme",
      reportProblem: "reportProblem", back: "back", forward: "forward", openParent: "openParent", home: "home", focusSidebar: "focusSidebar",
      find: "find", findNext: "findStep", findPrevious: "findStep", newTab: "newTab", closeTab: "closeTab", nextTab: "cycleTab", previousTab: "cycleTab",
    };
    for (const [id, kind] of Object.entries(kinds)) {
      const e = KEYMAP.find((x) => x.id === id)!;
      expect(e, id).toBeDefined();
      expect(matchShortcut(press(firstCombo(e)))?.kind, id).toBe(kind);
    }
    expect(matchShortcut(press("Mod+1"))).toEqual({ kind: "tab", index: 0 });
    expect(matchShortcut(press("Mod+0"))).toBeUndefined();
    // ⌘/ gehört dem Editor (Blockmenü), nur ⇧⌘/ öffnet die Übersicht
    expect(matchShortcut(press("Mod+/"))).toBeUndefined();
  });

  it("sucht in Beschriftung und Abschnitt und gruppiert in fester Reihenfolge", () => {
    const all = visibleEntries({ ai: false });
    expect(all.some((e) => e.id === "chat")).toBe(false);
    expect(searchKeymap(all, "tab close").map((e) => e.id)).toEqual(["closeTab"]);
    expect(searchKeymap(all, "database copy").map((e) => e.id)).toEqual(["db.copy"]);
    expect(groupKeymap(all).map((g) => g.group)).toEqual([...KEY_GROUPS]);
  });

  it("erkennt die Stelle am Fokus", () => {
    const el = (...hits: string[]) => ({ closest: (sel: string) => (hits.some((h) => sel.includes(h)) ? {} : null) });
    expect(scopeOf(null)).toBe("global");
    expect(scopeOf(el("nav.sidebar"))).toBe("sidebar");
    expect(scopeOf(el("[data-editable-id]", "[data-testid=block-editor]"))).toBe("editor");
    expect(scopeOf(el("[data-testid=block-editor]"))).toBe("blocks");
    expect(scopeOf(el("[role=grid]", "[data-testid=block-editor]"))).toBe("database");
    expect(scopeOf(el(".bx2-cell", "[data-testid=block-editor]"))).toBe("table");
    expect(scopeOf(el("[role=menu]", "[role=grid]"))).toBe("menu");
  });

  it("Kurzanzeige: erst die Stelle, dann das Wichtigste von überall; kurz genug für eine Leiste", () => {
    const hud = hudFor("database", { ai: true });
    expect(hud.map((g) => g.title)).toEqual(["In a database table", "Everywhere"]);
    for (const scope of ["global", "sidebar", "editor", "blocks", "database", "table", "menu"] as const) {
      const groups = hudFor(scope, { ai: true });
      expect(groups[0]!.entries.length, scope).toBeGreaterThan(0);
      expect(groups.reduce((n, g) => n + g.entries.length, 0), scope).toBeLessThanOrEqual(14);
    }
  });

  it("das Mac-Menü (lib.rs) nennt genau die Menü-Einträge des Registers, mit denselben Tasten", () => {
    const rs = readFileSync(new URL("../../../desktop/src-tauri/src/menu.rs", import.meta.url), "utf8");
    const found = [...rs.matchAll(/command\(app, "([^"]+)", "([^"]+)", "([^"]+)"\)/g)].map((m) => ({ id: m[1]!, label: m[2]!, accel: m[3]!.replace(/\\\\/g, "\\") }));
    const want = Object.values(menuEntries()).flat().map((e) => ({ id: e.id, label: e.menuLabel ?? e.label, accel: comboAccelerator(firstCombo(e)) }));
    const byID = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...found].sort(byID)).toEqual([...want].sort(byID));
    // Reihenfolge je Menü wie im Register
    for (const [menu, entries] of Object.entries(menuEntries())) {
      const block = new RegExp(`let ${menu.toLowerCase()}_menu = [\\s\\S]*?\\)\\?;`).exec(rs)?.[0] ?? "";
      const order = [...block.matchAll(/command\(app, "([^"]+)"/g)].map((m) => m[1]);
      expect(order, menu).toEqual(entries.map((e) => e.id));
    }
  });
});
