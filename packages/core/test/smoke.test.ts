import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.js";

describe("@based/core", () => {
  it("lädt", () => expect(CORE_VERSION).toBe("0.0.0"));
});

it("Tests laufen in UTC (fixtures/*.utc.json)", () => {
  expect(new Date(0).getTimezoneOffset()).toBe(0);
  expect(new Date(Date.UTC(2024, 6, 1)).getTimezoneOffset()).toBe(0);
});
