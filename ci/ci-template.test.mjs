// BSD-548: CI-Vorlage und Playwright-Setup – ein hängender Browser-Install bricht nach festem Zeitlimit mit klarer
// Meldung ab, statt den Job offen zu lassen; volle Läufe auf main werden nicht von jedem neuen Push abgebrochen.
// Läuft in ci/typecheck/run-ts.sh (node --test).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const yml = readFileSync(join(here, "github-actions-ci.yml"), "utf8");
const script = join(here, "playwright-install.sh");

/** Schritte der Vorlage als Textblöcke (Zeilen ab „      - “ bis zum nächsten Schritt oder Job). */
function steps(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (/^ {6}- /.test(line)) { if (cur) out.push(cur); cur = line + "\n"; }
    else if (/^ {0,4}\S/.test(line)) { if (cur) out.push(cur); cur = null; }
    else if (cur !== null) cur += line + "\n";
  }
  if (cur) out.push(cur);
  return out;
}

test("Vorlage: kein Browser-Install ohne das Skript, jeder mit eigenem Zeitlimit", () => {
  assert.doesNotMatch(yml, /playwright install/, "Browser nur über ci/playwright-install.sh holen");
  const installs = steps(yml).filter((s) => s.includes("ci/playwright-install.sh"));
  assert.ok(installs.length >= 3, "ts-fast, e2e und perf holen Browser über das Skript");
  for (const s of installs) assert.match(s, /timeout-minutes: \d+/, `Schritt ohne Zeitlimit:\n${s}`);
  const e2e = installs.find((s) => s.includes("matrix.browser"));
  assert.ok(e2e, "e2e holt nur den Browser seiner Matrix-Zeile");
  const limit = Number(/timeout-minutes: (\d+)/.exec(e2e)[1]);
  assert.ok(limit * 60 >= 2 * 300 + 2 * 150 + 30, "Zeitlimit des Schritts deckt die Wiederholungen des Skripts");
});

test("Vorlage: auf main bricht ein neuer Push den vollen Lauf nicht ab, andere Branches schon", () => {
  assert.match(yml, /cancel-in-progress: \$\{\{ github\.ref != 'refs\/heads\/main' \}\}/);
});

test("Vorlage: ohne Testlog sichert e2e das Ende des Playwright-Setups", () => {
  assert.match(yml, /tail -n 15 pw-install\.log/);
});

function fakePlaywright(body) {
  const dir = mkdtempSync(join(tmpdir(), "pw-fake-"));
  const bin = join(dir, "playwright");
  writeFileSync(bin, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
}

function run(bin, dir, env = {}) {
  return spawnSync("bash", [script, "webkit"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PW_BIN: bin, PW_RETRY_PAUSE: "0", PW_TRIES: "2", ...env },
  });
}

test("Skript: hängender Download bricht nach dem Zeitlimit mit ::error ab", () => {
  const { dir, bin } = fakePlaywright(`
case "$1" in
  --version) echo "Version 0.0.0" ;;
  install-deps) echo "All system dependencies are installed." ;;
  install) sleep 30 ;;
esac`);
  const t0 = Date.now();
  const r = run(bin, dir, { PW_DL_TIMEOUT: "1" });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - t0 < 25_000, "bricht nach dem Zeitlimit ab, wartet nicht auf den hängenden Befehl");
  assert.match(r.stdout, /::warning title=Playwright-Setup::Browser-Download: hängt – nach 1 s abgebrochen \(Versuch 1\/2\)/);
  assert.match(r.stdout, /::error title=Playwright-Setup \(BSD-548\)::Browser-Download für \[webkit\] nach 2 Versuchen gescheitert/);
  assert.match(readFileSync(join(dir, "pw-install.log"), "utf8"), /::error/);
});

test("Skript: apt nur bei fehlenden Paketen; zweiter Versuch rettet einen Netzfehler", () => {
  const { dir, bin } = fakePlaywright(`
case "$1" in
  --version) echo "Version 0.0.0" ;;
  install-deps) [ "$2" = "--dry-run" ] && echo "All system dependencies are installed." || { echo "apt darf nicht laufen" >&2; exit 9; } ;;
  install) if [ -e tried ]; then echo "WebKit downloaded"; else touch tried; echo "ECONNRESET" >&2; exit 1; fi ;;
esac`);
  const r = run(bin, dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Systempakete schon vorhanden – apt übersprungen/);
  assert.match(r.stdout, /Browser-Download: Exit 1 \(Versuch 1\/2\)/);
  assert.match(r.stdout, /Browser-Download fertig in \d+ s \(Versuch 2\/2\)/);
});

test("Skript: fehlende Systempakete werden mit Zeitlimit installiert", () => {
  const { dir, bin } = fakePlaywright(`
case "$1" in
  --version) echo "Version 0.0.0" ;;
  install-deps) if [ "$2" = "--dry-run" ]; then echo "sudo -- sh -c apt-get install -y libicu74"; else sleep 30; fi ;;
  install) echo ok ;;
esac`);
  const r = run(bin, dir, { PW_DEPS_TIMEOUT: "1", PW_TRIES: "1" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /::error title=Playwright-Setup \(BSD-548\)::Systempakete \(apt\) für \[webkit\] nach 1 Versuchen gescheitert \(hängt – nach 1 s abgebrochen\)/);
});

test("Vorlage: Job-Limit von e2e und perf liegt über Browser-Setup plus Testschritt", () => {
  for (const job of ["e2e", "perf"]) {
    const block = yml.split(/\n {2}(?=[a-z0-9-]+:\n)/).find((b) => b.startsWith(`${job}:`));
    assert.ok(block, `Job ${job} fehlt`);
    const limits = [...block.matchAll(/timeout-minutes: (\d+)/g)].map((m) => Number(m[1]));
    const [jobLimit, ...stepLimits] = limits;
    const install = steps(block).find((s) => s.includes("ci/playwright-install.sh"));
    const tests = steps(block).find((s) => /playwright test/.test(s));
    const n = (s) => Number(/timeout-minutes: (\d+)/.exec(s)[1]);
    assert.ok(stepLimits.length >= 2);
    assert.ok(jobLimit > n(install) + n(tests), `${job}: ${jobLimit} ≤ ${n(install)} + ${n(tests)}`);
  }
});
