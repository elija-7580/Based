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

test("BSD-138/414: Bundle und Node als Resource (kein externalBin); Shell-Plugin nur für vier feste Aufrufe", () => {
  assert.equal(conf.bundle.externalBin, undefined);
  // BSD-314: node-pty (native Datei für das Terminal) liegt daneben in node_modules/, nicht im Bundle.
  // BSD-414: die mitgelieferte Node liegt als Resource node/ bei (fetch-node.mjs), weiter kein externalBin.
  assert.deepEqual(conf.bundle.resources, { "../dist-sidecar/based-server.cjs": "based-server.cjs", "../dist-sidecar/node_modules/": "node_modules/", "../dist-sidecar/node/": "node/" });
  assert.match(conf.build.beforeBuildCommand, /@based\/desktop sidecar/);
  assert.match(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.sidecar, /fetch-node\.mjs/);
  assert.match(conf.build.beforeDevCommand, /@based\/desktop sidecar/);
  const cap = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/local-server.json", import.meta.url), "utf8"));
  assert.deepEqual(cap.windows, ["main"]);
  for (const id of ["shell:allow-execute", "shell:allow-spawn"]) {
    const p = cap.permissions.find((x) => typeof x === "object" && x.identifier === id);
    assert.deepEqual(p.allow.map((a) => [a.name, a.cmd, a.args]), [
      ["based-node-probe", "/bin/zsh", ["-ilc", "command -v node && node --version"]],
      ["based-node-run", "/bin/zsh", ["-ilc", 'exec node "$BASED_BUNDLE" desktop']],
      ["based-node-bundled-probe", "/bin/sh", ["-c", `printf '%s\\n' "$BASED_NODE" && exec "$BASED_NODE" --version`]],
      ["based-node-bundled-run", "/bin/zsh", ["-ilc", 'exec "$BASED_NODE" "$BASED_BUNDLE" desktop']],
    ]);
    assert.ok(p.allow.every((a) => a.sidecar !== true && Array.isArray(a.args) && a.args.every((x) => typeof x === "string")));
  }
  assert.ok(!cap.permissions.includes("shell:default") && !cap.permissions.includes("shell:allow-open"));
  const def = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  assert.ok(!JSON.stringify(def).includes("shell:"));
  assert.match(readFileSync(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"), /tauri-plugin-shell = "2"/);
  const lib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /tauri_plugin_shell::init\(\)/);
  assert.match(lib, /desktop:\/\/install-cli/);
});

test("BSD-138: Bundle läuft mit Node; Starter anlegen, benutzen, entfernen (Temp-Verzeichnis)", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, rmSync, statSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("..", import.meta.url));
  execFileSync(process.execPath, ["scripts/build-sidecar.mjs"], { cwd: dir, stdio: "ignore" });
  const bundle = join(dir, "dist-sidecar", "based-server.cjs");
  assert.equal(execFileSync(process.execPath, [bundle, "cli", "--version"], { encoding: "utf8" }).trim(), "based 0.1.0");
  const home = mkdtempSync(join(tmpdir(), "based-cli-home-"));
  try {
    const run = (action, extra = {}) => {
      const out = execFileSync(process.execPath, [bundle, "desktop"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home, BASED_ACTION: action, BASED_BUNDLE: bundle, ...extra } });
      return JSON.parse(/BASED_RESULT (.*)/.exec(out)[1]);
    };
    const target = join(home, ".local", "bin", "based");
    assert.equal(run("cli-status").installed, false);
    const inst = run("install-cli");
    assert.equal(inst.ok, true);
    assert.equal(inst.target, target);
    assert.equal(inst.inPath, false);
    assert.match(inst.message, /isn't in your PATH/);
    assert.equal(statSync(target).mode & 0o777, 0o755);
    assert.equal(execFileSync(target, ["--version"], { encoding: "utf8" }).trim(), "based 0.1.0");
    assert.equal(run("cli-status").installed, true);
    assert.equal(run("install-cli").ok, true); // erneut: ersetzt den eigenen Starter
    assert.equal(run("uninstall-cli").message, "Removed.");
    assert.equal(run("cli-status").installed, false);
    // fremde Datei: nicht überschreiben, nicht löschen
    const foreign = join(home, "bin-based");
    writeFileSync(foreign, "#!/bin/sh\necho mine\n");
    assert.equal(run("install-cli", { BASED_TARGET: foreign }).ok, false);
    assert.equal(run("uninstall-cli", { BASED_TARGET: foreign }).ok, false);
    // unbekannte Aktion
    assert.throws(() => run("nope"));
    // lokaler Server: dieselbe Node, meldet die Adresse, endet mit stdin
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [bundle, "desktop"], { env: { PATH: process.env.PATH, HOME: home, BASED_ACTION: "local", BASED_PORT: "0", BASED_DB: join(home, "local.sqlite"), BASED_TOKEN: "token-0123456789abcdef", BASED_LOG_LEVEL: "warning" }, stdio: ["pipe", "pipe", "ignore"] });
    const url = await new Promise((resolve, reject) => {
      let buf = "";
      child.stdout.setEncoding("utf8").on("data", (d) => { buf += d; const m = /BASED_LOCAL_READY (\{.*\})/.exec(buf); if (m) resolve(JSON.parse(m[1]).url); });
      child.once("exit", () => reject(new Error("exited")));
    });
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(execFileSync(target === "" ? "" : process.execPath, [bundle, "cli", "config"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home } }).split("\n")[0], `Server: ${url}`);
    const exited = new Promise((r) => child.once("exit", (code) => r(code)));
    child.stdin.end();
    assert.equal(await exited, 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("BSD-414: Node-Laufzeit – Ziel, gepinnte Prüfsumme, nie ein Build-Abbruch", async () => {
  const { NODE_SHA256, NODE_VERSION, archiveName, fetchNode, nodeTarget, verifyArchive } = await import("../scripts/fetch-node.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.match(NODE_VERSION, /^v2[2-9]\.\d+\.\d+$/);
  assert.equal(nodeTarget({ triple: "universal-apple-darwin" }), "darwin-arm64");
  assert.equal(nodeTarget({ triple: "aarch64-apple-darwin" }), "darwin-arm64");
  assert.equal(nodeTarget({ triple: "x86_64-apple-darwin" }), "darwin-x64");
  assert.equal(nodeTarget({ triple: "x86_64-pc-windows-msvc" }), undefined);
  assert.equal(nodeTarget({ platform: "darwin", arch: "arm64" }), "darwin-arm64");
  assert.equal(nodeTarget({ platform: "win32", arch: "x64" }), undefined);
  for (const v of Object.values(NODE_SHA256)) assert.match(v, /^[0-9a-f]{64}$/);
  assert.equal(archiveName("darwin-arm64"), `node-${NODE_VERSION}-darwin-arm64.tar.gz`);
  assert.equal(verifyArchive("darwin-arm64", Buffer.from("not node")), false);
  const dir = mkdtempSync(join(tmpdir(), "based-node-"));
  try {
    const logs = [];
    // kein Netz / falsche Datei: kein Abbruch, nur README (die App nimmt dann die Node des Nutzers)
    const offline = await fetchNode({ out: join(dir, "out"), cache: join(dir, "cache"), target: "darwin-arm64", fetcher: async () => { throw new Error("offline"); }, log: (m) => logs.push(m) });
    assert.equal(offline, false);
    const bad = await fetchNode({ out: join(dir, "out"), cache: join(dir, "cache"), target: "darwin-arm64", fetcher: async () => new Response("evil"), log: (m) => logs.push(m) });
    assert.equal(bad, false);
    assert.ok(logs.some((l) => l.includes("checksum mismatch")));
    assert.equal(existsSync(join(dir, "out", "README.txt")), true);
    assert.equal(existsSync(join(dir, "out", "bin", "node")), false);
    assert.equal(await fetchNode({ out: join(dir, "out"), cache: join(dir, "cache"), target: undefined, log: () => {} }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

