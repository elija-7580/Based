import { expect, it } from "vitest";
import { describeNotionError, notionBaseURL } from "./notionTransport.js";

it("Browser ohne Desktop-Hülle: Netzwerkfehler erklärt die CORS-Grenze, in der App die Verbindung", () => {
  expect(describeNotionError(new TypeError("Failed to fetch"), { tauri: false })).toMatch(/desktop app/);
  expect(describeNotionError(new TypeError("Load failed"), { tauri: true })).toMatch(/internet connection/);
  expect(describeNotionError(new TypeError("Failed to fetch"), { tauri: false, customBase: true })).toMatch(/internet connection/);
});

it("API-Fehler bleiben wörtlich (ohne Token)", () => {
  expect(describeNotionError(new Error("Notion rejected the integration token. API token is invalid."), { tauri: true })).toBe("Notion rejected the integration token. API token is invalid.");
});

it("Test-Adresse nur aus __based.notionBaseURL", () => {
  expect(notionBaseURL({})).toBeUndefined();
  expect(notionBaseURL({ __based: { notionBaseURL: "http://localhost:1/v1" } })).toBe("http://localhost:1/v1");
});
