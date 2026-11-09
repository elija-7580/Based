import { describe, expect, it } from "vitest";
import { isTauri } from "./desktop.js";

describe("desktop (BSD-164)", () => {
  it("erkennt die Tauri-Hülle an __TAURI_INTERNALS__", () => {
    expect(isTauri({})).toBe(false);
    expect(isTauri({ __TAURI_INTERNALS__: {} })).toBe(true);
  });
});
