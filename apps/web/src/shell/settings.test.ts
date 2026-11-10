import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_PAGE, resolveSettingsPage, SETTINGS_GROUPS, SETTINGS_PAGES, SettingsRegistry, validateSyncForm } from "./settings.js";

describe("Einstellungen: Modell", () => {
  it("Seiten wie in der Swift-Vorlage: 5 unter Account, 12 unter Workspace, IDs eindeutig", () => {
    expect(SETTINGS_PAGES.filter((p) => p.group === "account").map((p) => p.title)).toEqual(["My account", "My settings", "My notifications", "My connections", "Language & region"]);
    expect(SETTINGS_PAGES.filter((p) => p.group === "workspace")).toHaveLength(12);
    expect(new Set(SETTINGS_PAGES.map((p) => p.id)).size).toBe(SETTINGS_PAGES.length);
    expect(SETTINGS_GROUPS.map((g) => g.id)).toEqual(["account", "workspace"]);
  });
  it("unbekannte Seite fällt auf die Standardseite zurück", () => {
    expect(resolveSettingsPage("sync").id).toBe("sync");
    expect(resolveSettingsPage(undefined).id).toBe(DEFAULT_SETTINGS_PAGE);
    expect(resolveSettingsPage("gibt-es-nicht").id).toBe(DEFAULT_SETTINGS_PAGE);
  });
});

describe("Einstellungen: Registry", () => {
  it("ordnet nach order, dann nach Anmeldung, und meldet wieder ab", () => {
    const r = new SettingsRegistry<string>();
    const offB = r.register({ id: "b", title: "B", page: "sync", component: "B" });
    r.register({ id: "a", title: "A", page: "sync", order: 10, component: "A" });
    r.register({ id: "c", title: "C", page: "sync", component: "C" });
    r.register({ id: "w", title: "W", component: "W" });
    expect(r.sectionsFor("sync").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(r.sectionsFor("workspace").map((s) => s.id)).toEqual(["w"]);
    offB();
    expect(r.sectionsFor("sync").map((s) => s.id)).toEqual(["a", "c"]);
  });
  it("gleiche ID ersetzt und behält den Platz; das alte Abmelden trifft den neuen nicht", () => {
    const r = new SettingsRegistry<string>();
    const offOld = r.register({ id: "x", title: "X", page: "about", component: "old" });
    r.register({ id: "y", title: "Y", page: "about", component: "y" });
    r.register({ id: "x", title: "X2", page: "about", component: "new" });
    expect(r.sectionsFor("about").map((s) => s.component)).toEqual(["new", "y"]);
    offOld();
    expect(r.sectionsFor("about")).toHaveLength(2);
  });
  it("lehnt unbekannte Seiten und leere IDs ab", () => {
    const r = new SettingsRegistry<string>();
    expect(() => r.register({ id: "x", title: "X", page: "nope", component: "" })).toThrow(/Unknown settings page/);
    expect(() => r.register({ id: " ", title: "X", component: "" })).toThrow();
  });
  it("Status und „Not available yet“ folgen den angemeldeten Abschnitten", () => {
    const r = new SettingsRegistry<string>();
    expect(r.status("agents")).toBe("unavailable");
    expect(r.missingFor("agents")).toContain("API keys for AI providers");
    const off = r.register({ id: "keys", title: "API keys", page: "agents", provides: ["API keys for AI providers"], component: "" });
    expect(r.status("agents")).toBe("partial");
    expect(r.missingFor("agents")).not.toContain("API keys for AI providers");
    r.register({ id: "imp", title: "Import", page: "import", component: "" });
    expect(r.status("import")).toBe("available");
    off();
    expect(r.status("agents")).toBe("unavailable");
  });
  it("meldet Änderungen", () => {
    const r = new SettingsRegistry<string>();
    let calls = 0;
    const stop = r.subscribe(() => calls++);
    const v = r.getVersion();
    const off = r.register({ id: "x", title: "X", component: "" });
    off();
    off(); // zweimal abmelden ist harmlos
    expect(calls).toBe(2);
    expect(r.getVersion()).toBe(v + 2);
    stop();
  });
});

describe("Sync-Formular", () => {
  it("nimmt http(s)-Adressen, schneidet Leerzeichen und Schrägstriche am Ende ab", () => {
    expect(validateSyncForm({ url: "  https://based.example.com/ ", token: " t " })).toEqual({ ok: true, config: { url: "https://based.example.com", token: "t" } });
    expect(validateSyncForm({ url: "http://127.0.0.1:9", token: "" })).toEqual({ ok: true, config: { url: "http://127.0.0.1:9", token: "" } });
  });
  it("lehnt Leeres, Unlesbares, andere Protokolle und Zugangsdaten in der Adresse ab", () => {
    for (const url of ["", "   ", "based.example.com", "ftp://x.example", "https://user:pw@x.example"]) {
      const r = validateSyncForm({ url, token: "t" });
      expect(r.ok, url).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  });
});
