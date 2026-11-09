import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("@based/core", () => {
  it("lädt", () => expect(CORE_VERSION).toBe("0.0.0"));
});
