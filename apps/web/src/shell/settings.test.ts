import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS_PAGE, listedSettingsPages, resolveSettingsPage, searchSettings, SETTINGS_GROUPS, SETTINGS_PAGES, SettingsRegistry, validateSyncForm, visibleSettingsPages } from "./settings.js";

describe("Einstellungen: Modell", () => {
  it("drei Gruppen: App, Workspace, System; IDs eindeutig, jede Seite in einer Gruppe", () => {
    expect(SETTINGS_GROUPS.map((g) => g.title)).toEqual(["App", "Workspace", "System"]);
    expect(SETTINGS_PAGES.filter((p) => p.group === "app").map((p) => p.title)).toEqual(["Appearance", "Pages", "Meeting notes", "Language & region", "Notifications", "Connected accounts"]);
    expect(SETTINGS_PAGES.filter((p) => p.group === "workspace")).toHaveLength(9);
    expect(SETTINGS_PAGES.filter((p) => p.group === "system").map((p) => p.title)).toEqual(["This device", "Connect AI apps", "Updates", "Diagnostics", "About"]);
    expect(new Set(SETTINGS_PAGES.map((p) => p.id)).size).toBe(SETTINGS_PAGES.length);
    for (const p of SETTINGS_PAGES) expect(SETTINGS_GROUPS.some((g) => g.id === p.group), p.id).toBe(true);
  });
  it("alte Links auf „My settings“ öffnen Appearance", () => {
    expect(resolveSettingsPage("my-settings").id).toBe("appearance");
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
  it("Seiten ohne eigenen Abschnitt stehen nicht in der Liste – nur in der Entwickler-Ansicht", () => {
    const r = new SettingsRegistry<string>();
    r.register({ id: "look", title: "Appearance", page: "appearance", component: "" });
    expect(listedSettingsPages(SETTINGS_PAGES, r).map((p) => p.id)).toEqual(["appearance"]);
    const off = r.register({ id: "members", title: "Members", page: "people", component: "" });
    expect(listedSettingsPages(SETTINGS_PAGES, r).map((p) => p.id)).toEqual(["appearance", "people"]);
    off();
    expect(listedSettingsPages(SETTINGS_PAGES, r).map((p) => p.id)).toEqual(["appearance"]);
    expect(listedSettingsPages(SETTINGS_PAGES, r, {}, true)).toHaveLength(SETTINGS_PAGES.length);
    // ein alter Link auf eine nicht gelistete Seite öffnet Appearance
    expect(resolveSettingsPage("people", listedSettingsPages(SETTINGS_PAGES, r)).id).toBe("appearance");
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

describe("Einstellungen: AI-Schalter", () => {
  it("ohne AI fehlen reine AI-Seiten und AI-Abschnitte; „Not available yet“ der AI-Seiten fällt weg", () => {
    expect(visibleSettingsPages(SETTINGS_PAGES, { ai: false }).map((p) => p.id)).not.toContain("connections");
    expect(visibleSettingsPages(SETTINGS_PAGES).map((p) => p.id)).toContain("connections");
    const r = new SettingsRegistry<string>();
    r.register({ id: "switch", page: "agents", title: "AI", component: "s" });
    r.register({ id: "models", page: "agents", title: "Models", ai: true, component: "m", provides: ["Permissions"] });
    expect(r.sectionsFor("agents", { ai: false }).map((s) => s.id)).toEqual(["switch"]);
    expect(r.sectionsFor("agents").map((s) => s.id)).toEqual(["switch", "models"]);
    expect(r.missingFor("agents", { ai: false })).toEqual([]);
    expect(r.missingFor("agents")).toContain("Skills");
  });
});

describe("Einstellungen: Suche", () => {
  const reg = () => {
    const r = new SettingsRegistry<string>();
    r.register({ id: "appearance", title: "Appearance", page: "appearance", component: "", keywords: ["Theme", "Dark mode", "Font", "Density"] });
    r.register({ id: "writing", title: "New pages", page: "editor", component: "", keywords: ["Default font", "Spell-check", "Full width"] });
    r.register({ id: "sync-server", title: "Based server", page: "sync", description: "Address and token of your own server", component: "", keywords: ["Server address", "Token"] });
    r.register({ id: "keys", title: "Models and keys", page: "agents", ai: true, component: "", keywords: ["API keys"] });
    return r;
  };
  const find = (q: string, opts = {}) => searchSettings(q, SETTINGS_PAGES, reg(), opts);
  it("findet einzelne Einstellungen über ihr Stichwort und nennt, wo sie liegen", () => {
    expect(find("dark")[0]).toEqual({ page: "appearance", section: "appearance", label: "Dark mode", where: "Appearance" });
    expect(find("spell")[0]).toEqual({ page: "editor", section: "writing", label: "Spell-check", where: "Pages · New pages" });
    expect(find("token")[0]!.page).toBe("sync");
  });
  it("findet Seiten am Titel, auch ohne Abschnitte", () => {
    expect(find("diagn")[0]).toEqual({ page: "diagnostics", label: "Diagnostics", where: "Page" });
    expect(find("sync")[0]!.page).toBe("sync");
  });
  it("verzeiht einen Tippfehler", () => {
    expect(find("thme")[0]!.label).toBe("Theme");
    expect(find("apearance")[0]!.page).toBe("appearance");
    expect(find("spellchek")[0]?.label ?? find("spell chek")[0]?.label).toBe("Spell-check");
  });
  it("alle Wörter müssen passen; Leeres und Unsinn finden nichts", () => {
    expect(find("default font")[0]!.label).toBe("Default font");
    expect(find("font")[0]!.page).toBe("appearance");
    expect(find("")).toEqual([]);
    expect(find("   ")).toEqual([]);
    expect(find("xyzzy")).toEqual([]);
    // ein Tippfehler heißt nicht „irgendein ähnliches Wort“: „font“ findet nichts mit „content“
    const r = reg();
    r.register({ id: "ws", title: "Workspace", page: "workspace", component: "", keywords: ["Export all content"] });
    expect(searchSettings("font", SETTINGS_PAGES, r).some((h) => h.label === "Export all content")).toBe(false);
    r.register({ id: "week", title: "Week", page: "language", component: "", keywords: ["Calendar"] });
    expect(searchSettings("calm", SETTINGS_PAGES, r)).toEqual([]);
    expect(searchSettings("calen", SETTINGS_PAGES, r)[0]!.label).toBe("Calendar");
    expect(searchSettings("calandar", SETTINGS_PAGES, r)[0]!.label).toBe("Calendar");
  });
  it("je Abschnitt ein Treffer, höchstens `limit`", () => {
    const hits = find("font");
    expect(new Set(hits.map((h) => h.page + "/" + h.section)).size).toBe(hits.length);
    expect(searchSettings("e", SETTINGS_PAGES, reg(), {}, 3).length).toBeLessThanOrEqual(3);
  });
  it("ohne AI keine AI-Abschnitte; nur Seiten, die übergeben werden", () => {
    expect(find("api keys", { ai: false }).some((h) => h.section === "keys")).toBe(false);
    expect(find("api keys").some((h) => h.section === "keys")).toBe(true);
    const beta = SETTINGS_PAGES.filter((p) => p.id !== "agents");
    expect(searchSettings("agents", beta, reg()).some((h) => h.page === "agents")).toBe(false);
  });
});
