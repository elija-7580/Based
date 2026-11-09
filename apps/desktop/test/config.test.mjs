import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Tauri-Config zeigt auf apps/web", () => {
  const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(conf.build.frontendDist, "../../web/dist");
  assert.ok(conf.bundle.targets.includes("dmg"));
});
