// BSD-138: Starter für `based` (Opt-in aus der Desktop-App): Node-Version, fremde Dateien, PATH-Hinweis, Entfernen.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTarget, installStarter, nodeMajor, starterScript, starterStatus, STARTER_MARK, uninstallStarter } from "../src/install.js";

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
});
