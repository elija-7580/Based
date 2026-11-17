#!/usr/bin/env node
// BSD-433: Mitgelieferte Node und die nativen Teile von node-pty signieren, BEVOR Tauri das App-Bundle baut (die
// Dateien liegen dann schon signiert unter dist-sidecar/ und werden als Resources kopiert). Hardened Runtime für
// alles, die Rechte aus src-tauri/node.entitlements nur für node/bin/node. Mit Developer ID (APPLE_SIGNING_IDENTITY,
// Secrets aus BSD-272) zusätzlich mit sicherem Zeitstempel – Voraussetzung der Notarisierung; ohne Secrets ad hoc
// („-“), dann läuft die App wie bisher nur ad hoc signiert.
//
// Developer ID: das Skript läuft im beforeBuildCommand, also bevor Tauri das Zertifikat in seinen eigenen
// Schlüsselbund lädt. Darum importiert es APPLE_CERTIFICATE (base64 .p12) + APPLE_CERTIFICATE_PASSWORD selbst in einen
// temporären Schlüsselbund (wie Tauri), signiert damit und löscht ihn danach wieder. Keine Secrets im Repo.
//
// Nur mit BASED_SIGN_NODE=1 (die CI-Vorlage setzt es; lokale Builds bleiben unverändert). Nur auf macOS – anderswo
// druckt das Skript, was es täte (Trockenlauf, auch: --dry-run).
//   BASED_SIGN_NODE=1 [APPLE_SIGNING_IDENTITY="Developer ID Application: …"] node scripts/sign-node.mjs [--dry-run]
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ENTITLEMENTS = join(desktop, "src-tauri", "node.entitlements");

/** Ausführbare Teile unter dist-sidecar/: Node (mit Rechten) und die Mac-Prebuilds von node-pty (ohne). */
export function signTargets(dist) {
  const out = [];
  const node = join(dist, "node", "bin", "node");
  if (existsSync(node)) out.push({ path: node, entitlements: true });
  // BSD-231: whisper-cli (build-whisper.mjs) – Hardened Runtime, keine besonderen Rechte (kein JIT, keine Geräte).
  const whisper = join(dist, "whisper", "whisper-cli");
  if (existsSync(whisper)) out.push({ path: whisper, entitlements: false });
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\/prebuilds\/darwin-[^/]+\/[^/]+$/.test(p) && (name.endsWith(".node") || name === "spawn-helper")) out.push({ path: p, entitlements: false });
    }
  };
  walk(join(dist, "node_modules"));
  return out;
}

/** codesign-Aufrufe (Argumente) für eine Identität; „-“ = ad hoc (ohne Zeitstempel, den gibt es nur mit Developer ID). */
export function signCommands(targets, identity = "-", entitlements = ENTITLEMENTS) {
  const adhoc = identity === "-";
  return targets.map((t) => [
    "--force", "--options", "runtime", ...(adhoc ? [] : ["--timestamp"]),
    ...(t.entitlements ? ["--entitlements", entitlements] : []),
    "--sign", identity, t.path,
  ]);
}

/** `security`-Aufrufe für einen temporären Schlüsselbund mit dem Zertifikat (Pfad der .p12-Datei, Passwort). */
export function keychainCommands(keychain, p12, password, keychainPassword) {
  return {
    setup: [
      ["create-keychain", "-p", keychainPassword, keychain],
      ["set-keychain-settings", "-lut", "3600", keychain],
      ["unlock-keychain", "-p", keychainPassword, keychain],
      ["import", p12, "-k", keychain, "-P", password, "-T", "/usr/bin/codesign"],
      ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", keychainPassword, keychain],
    ],
    cleanup: [["delete-keychain", keychain]],
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dist = join(desktop, "dist-sidecar");
  if (process.env.BASED_SIGN_NODE !== "1") {
    console.log("sign-node: skipped (BASED_SIGN_NODE != 1)");
  } else {
    const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
    const targets = signTargets(dist);
    const commands = signCommands(targets, identity);
    const dry = process.argv.includes("--dry-run") || process.platform !== "darwin";
    console.log(`sign-node: ${targets.length} file(s), identity ${identity === "-" ? "ad hoc" : "Developer ID"}${dry ? " (dry run)" : ""}`);
    const cert = process.env.APPLE_CERTIFICATE?.trim();
    let cleanup = () => {};
    let keychainArgs = [];
    if (!dry && identity !== "-" && cert) {
      const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
      const { randomBytes } = await import("node:crypto");
      const { tmpdir } = await import("node:os");
      const dir = mkdtempSync(join(tmpdir(), "based-sign-"));
      const keychain = join(dir, "based-node.keychain-db");
      const p12 = join(dir, "cert.p12");
      writeFileSync(p12, Buffer.from(cert, "base64"), { mode: 0o600 });
      const kc = keychainCommands(keychain, p12, process.env.APPLE_CERTIFICATE_PASSWORD ?? "", randomBytes(16).toString("hex"));
      for (const a of kc.setup) execFileSync("security", a, { stdio: ["ignore", "ignore", "inherit"] });
      rmSync(p12, { force: true });
      // codesign findet eine Identität nur in Schlüsselbunden der Suchliste – `--keychain` allein reicht nicht
      // („The specified item could not be found in the keychain“, Desktop-Lauf 17.11.). Also vorn in die Liste
      // des Nutzers eintragen und beim Aufräumen die alte Liste wiederherstellen.
      const before = execFileSync("security", ["list-keychains", "-d", "user"], { encoding: "utf8" })
        .split("\n").map((l) => l.trim().replace(/^"|"$/g, "")).filter(Boolean);
      execFileSync("security", ["list-keychains", "-d", "user", "-s", keychain, ...before], { stdio: ["ignore", "ignore", "inherit"] });
      keychainArgs = ["--keychain", keychain];
      cleanup = () => {
        try { execFileSync("security", ["list-keychains", "-d", "user", "-s", ...before]); } catch { /* Liste bleibt, wie sie ist */ }
        for (const a of kc.cleanup) { try { execFileSync("security", a); } catch { /* schon weg */ } }
        rmSync(dir, { recursive: true, force: true });
      };
    }
    try {
      for (const args of commands) {
        if (dry) console.log(`  codesign ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
        else {
          execFileSync("codesign", [...keychainArgs, ...args], { stdio: "inherit" });
          execFileSync("codesign", ["--verify", "--strict", args.at(-1)], { stdio: "inherit" });
        }
      }
    } finally {
      cleanup();
    }
  }
}
