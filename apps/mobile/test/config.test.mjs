// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

const read = (f) => readFileSync(new URL(`../src-tauri/${f}`, import.meta.url), "utf8");
const conf = JSON.parse(read("tauri.conf.json"));

test("Hülle zeigt auf apps/web und bleibt dünn (nur der Kern und das eine native Extra: Eingang der Apple Watch)", () => {
  assert.equal(conf.build.frontendDist, "../../web/dist");
  assert.equal(conf.plugins, undefined);
  assert.deepEqual(JSON.parse(read("capabilities/default.json")).permissions, ["core:default", "based-watch:default"]);
  const plugins = [...read("Cargo.toml").matchAll(/tauri-plugin-[a-z-]+/g)].map((m) => m[0]);
  assert.deepEqual(plugins, ["tauri-plugin-based-watch"]);
  assert.match(read("src/lib.rs"), /\.plugin\(based_watch::init\(\)\)/);
});

test("Apple Watch: Plugin, Oberfläche und Uhr-App sprechen dieselbe Sprache", () => {
  const repo = (f) => readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
  // Befehle: build.rs (Rechte), Rust (Handler), Swift (Umsetzung), Oberfläche (Aufruf)
  const commands = JSON.parse(read("plugins/watch/build.rs").match(/COMMANDS: &\[&str\] = &(\[[^\]]*\])/)[1]);
  assert.deepEqual(commands, ["pending", "read", "done"]);
  const swift = read("plugins/watch/ios/Sources/WatchPlugin.swift");
  const web = repo("apps/web/src/mobile/watchInbox.ts");
  for (const c of commands) {
    assert.match(read("plugins/watch/src/lib.rs"), new RegExp(`async fn ${c}<`), c);
    assert.match(swift, new RegExp(`@objc public func ${c}\\(_ invoke: Invoke\\)`), c);
    assert.match(web, new RegExp(`call(<[^>]*>+)?\\("${c}"`), c);
    assert.match(read("plugins/watch/permissions/default.toml"), new RegExp(`"allow-${c}"`), c);
  }
  assert.match(web, /plugin:based-watch\|/);
  assert.match(read("plugins/watch/src/lib.rs"), /Builder::new\("based-watch"\)/);
  assert.match(read("plugins/watch/src/lib.rs"), /ios_plugin_binding!\(init_plugin_based_watch\)/);
  assert.match(swift, /@_cdecl\("init_plugin_based_watch"\)/);
  // Swift-Paket heißt wie die Kiste (tauri-plugin bindet die Bibliothek unter CARGO_PKG_NAME).
  assert.match(read("plugins/watch/ios/Package.swift"), /name: "tauri-plugin-based-watch", type: \.static/);
  // Ereignis und Kennung der Übertragung
  assert.match(swift, /new Event\('based:watch-inbox'\)/);
  assert.match(web, /WATCH_INBOX_EVENT = "based:watch-inbox"/);
  const shared = repo("apps/watch/Shared/WatchCaptureTransfer.swift");
  const kind = shared.match(/static let kind = "([^"]+)"/)[1];
  assert.match(swift, new RegExp(`static let kind = "${kind}"`));
  // Die Uhr-App ist Begleiter genau dieser iPhone-App.
  const project = repo("apps/watch/project.yml");
  assert.match(project, new RegExp(`BASED_BUNDLE_ID: ${conf.identifier.replaceAll(".", "\\.")}\\n`));
  assert.match(project, /WKCompanionAppBundleIdentifier: \$\(BASED_BUNDLE_ID\)/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: \$\(BASED_BUNDLE_ID\)\.watchkitapp\n/);
  assert.match(project, /NSMicrophoneUsageDescription/);
});

test("Mikrofon-Hinweis fürs iPhone ist gesetzt (Sprachnotizen, Meetings)", () => {
  assert.match(read("Info.ios.plist"), /NSMicrophoneUsageDescription/);
});

test("Icons liegen vor", () => {
  for (const f of conf.bundle.icon) assert.ok(existsSync(new URL(`../src-tauri/${f}`, import.meta.url)), f);
});

test("iPhone-Symbol: Based-Logo, 1024 × 1024, liegt vor (der Workflow erzeugt daraus alle Größen)", () => {
  const png = readFileSync(new URL("../src-tauri/icons/icon.png", import.meta.url));
  assert.equal(png.readUInt32BE(16), 1024);
  assert.equal(png.readUInt32BE(20), 1024);
  assert.equal(png[25], 2, "ohne Alphakanal (App Store lehnt durchsichtige Symbole ab)");
});
