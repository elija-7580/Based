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

test("Seitenfenster (BSD-202): Rechte gelten auch für page-*, Fenster dürfen angelegt werden", () => {
  const cap = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.deepEqual(cap.windows, ["main", "page-*"]);
  assert.ok(cap.permissions.includes("core:webview:allow-create-webview-window"));
});

test("BSD-138: Beilage based-server, nur vom Hauptfenster, nur dieser Sidecar; Plugin in Cargo.toml und lib.rs", () => {
  assert.deepEqual(conf.bundle.externalBin, ["binaries/based-server"]);
  assert.match(conf.build.beforeBuildCommand, /@based\/desktop sidecar/);
  assert.match(conf.build.beforeDevCommand, /@based\/desktop sidecar/);
  const cap = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/local-server.json", import.meta.url), "utf8"));
  assert.deepEqual(cap.windows, ["main"]);
  const spawn = cap.permissions.find((p) => typeof p === "object" && p.identifier === "shell:allow-spawn");
  assert.deepEqual(spawn.allow.map((a) => [a.name, a.sidecar]), [["binaries/based-server", true]]);
  assert.ok(!cap.permissions.includes("shell:default") && !cap.permissions.includes("shell:allow-execute") && !cap.permissions.includes("shell:allow-open"));
  const def = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.ok(!JSON.stringify(def).includes("shell:"));
  assert.match(readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"), /tauri-plugin-shell = "2"/);
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /tauri_plugin_shell::init\(\)/);
  assert.match(lib, /desktop:\/\/install-cli/);
});

test("BSD-138: Beilage bündelt und spielt beide Rollen (cli / Server)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, ["scripts/build-sidecar.mjs", "--bundle"], { cwd: dir, stdio: "ignore" });
  const out = execFileSync(process.execPath, ["dist-sidecar/based-server.cjs", "cli", "--version"], { cwd: dir, encoding: "utf8" });
  assert.equal(out.trim(), "based 0.1.0");
  let failed;
  try {
    execFileSync(process.execPath, ["dist-sidecar/based-server.cjs", "--local", "--stdio"], { cwd: dir, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    failed = String(e.stderr);
  }
  assert.match(failed ?? "", /--local and --stdio/);
});
