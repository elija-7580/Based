// BSD-138: Starter für `based` (Opt-in aus der Desktop-App): Node-Version, fremde Dateien, PATH-Hinweis, Entfernen.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTarget, installStarter, nodeMajor, starterMark, starterScript, starterStatus, STARTER_MARK, uninstallStarter } from "../src/install.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "based-install-")); dirs.push(d); return d; };

describe("CLI-Starter", () => {
  it("Node-Version und Skript", () => {
    expect(nodeMajor("v22.11.0")).toBe(22);
    expect(nodeMajor("18.2.1")).toBe(18);
    expect(nodeMajor("")).toBeUndefined();
    const s = starterScript("/opt/homebrew/bin/node", "/Applications/Based Next.app/Contents/Resources/based-server.cjs");
    expect(s).toContain(STARTER_MARK);
    expect(s).toContain(`exec '/opt/homebrew/bin/node' '/Applications/Based Next.app/Contents/Resources/based-server.cjs' cli "$@"`);
    expect(starterScript("/n", "/a/it's.cjs")).toContain(`'/a/it'\\''s.cjs'`);
    expect(defaultTarget("/Users/e")).toBe("/Users/e/.local/bin/based");
  });

  it("Node fehlt oder ist zu alt: nichts wird angelegt", () => {
    const d = tmp();
    const bundle = join(d, "b.cjs");
    writeFileSync(bundle, "");
    for (const v of ["v20.10.0", ""]) {
      const r = installStarter({ target: join(d, "bin", "based"), node: "/n", nodeVersion: v, bundle });
      expect(r.ok).toBe(false);
      expect(r.message).toContain("Node.js 22 or newer");
    }
    expect(existsSync(join(d, "bin", "based"))).toBe(false);
  });

  it("anlegen (PATH-Hinweis), Status, fremde Datei bleibt, entfernen", () => {
    const d = tmp();
    const bundle = join(d, "b.cjs");
    writeFileSync(bundle, "");
    const target = join(d, "bin", "based");
    expect(installStarter({ target: "rel/based", node: "/n", nodeVersion: "v22.0.0", bundle }).ok).toBe(false);
    expect(installStarter({ target, node: "/n", nodeVersion: "v22.0.0", bundle: join(d, "missing.cjs") }).message).toContain("missing");
    const r = installStarter({ target, node: "/n", nodeVersion: "v22.0.0", bundle, path: `/usr/bin:${join(d, "bin")}` });
    expect(r).toMatchObject({ ok: true, inPath: true });
    expect(readFileSync(target, "utf8")).toContain(STARTER_MARK);
    expect(starterStatus(target).installed).toBe(true);
    const foreign = join(d, "other");
    writeFileSync(foreign, "#!/bin/sh\n");
    expect(installStarter({ target: foreign, node: "/n", nodeVersion: "v22.0.0", bundle }).ok).toBe(false);
    expect(uninstallStarter(foreign).ok).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(uninstallStarter(target)).toMatchObject({ ok: true, message: "Removed." });
    expect(uninstallStarter(target)).toMatchObject({ ok: true, message: "Not installed." });
  });

  it("BSD-455: Based Beta – eigener Befehl, Kanal im Starter, Starter von Based Next bleibt unberührt", () => {
    expect(defaultTarget("/Users/e", "beta")).toBe("/Users/e/.local/bin/based-beta");
    expect(starterMark("next")).toBe(STARTER_MARK);
    const beta = starterScript("/n", "/Applications/Based Beta.app/Contents/Resources/based-server.cjs", "beta");
    expect(beta).toContain(starterMark("beta"));
    expect(beta).not.toContain(STARTER_MARK);
    expect(beta).toContain("BASED_CHANNEL=beta; export BASED_CHANNEL");
    expect(starterScript("/n", "/b.cjs")).not.toContain("BASED_CHANNEL");

    const d = tmp();
    const bundle = join(d, "b.cjs");
    writeFileSync(bundle, "");
    const nextTarget = join(d, "bin", "based");
    expect(installStarter({ target: nextTarget, node: "/n", nodeVersion: "v22.1.0", bundle }).ok).toBe(true);
    // Beta auf den Ort von Next: abgelehnt, Datei unverändert; entfernen/Status der Beta lassen sie stehen
    const before = readFileSync(nextTarget, "utf8");
    const r = installStarter({ target: nextTarget, node: "/n", nodeVersion: "v22.1.0", bundle, channel: "beta" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("another Based app");
    expect(readFileSync(nextTarget, "utf8")).toBe(before);
    expect(starterStatus(nextTarget, "beta").installed).toBe(false);
    expect(uninstallStarter(nextTarget, "beta").ok).toBe(false);
    expect(existsSync(nextTarget)).toBe(true);
    // Beta an ihrem eigenen Ort: beide nebeneinander
    const betaTarget = join(d, "bin", "based-beta");
    const ok = installStarter({ target: betaTarget, node: "/n", nodeVersion: "v22.1.0", bundle, channel: "beta" });
    expect(ok.ok).toBe(true);
    expect(starterStatus(betaTarget, "beta").installed).toBe(true);
    expect(starterStatus(nextTarget).installed).toBe(true);
    expect(uninstallStarter(betaTarget, "beta").ok).toBe(true);
    expect(existsSync(nextTarget)).toBe(true);
  });
});
