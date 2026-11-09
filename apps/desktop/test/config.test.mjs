import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const conf = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("Tauri-Config zeigt auf apps/web", () => {
  assert.equal(conf.build.frontendDist, "../../web/dist");
  assert.ok(conf.bundle.targets.includes("app"));
});

test("Based Next ist parallel zur Swift-App installierbar", () => {
  assert.equal(conf.productName, "Based Next");
  assert.equal(conf.identifier, "com.friedrich-ulrich.based.next");
  assert.notEqual(conf.identifier, "com.friedrich-ulrich.based");
});

test("ad hoc signiert, Overlay-Titelleiste", () => {
  assert.equal(conf.bundle.macOS.signingIdentity, "-");
  assert.equal(conf.app.windows[0].titleBarStyle, "Overlay");
});

test("Updater liest die next-Releases und hat einen öffentlichen Schlüssel", () => {
  const u = conf.plugins.updater;
  assert.match(Buffer.from(u.pubkey, "base64").toString("utf8"), /minisign public key/);
  assert.deepEqual(u.endpoints, ["https://github.com/elija-7580/Based/releases/download/next-latest/latest.json"]);
});

test("Icons liegen vor", () => {
  for (const f of conf.bundle.icon) assert.ok(existsSync(new URL(`../src-tauri/${f}`, import.meta.url)), f);
});
