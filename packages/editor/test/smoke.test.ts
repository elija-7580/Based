import { expect, it } from "vitest";
import { EDITOR_PLACEHOLDER } from "../src/index.js";

it("lädt", () => expect(EDITOR_PLACEHOLDER).toBe("editor"));
