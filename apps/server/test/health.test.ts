import { expect, it } from "vitest";
import { health } from "../src/index.js";

it("meldet Sync v2", () => expect(health()).toEqual({ ok: true, protocol: 2 }));
