// BSD-138: based-server --local als Sidecar der Desktop-App: nur Loopback, freier Port, Discovery-Datei für die
// CLI (0600, ohne Token), Ende mit stdin (die Hülle ist weg) räumt die Dateien weg.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOptions } from "../src/main.js";
import { localPaths, loginShellPath, mergePath } from "../src/local.js";

const serverDir = fileURLToPath(new URL("..", import.meta.url));

describe("BSD-138 based-server --local", () => {
  it("Optionen: Loopback und freier Port erzwungen, --port bleibt, nicht mit --stdio", () => {
    const o = parseOptions(["--local", "--host", "0.0.0.0"], { BASED_PORT: "8787" });
    expect(o).toMatchObject({ local: true, host: "127.0.0.1", port: 0 });
    expect(parseOptions(["--local", "--port", "9999"], {}).port).toBe(9999);
    expect(() => parseOptions(["--local", "--stdio"], {})).toThrow("--stdio");
  });

  it("PATH der Login-Shell vorn, ohne Doppelte; Fehler lassen den PATH", () => {
    expect(loginShellPath("/bin/zsh", () => "motd noise\n__BASED_PATH__/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin");
    expect(loginShellPath("/bin/zsh", () => { throw new Error("timeout"); })).toBeUndefined();
    expect(loginShellPath("/bin/zsh", () => "no marker")).toBeUndefined();
    expect(mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
    expect(mergePath(undefined, "/usr/bin")).toBe("/usr/bin");
    if (process.platform !== "win32") expect(loginShellPath("/bin/sh")).toContain("/");
  });

  it("Start meldet die Adresse, schreibt Discovery + Token (0600), endet mit stdin und räumt auf", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-local-home-"));
    const data = mkdtempSync(join(tmpdir(), "based-local-db-"));
    try {
      const child = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--local", "--db", join(data, "local.sqlite")], {
        cwd: serverDir,
        env: { ...process.env, HOME: home, BASED_TOKEN: "sidecar-token-0123456789", BASED_LOG_LEVEL: "warning", BASED_LOCAL_OWNER: "test" },
        stdio: ["pipe", "pipe", "inherit"],
      });
      const ready = await new Promise<{ url: string; pid: number }>((resolve, reject) => {
        let buf = "";
        const t = setTimeout(() => reject(new Error("no BASED_LOCAL_READY")), 30_000);
        child.stdout!.setEncoding("utf8").on("data", (d: string) => {
          buf += d;
          const m = /BASED_LOCAL_READY (\{.*\})\n/.exec(buf);
          if (m) { clearTimeout(t); resolve(JSON.parse(m[1]!) as { url: string; pid: number }); }
        });
        child.once("exit", () => reject(new Error("exited early")));
      });
      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const p = localPaths(home);
      const disc = JSON.parse(readFileSync(p.discovery, "utf8")) as Record<string, unknown>;
      expect(disc).toMatchObject({ v: 1, url: ready.url, tokenFile: p.token, owner: "test" });
      expect(JSON.stringify(disc)).not.toContain("sidecar-token");
      expect(readFileSync(p.token, "utf8").trim()).toBe("sidecar-token-0123456789");
      expect(statSync(p.discovery).mode & 0o777).toBe(0o600);
      expect(statSync(p.token).mode & 0o777).toBe(0o600);
      const health = await fetch(`${ready.url}/health`);
      expect(health.ok).toBe(true);
      const unauth = await fetch(`${ready.url}/sync/pull`);
      expect(unauth.status).toBe(401);

      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      child.stdin!.end();
      expect(await exited).toBe(0);
      expect(existsSync(p.discovery)).toBe(false);
      expect(existsSync(p.token)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  }, 60_000);
});
