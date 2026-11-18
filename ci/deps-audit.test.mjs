// BSD-549: Lockfile-Auswertung von ci/deps-audit.mjs (ohne Netz).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cargoPackages, npmFindings, ACCEPTED } from "./deps-audit.mjs";

test("Cargo.lock: nur Registry-Pakete, mit Version", () => {
  const lock = `version = 4

[[package]]
name = "based-desktop"
version = "0.1.0"

[[package]]
name = "glib"
version = "0.18.5"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "abc"

[[package]]
name = "eigen"
version = "1.0.0"
source = "git+https://example.invalid/eigen#123"
`;
  assert.deepEqual(cargoPackages(lock), [{ name: "glib", version: "0.18.5" }]);
});

test("Cargo.lock der Desktop-App wird gelesen", () => {
  const pkgs = cargoPackages(readFileSync(new URL("../apps/desktop/src-tauri/Cargo.lock", import.meta.url), "utf8"));
  assert.ok(pkgs.length > 100);
  assert.ok(pkgs.some((p) => p.name === "tauri"));
});

test("pnpm audit --json: Meldung mit GHSA-ID, Version und Pfad", () => {
  const f = npmFindings({
    advisories: {
      1: { id: 1, github_advisory_id: "GHSA-fc5q-39xc-vjpf", module_name: "picomatch", severity: "high", title: "ReDoS",
        findings: [{ version: "4.0.7", paths: [".>typescript-eslint>picomatch"] }] },
    },
  });
  assert.deepEqual(f, [{ id: "GHSA-fc5q-39xc-vjpf", pkg: "picomatch@4.0.7", severity: "high", title: "ReDoS", paths: [".>typescript-eslint>picomatch"] }]);
  assert.ok(ACCEPTED["GHSA-wrw7-89jp-8q8g"], "die moderate Dependabot-Meldung (glib) ist eingeordnet");
});
