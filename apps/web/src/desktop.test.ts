import { describe, expect, it } from "vitest";
import { isTauri } from "./desktop.js";

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
