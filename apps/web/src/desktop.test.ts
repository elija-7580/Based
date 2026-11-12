import { describe, expect, it } from "vitest";
import { isTauri, updatePrompt } from "./desktop.js";

describe("desktop (BSD-164)", () => {
  it("erkennt die Tauri-Hülle an __TAURI_INTERNALS__", () => {
    expect(isTauri({})).toBe(false);
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});

describe("Seitenfenster (BSD-202)", () => {
  it("Adresse mit ?window=page und Hash der Seite; erkennt das Seitenfenster", async () => {
    const { isPageWindow, pageWindowURL } = await import("./desktop.js");
    expect(pageWindowURL("tauri://localhost/index.html#home", "page-ABC")).toBe("tauri://localhost/index.html?window=page#page-ABC");
    expect(pageWindowURL("http://localhost:5173/?x=1#home", "page-ABC")).toBe("http://localhost:5173/?x=1&window=page#page-ABC");
    expect(isPageWindow("?window=page")).toBe(true);
    expect(isPageWindow("")).toBe(false);
  });
});

describe("Update-Notizen (BSD-168)", () => {
  it("zeigt die Notizen aus latest.json, kürzt auf 12 Zeilen", () => {
    expect(updatePrompt("0.1.70", "0.1.62")).toBe("Based Next 0.1.70 is available (you have 0.1.62).\n\nInstall it and restart now?");
    const p = updatePrompt("0.1.70", "0.1.62", "• AI chat button\n\n• ⇧⌘U opens the parent page\n");
    expect(p).toContain("What’s new:\n• AI chat button\n• ⇧⌘U opens the parent page\n\nInstall");
    const long = updatePrompt("1", "0", Array.from({ length: 15 }, (_, i) => `• item ${i}`).join("\n"));
    expect(long).toContain("• item 11\n… and 3 more");
    expect(long).not.toContain("item 12");
  });
});
