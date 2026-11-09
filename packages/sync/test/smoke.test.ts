import { expect, it } from "vitest";
import { SYNC_PROTOCOL_VERSION, coreVersion } from "../src/index.js";

it("spricht Sync v2 und sieht den Kern", () => {
  expect(SYNC_PROTOCOL_VERSION).toBe(2);
  expect(coreVersion).toBe("0.0.0");
});
