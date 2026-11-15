// BSD-138: based-server --local als Sidecar der Desktop-App: nur Loopback, freier Port, Discovery-Datei für die
// CLI (0600, ohne Token), Ende mit stdin (die Hülle ist weg) räumt die Dateien weg.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseOptions } from "../src/main.js";
import { localPaths, loginShellPath, mergePath, replaceStaleLocal, writeLocalDiscovery } from "../src/local.js";
import { createServer } from "node:net";

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
      // BSD-251: wie die Desktop-App startet – mit Coding-Ordner und der Herkunft ihres Fensters
      mkdirSync(join(home, ".claude", "projects", "-p"), { recursive: true });
      writeFileSync(join(home, ".claude", "projects", "-p", "c1.jsonl"), JSON.stringify({ type: "user", sessionId: "c1", cwd: "/p", timestamp: "2026-11-01T10:00:01.000Z", message: { role: "user", content: "hi from the terminal" } }));
      const child = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--local", "--db", join(data, "local.sqlite"), "--coding-root", home], {
        cwd: serverDir,
        env: { ...process.env, HOME: home, BASED_TOKEN: "sidecar-token-0123456789", BASED_LOG_LEVEL: "warning", BASED_LOCAL_OWNER: "test", BASED_APP_ORIGIN: "tauri://localhost" },
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

      // BSD-251: das Fenster der App (tauri://localhost) darf – Preflight und Anfrage –, eine fremde Seite nicht
      const pre = await fetch(`${ready.url}/coding/history`, { method: "OPTIONS", headers: { Origin: "tauri://localhost", "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
      expect(pre.status).toBe(204);
      expect(pre.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      expect(pre.headers.get("access-control-allow-headers")).toContain("Authorization");
      const hist = await fetch(`${ready.url}/coding/history`, { headers: { Origin: "tauri://localhost", Authorization: "Bearer sidecar-token-0123456789" } });
      expect(hist.headers.get("access-control-allow-origin")).toBe("tauri://localhost");
      expect(((await hist.json()) as { sessions: { tool: string; title: string }[] }).sessions).toMatchObject([{ tool: "claude", title: "hi from the terminal" }]);
      const evil = await fetch(`${ready.url}/coding/history`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" } });
      expect(evil.headers.get("access-control-allow-origin")).toBeNull();
      expect((await fetch(`${ready.url}/coding/history`, { headers: { Origin: "tauri://localhost" } })).status).toBe(401);

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

  it("BSD-424: Port belegt – eigener alter Server wird abgelöst, fremdes Programm nicht", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-stale-home-"));
    try {
      const killed: [number, string][] = [];
      let up = true;
      const deps = { alive: () => up, kill: (pid: number, sig: string) => { killed.push([pid, sig]); up = false; }, health: async () => true, sleep: async () => {} };
      // keine Discovery: fremd
      expect(await replaceStaleLocal(home, 47821, "Based Next", deps)).toBe("foreign");
      writeLocalDiscovery(home, { port: 47821, token: "t", pid: 4242, owner: "Based Next" });
      // anderer Starter (von Hand gestartet) oder anderer Port: fremd
      expect(await replaceStaleLocal(home, 47821, "based-server --local", deps)).toBe("foreign");
      expect(await replaceStaleLocal(home, 47822, "Based Next", deps)).toBe("foreign");
      // antwortet nicht als based-server: fremd
      expect(await replaceStaleLocal(home, 47821, "Based Next", { ...deps, health: async () => false })).toBe("foreign");
      expect(killed).toEqual([]);
      expect(await replaceStaleLocal(home, 47821, "Based Next", deps)).toBe("replaced");
      expect(killed).toEqual([[4242, "SIGTERM"]]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("BSD-424: zweiter Start auf demselben Port löst den verwaisten ersten ab; fremder Port → klare Meldung", async () => {
    const home = mkdtempSync(join(tmpdir(), "based-stale2-home-"));
    const data = mkdtempSync(join(tmpdir(), "based-stale2-db-"));
    const port = await new Promise<number>((resolve) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
    const start = (db: string) => {
      const child = spawn("pnpm", ["exec", "tsx", "src/main.ts", "--local", "--port", String(port), "--db", join(data, db)], {
        cwd: serverDir,
        env: { ...process.env, HOME: home, BASED_TOKEN: "stale-token-0123456789", BASED_LOG_LEVEL: "warning", BASED_LOCAL_OWNER: "Based Next" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "", err = "";
      child.stdout!.setEncoding("utf8").on("data", (d: string) => { out += d; });
      child.stderr!.setEncoding("utf8").on("data", (d: string) => { err += d; });
      const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
      const ready = async () => { for (let i = 0; i < 300 && !/BASED_LOCAL_READY/.test(out); i++) { if (child.exitCode !== null) break; await new Promise((r) => setTimeout(r, 100)); } return /BASED_LOCAL_READY/.test(out); };
      return { child, exited, ready, err: () => err };
    };
    try {
      const a = start("a.sqlite");
      expect(await a.ready()).toBe(true);
      // A ist verwaist (stdin bleibt offen, die App ist weg); B startet auf demselben Port
      const b = start("b.sqlite");
      expect(await b.ready()).toBe(true);
      expect(await a.exited).not.toBeNull();
      expect((await fetch(`http://127.0.0.1:${port}/health`)).ok).toBe(true);
      b.child.stdin!.end();
      expect(await b.exited).toBe(0);

      // fremdes Programm auf dem Port: Exit ≠ 0 mit verständlicher Meldung, nichts wird beendet
      const foreign = createServer();
      await new Promise<void>((r) => foreign.listen(port, "127.0.0.1", () => r()));
      try {
        const c = start("c.sqlite");
        expect(await c.exited).not.toBe(0);
        expect(c.err()).toContain(`Port ${port} is already in use`);
        expect(foreign.listening).toBe(true);
      } finally {
        await new Promise<void>((r) => foreign.close(() => r()));
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  }, 90_000);
});
