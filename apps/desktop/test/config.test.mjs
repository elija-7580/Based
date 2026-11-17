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

test("BSD-467: Opener darf nur mailto öffnen (Problem melden → Mail), keine beliebigen Adressen", () => {
  const cap = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  const open = cap.permissions.filter((x) => (typeof x === "string" ? x : x.identifier).startsWith("opener:allow-open"));
  assert.deepEqual(open, [{ identifier: "opener:allow-open-url", allow: [{ url: "mailto:*" }] }]);
  assert.ok(!cap.permissions.includes("opener:default"));
});

test("BSD-138/414: Bundle und Node als Resource (kein externalBin); Shell-Plugin nur für vier feste Aufrufe", () => {
  assert.equal(conf.bundle.externalBin, undefined);
  // BSD-314: node-pty (native Datei für das Terminal) liegt daneben in node_modules/, nicht im Bundle.
  // BSD-414: die mitgelieferte Node liegt als Resource node/ bei (fetch-node.mjs), weiter kein externalBin.
  assert.deepEqual(conf.bundle.resources, { "../dist-sidecar/based-server.cjs": "based-server.cjs", "../dist-sidecar/node_modules/": "node_modules/", "../dist-sidecar/node/": "node/" });
  assert.match(conf.build.beforeBuildCommand, /@based\/desktop sidecar/);
  assert.match(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.sidecar, /fetch-node\.mjs && node scripts\/sign-node\.mjs/);
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
  const { NODE_SHA256, NODE_VERSION, archiveName, fetchNode, nodeTarget, nodeTargets, verifyArchive } = await import("../scripts/fetch-node.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  assert.match(NODE_VERSION, /^v2[2-9]\.\d+\.\d+$/);
  // BSD-452: Universal-Build = beide Mac-Architekturen (eine universelle Datei)
  assert.deepEqual(nodeTargets({ triple: "universal-apple-darwin" }), ["darwin-arm64", "darwin-x64"]);
  assert.deepEqual(nodeTargets({ triple: "x86_64-apple-darwin" }), ["darwin-x64"]);
  assert.deepEqual(nodeTargets({ triple: "x86_64-pc-windows-msvc" }), []);
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
    // universal: fehlt eine Architektur, liegt gar keine Node bei (alles oder nichts)
    assert.equal(await fetchNode({ out: join(dir, "out"), cache: join(dir, "cache"), targets: ["darwin-arm64", "darwin-x64"], fetcher: async () => new Response("evil"), log: () => {} }), false);
    assert.equal(existsSync(join(dir, "out", "bin", "node")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test("Info.plist: Mikrofon für Meeting Notes (macOS verweigert getUserMedia ohne Usage-Description)", async () => {
  const plist = readFileSync(new URL("../src-tauri/Info.plist", import.meta.url), "utf8");
  assert.match(plist, /<key>NSMicrophoneUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
  assert.match(plist, /<key>NSAudioCaptureUsageDescription<\/key>\s*<string>[^<]{20,}<\/string>/);
});

// Beta-Release (16.11.2026): eigene App-Identität „Based Beta“, neben Based Next installierbar, eigener Update-Kanal.
test("Beta-Overlay: eigener Name, eigene Bundle-ID, Updater auf beta-latest", () => {
  const beta = JSON.parse(readFileSync(new URL("../src-tauri/tauri.beta.conf.json", import.meta.url), "utf8"));
  assert.equal(beta.productName, "Based Beta");
  assert.equal(beta.identifier, "com.friedrich-ulrich.based.beta");
  assert.notEqual(beta.identifier, conf.identifier);
  assert.equal(beta.app.windows[0].title, "Based Beta");
  // Das Overlay ersetzt das Fenster-Array ganz (JSON Merge Patch): alles außer dem Titel muss gleich bleiben.
  assert.deepEqual({ ...beta.app.windows[0], title: conf.app.windows[0].title }, conf.app.windows[0]);
  assert.equal(beta.plugins.updater.pubkey, conf.plugins.updater.pubkey);
  assert.deepEqual(beta.plugins.updater.endpoints, ["https://github.com/elija-7580/Based/releases/download/beta-latest/latest.json"]);
});

// BSD-452: universelle Node (arm64 + x86_64) ohne Xcode bauen und prüfen – wie lipo -create / lipo -info.
test("BSD-452: Mach-O universal – zusammenfügen, Slices ausgerichtet, Prüfschritt findet beide Architekturen", async () => {
  const { CPU_TYPE_ARM64, CPU_TYPE_X86_64, fatArchs, makeFat, thinArch } = await import("../scripts/macho.mjs");
  const { checkNode, nodePath } = await import("../scripts/check-node.mjs");
  const thin = (cputype, cpusubtype, size, fill) => {
    const b = Buffer.alloc(size, fill);
    b.writeUInt32LE(0xfeedfacf, 0);
    b.writeInt32LE(cputype, 4);
    b.writeInt32LE(cpusubtype, 8);
    return b;
  };
  const arm = thin(CPU_TYPE_ARM64, 0, 5000, 1), x64 = thin(CPU_TYPE_X86_64, 3, 7000, 2);
  assert.deepEqual(thinArch(arm), { cputype: CPU_TYPE_ARM64, cpusubtype: 0, name: "arm64" });
  assert.equal(thinArch(Buffer.from("#!/bin/sh\n")), undefined);
  const fat = makeFat([arm, x64]);
  const archs = fatArchs(fat);
  assert.deepEqual(archs.map((a) => [a.name, a.align, a.valid]), [["x86_64", 12, true], ["arm64", 14, true]]);
  assert.equal(archs[0].offset % 4096, 0);
  assert.equal(archs[1].offset % 16384, 0);
  assert.equal(archs[0].cpusubtype, 3);
  // jede Slice unverändert an ihrem Platz
  assert.ok(fat.subarray(archs[1].offset, archs[1].offset + archs[1].size).equals(arm));
  assert.ok(fat.subarray(archs[0].offset, archs[0].offset + archs[0].size).equals(x64));
  assert.throws(() => makeFat([arm, arm]), /duplicate/);
  assert.throws(() => makeFat([Buffer.from("nope")]), /Mach-O/);
  // Prüfschritt
  assert.deepEqual(checkNode(fat), { ok: true, archs: ["x86_64", "arm64"], missing: [], broken: [] });
  assert.deepEqual(checkNode(arm), { ok: false, archs: ["arm64"], missing: ["x86_64"], broken: [] });
  assert.equal(checkNode(arm, ["arm64"]).ok, true);
  const cut = fat.subarray(0, archs[1].offset + 10);
  assert.deepEqual(checkNode(cut).broken, ["arm64"]);
  assert.equal(nodePath("/nonexistent/Based Beta.app/x"), "/nonexistent/Based Beta.app/x");
});

// BSD-433: Node signieren (Hardened Runtime, Entitlements) und die fertige App prüfen – vorbereitet, ohne Secrets.
test("BSD-433: Entitlements nur so weit wie nötig, Signierplan, Server startet aus dem Bundle mit leerem PATH", async () => {
  const { mkdtempSync, mkdirSync, rmSync, symlinkSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const ent = readFileSync(new URL("../src-tauri/node.entitlements", import.meta.url), "utf8");
  const keys = [...ent.matchAll(/<key>([^<]+)<\/key>\s*<true\/>/g)].map((m) => m[1]).sort();
  assert.deepEqual(keys, ["com.apple.security.cs.allow-jit", "com.apple.security.cs.allow-unsigned-executable-memory", "com.apple.security.cs.disable-library-validation"]);
  assert.equal([...ent.matchAll(/<key>/g)].length, 3); // nichts sonst (kein get-task-allow, kein Debugger)

  const { keychainCommands, signCommands, signTargets, ENTITLEMENTS } = await import("../scripts/sign-node.mjs");
  // Developer ID: eigener temporärer Schlüsselbund, codesign darf ohne Rückfrage, danach gelöscht
  const kc = keychainCommands("/tmp/k.keychain-db", "/tmp/c.p12", "pw", "kpw");
  assert.deepEqual(kc.setup.map((a) => a[0]), ["create-keychain", "set-keychain-settings", "unlock-keychain", "import", "set-key-partition-list"]);
  assert.ok(kc.setup[3].includes("/usr/bin/codesign"));
  assert.deepEqual(kc.cleanup, [["delete-keychain", "/tmp/k.keychain-db"]]);
  const dist = mkdtempSync(join(tmpdir(), "based-sign-"));
  try {
    mkdirSync(join(dist, "node", "bin"), { recursive: true });
    writeFileSync(join(dist, "node", "bin", "node"), "");
    for (const a of ["darwin-arm64", "darwin-x64", "linux-x64"]) {
      const d = join(dist, "node_modules", "@homebridge", "node-pty-prebuilt-multiarch", "prebuilds", a);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "pty.node"), "");
      if (a.startsWith("darwin")) writeFileSync(join(d, "spawn-helper"), "");
    }
    const targets = signTargets(dist);
    assert.equal(targets.length, 5); // node + 2 × (pty.node, spawn-helper); Linux-Prebuilds nicht
    assert.deepEqual(targets[0], { path: join(dist, "node", "bin", "node"), entitlements: true });
    assert.ok(targets.slice(1).every((t) => !t.entitlements && /darwin-/.test(t.path)));
    const adhoc = signCommands(targets, "-");
    assert.deepEqual(adhoc[0], ["--force", "--options", "runtime", "--entitlements", ENTITLEMENTS, "--sign", "-", targets[0].path]);
    assert.ok(adhoc.every((a) => !a.includes("--timestamp")));
    const devid = signCommands(targets, "Developer ID Application: X (TEAM123456)");
    assert.ok(devid.every((a) => a.includes("--timestamp") && a.includes("runtime")));
    assert.ok(devid.slice(1).every((a) => !a.includes("--entitlements")));
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
  // ohne BASED_SIGN_NODE=1 tut das Skript nichts (lokale Builds unverändert)
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const skipped = execFileSync(process.execPath, ["scripts/sign-node.mjs"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.match(skipped, /skipped/);

  // Server aus einer nachgebauten .app, Node aus dem Bundle, ohne PATH
  const { startBundledServer } = await import("../scripts/verify-app.mjs");
  execFileSync(process.execPath, ["scripts/build-sidecar.mjs"], { cwd: dir, stdio: "ignore" });
  const app = mkdtempSync(join(tmpdir(), "based-app-"));
  try {
    const res = join(app, "Contents", "Resources");
    mkdirSync(join(res, "node", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(res, "node", "bin", "node"));
    copyFileSync(join(dir, "dist-sidecar", "based-server.cjs"), join(res, "based-server.cjs"));
    assert.match(await startBundledServer(app), /^http:\/\/127\.0\.0\.1:\d+$/);
    // ohne Bundle: klare Meldung statt Hängen
    rmSync(join(res, "based-server.cjs"));
    await assert.rejects(startBundledServer(app, { timeoutMs: 10_000 }), /exited/);
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
});

