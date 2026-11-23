// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../src-tauri/${f}`, import.meta.url), "utf8");
const conf = JSON.parse(read("tauri.conf.json"));

test("Hülle zeigt auf apps/web und bleibt dünn (keine Plugins, nur der Kern)", () => {
  assert.equal(conf.build.frontendDist, "../../web/dist");
  assert.equal(conf.plugins, undefined);
  assert.deepEqual(JSON.parse(read("capabilities/default.json")).permissions, ["core:default"]);
  assert.doesNotMatch(read("Cargo.toml"), /tauri-plugin/);
});

test("Mikrofon-Hinweis fürs iPhone ist gesetzt (Sprachnotizen, Meetings)", () => {
  assert.match(read("Info.ios.plist"), /NSMicrophoneUsageDescription/);
});

test("Icons liegen vor", () => {
  for (const f of conf.bundle.icon) assert.ok(existsSync(new URL(`../src-tauri/${f}`, import.meta.url)), f);
});
