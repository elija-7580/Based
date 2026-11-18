#!/usr/bin/env node
// BSD-549: Abhängigkeiten auf bekannte Sicherheitswarnungen prüfen – ohne Zugriff auf GitHubs Dependabot-Reiter.
//   usage: node ci/deps-audit.mjs            (vor dem RC; braucht Netz: npm-Audit und api.osv.dev)
// Prüft
//   1. npm (pnpm-lock.yaml) über `pnpm audit --json`, getrennt nach „in der App“ (--prod) und „nur Werkzeuge“;
//   2. Rust (apps/desktop/src-tauri/Cargo.lock) über die OSV-Datenbank (dieselben GHSA/RUSTSEC-Meldungen wie Dependabot
//      bzw. cargo audit).
// Bekannte, eingeordnete Meldungen stehen in ACCEPTED (mit Grund); alles andere lässt das Skript mit Exit 1 enden.
// Sendet nur Paketnamen und Versionen aus den Lockfiles an api.osv.dev.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Eingeordnete Meldungen: id → Grund. Neu einordnen, wenn sich Version oder Pfad ändert. */
export const ACCEPTED = {
  // moderat (Dependabot): glib 0.18.5, behoben erst in 0.20 (Bruch). Kommt nur unter Linux über gtk 0.18 aus tauri/wry/
  // tao/muda – nicht im Mac-Build (cargo tree -i glib@0.18.5 --target aarch64-apple-darwin: leer). Erst mit einem
  // Tauri, das gtk-rs ≥ 0.20 nutzt.
  "GHSA-wrw7-89jp-8q8g": "glib 0.18.5 nur Linux (gtk 0.18 aus Tauri), nicht in der Mac-App; Fix nur mit Major-Sprung",
  "RUSTSEC-2024-0429": "= GHSA-wrw7-89jp-8q8g",
  // hoch (npm): picomatch ≤ 4.0.7 ReDoS, keine behobene Version veröffentlicht; nur Entwicklungswerkzeuge
  // (typescript-eslint, vitest, vite, astryx-cli) – `pnpm audit --prod` ist leer.
  "GHSA-fc5q-39xc-vjpf": "picomatch nur in Lint-/Test-/Build-Werkzeugen, keine behobene Version vorhanden",
  // „unmaintained“-Hinweise (RustSec, kein Dependabot-Alarm); `cargo tree -i … --target aarch64-apple-darwin` leer (18.11.)
  "RUSTSEC-2026-0543": "chrono unmaintained (Hinweis), nur Linux/Windows-Ziele, nicht im Mac-Build",
  "RUSTSEC-2024-0370": "proc-macro-error unmaintained (Hinweis), nur über gtk-Makros (Linux), nicht im Mac-Build",
  "RUSTSEC-2026-0370": "zvariant unmaintained (Hinweis), über zbus (Linux), nicht im Mac-Build",
  "RUSTSEC-2026-0371": "zbus_names unmaintained (Hinweis), über zbus (Linux), nicht im Mac-Build",
  "RUSTSEC-2026-0372": "zvariant_derive unmaintained (Hinweis), über zbus (Linux), nicht im Mac-Build",
};

/** Registry-Pakete aus einem Cargo.lock (Name, Version); Pfad-/Git-Abhängigkeiten zählen nicht. */
export function cargoPackages(lock) {
  const out = [];
  for (const block of lock.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    const source = /^source = "([^"]+)"/m.exec(block)?.[1] ?? "";
    if (name && version && source.startsWith("registry+")) out.push({ name, version });
  }
  return out;
}

/** Meldungen aus `pnpm audit --json` als { id, pkg, severity, title, paths }. */
export function npmFindings(audit) {
  return Object.values(audit.advisories ?? {}).map((a) => ({
    id: a.github_advisory_id ?? String(a.id),
    pkg: `${a.module_name}@${[...new Set(a.findings.map((f) => f.version))].join(",")}`,
    severity: a.severity,
    title: a.title,
    paths: a.findings.flatMap((f) => f.paths),
  }));
}

function pnpmAudit(prod) {
  try {
    return JSON.parse(execFileSync("pnpm", ["audit", "--json", ...(prod ? ["--prod"] : [])], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }));
  } catch (e) {
    // pnpm audit endet mit Exit 1, sobald es etwas findet – die JSON-Ausgabe steht trotzdem in stdout
    if (e.stdout) return JSON.parse(e.stdout);
    throw e;
  }
}

async function osvCargo(pkgs) {
  const out = [];
  for (let i = 0; i < pkgs.length; i += 500) {
    const chunk = pkgs.slice(i, i + 500);
    const res = await fetch("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ queries: chunk.map((p) => ({ package: { name: p.name, ecosystem: "crates.io" }, version: p.version })) }),
    });
    if (!res.ok) throw new Error(`api.osv.dev: HTTP ${res.status}`);
    const { results } = await res.json();
    results.forEach((r, j) => (r.vulns ?? []).forEach((v) => out.push({ id: v.id, pkg: `${chunk[j].name}@${chunk[j].version}` })));
  }
  return out;
}

async function main() {
  let open = 0;
  const report = (label, f, inApp) => {
    const why = ACCEPTED[f.id];
    if (!why) open++;
    console.log(`${why ? "eingeordnet" : "OFFEN      "}  ${label}  ${f.id}  ${f.pkg}${f.severity ? `  (${f.severity})` : ""}  ${inApp === null ? "Desktop (Rust, je Ziel prüfen)" : inApp ? "IN DER APP" : "nur Werkzeuge"}`);
    if (f.title) console.log(`             ${f.title}`);
    if (why) console.log(`             ${why}`);
  };
  const all = npmFindings(pnpmAudit(false));
  const prodIds = new Set(npmFindings(pnpmAudit(true)).map((f) => f.id));
  for (const f of all) report("npm  ", f, prodIds.has(f.id));
  const cargo = await osvCargo(cargoPackages(readFileSync(join(ROOT, "apps/desktop/src-tauri/Cargo.lock"), "utf8")));
  // Ob ein Rust-Paket im Mac-Build landet, sagt `cargo tree -i <paket>@<version> --target aarch64-apple-darwin`.
  for (const f of cargo) report("cargo", f, null);
  console.log(open ? `\n${open} Meldung(en) noch nicht eingeordnet.` : "\nAlle Meldungen eingeordnet.");
  process.exitCode = open ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
