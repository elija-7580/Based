#!/usr/bin/env node
// BSD-433: Prüfschritt nach dem Build – vor der DMG. Für eine fertige .app:
//   1. codesign --verify --deep --strict (App) und --verify --strict für Node und node-pty; Node mit Hardened Runtime
//      und allow-jit (nur macOS)
//   2. Node für alle Architekturen (check-node.mjs, BSD-452)
//   3. der lokale Server startet aus dem Bundle mit LEEREM PATH (wie ein aus dem Finder gestarteter Prozess ohne
//      installiertes Node) und meldet BASED_LOCAL_READY – das ist der Fall, der unter Hardened Runtime ohne
//      Entitlements abstürzt
//   node scripts/verify-app.mjs "…/Based Beta.app" [--expect arm64,x86_64] [--skip-codesign]
// Exit 1 bei jedem Fehler. Schritt 3 läuft auch unter Linux (Test mit einer nachgebauten .app).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkNode } from "./check-node.mjs";

export const resources = (app) => join(app, "Contents", "Resources");

/** Startet based-server.cjs mit der Node aus dem Bundle, ohne PATH; löst mit der Adresse auf, wirft sonst. */
export function startBundledServer(app, { timeoutMs = 30_000 } = {}) {
  const res = resources(app);
  const node = join(res, "node", "bin", "node");
  const bundle = join(res, "based-server.cjs");
  const home = mkdtempSync(join(tmpdir(), "based-verify-"));
  return new Promise((resolve, reject) => {
    const child = spawn(node, [bundle, "desktop"], {
      // leere Umgebung bis auf das Nötigste: kein PATH, kein node im Suchpfad
      env: { HOME: home, BASED_ACTION: "local", BASED_PORT: "0", BASED_DB: join(home, "verify.sqlite"), BASED_TOKEN: "verify-token-0123456789abcdef", BASED_LOG_LEVEL: "warning" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "", err = "";
    const done = (fn) => { clearTimeout(timer); child.stdin.end(); child.kill("SIGTERM"); rmSync(home, { recursive: true, force: true }); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error(`no BASED_LOCAL_READY within ${timeoutMs} ms${err ? `: ${err.trim().split("\n").at(-1)}` : ""}`))), timeoutMs);
    child.stdout.setEncoding("utf8").on("data", (d) => {
      out += d;
      const m = /BASED_LOCAL_READY (\{.*\})/.exec(out);
      if (m) done(() => resolve(JSON.parse(m[1]).url));
    });
    child.stderr.setEncoding("utf8").on("data", (d) => { err += d; });
    child.once("error", (e) => done(() => reject(e)));
    child.once("exit", (code, signal) => done(() => reject(new Error(`server exited (${code ?? signal})${err ? `: ${err.trim().split("\n").at(-1)}` : ""}`))));
  });
}

function codesignChecks(app) {
  const res = resources(app);
  const node = join(res, "node", "bin", "node");
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", node], { stdio: "inherit" });
  const info = execFileSync("codesign", ["-d", "--entitlements", "-", "--xml", node], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!info.includes("com.apple.security.cs.allow-jit")) throw new Error("node is not signed with allow-jit (src-tauri/node.entitlements)");
  // `codesign -dv` schreibt nach stderr, z. B. „flags=0x10000(runtime)“
  const details = spawnSync("codesign", ["-dv", node], { encoding: "utf8" }).stderr ?? "";
  if (!/flags=0x[0-9a-f]+\([^)]*runtime/.test(details)) throw new Error("node is not signed with the hardened runtime");
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--expect");
  const expect = i >= 0 ? (args.splice(i, 2)[1] ?? "").split(",").filter(Boolean) : ["arm64", "x86_64"];
  const skipSign = args.includes("--skip-codesign") || process.platform !== "darwin";
  const app = args.find((a) => !a.startsWith("--"));
  const fail = (m) => { console.error(`verify-app: ${m}`); process.exit(1); };
  if (!app || !existsSync(app)) fail(`${app ?? "(no path)"} not found`);
  const node = join(resources(app), "node", "bin", "node");
  if (!existsSync(node)) fail("no bundled Node.js (Resources/node/bin/node) – fetch-node.mjs did not run or had no network");
  const arch = checkNode(readFileSync(node), expect);
  if (!arch.ok) fail(`Node architectures ${arch.archs.join(" + ") || "none"}, missing ${arch.missing.join(", ") || "-"}, broken ${arch.broken.join(", ") || "-"}`);
  console.log(`verify-app: Node ${arch.archs.join(" + ")}`);
  if (skipSign) console.log("verify-app: codesign checks skipped (not macOS or --skip-codesign)");
  else {
    try { codesignChecks(app); console.log("verify-app: signatures OK, Node with hardened runtime + allow-jit"); } catch (e) { fail(e instanceof Error ? e.message : String(e)); }
  }
  try {
    const url = await startBundledServer(app);
    console.log(`verify-app: local server started from the bundle with empty PATH (${url})`);
  } catch (e) {
    fail(`local server didn't start from the bundle: ${e instanceof Error ? e.message : String(e)}`);
  }
}
