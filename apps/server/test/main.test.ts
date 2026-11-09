// Start: ohne Token kein HTTP-Server (Exit 2), mit Token lauscht er; Optionen aus Argumenten und Umgebung.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allowedOrigin, parseOptions } from "../src/main.js";
import { health } from "../src/index.js";

const root = fileURLToPath(new URL("..", import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const { BASED_TOKEN: _drop, ...rest } = process.env;
  void _drop;
  return spawn(join(root, "node_modules/.bin/tsx"), [join(root, "src/main.ts"), ...args], {
    env: { ...rest, BASED_LOG_LEVEL: "info", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("Start", () => {
  it("meldet Sync v2", () => expect(health()).toEqual({ ok: true, protocol: 2 }));

  it("Optionen", () => {
    expect(parseOptions(["--port", "18150", "--token", "t", "--db", "x.sqlite"], { BASED_NODE: "srv2" })).toMatchObject({
      port: 18150, token: "t", db: "x.sqlite", node: "srv2", stdio: false,
    });
    expect(parseOptions([], { BASED_TOKEN: "env", BASED_PORT: "9000" })).toMatchObject({ token: "env", port: 9000 });
    expect(() => parseOptions(["--bogus"], {})).toThrow(/unknown option/);
    expect(() => parseOptions(["--port", "x"], {})).toThrow(/port/);
    expect(allowedOrigin("https://based.example.com/app")).toBe("https://based.example.com");
    expect(allowedOrigin("ftp://x")).toBeUndefined();
  });

  it("ohne Token: Exit-Code 2, kein Lauschen", async () => {
    const p = run(["--port", "18199"]);
    let err = "";
    p.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((r) => p.on("exit", r));
    expect(code).toBe(2);
    expect(err).toContain("no token");
  }, 30_000);

  it("mit Token: lauscht, antwortet mit Auth, beendet sich auf SIGTERM", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-main-"));
    const port = 18_190 + Math.floor(Math.random() * 9);
    const p = run(["--port", String(port), "--host", "127.0.0.1", "--db", join(dir, "based.sqlite")], { BASED_TOKEN: "main-test-token-123456" });
    let out = "";
    p.stderr.on("data", (d: Buffer) => (out += d.toString()));
    try {
      await expect.poll(() => out, { timeout: 15_000 }).toContain("based-server listening");
      const r = await fetch(`http://127.0.0.1:${port}/sync/v2/info`, { headers: { Authorization: "Bearer main-test-token-123456" } });
      expect(await r.json()).toEqual({ protocol: 2, seq: 0, oldestSeq: 0 });
      expect((await fetch(`http://127.0.0.1:${port}/sync/v2/info`)).status).toBe(401);
      // Logs ohne Token und ohne Inhalte.
      expect(out).not.toContain("main-test-token");
    } finally {
      p.kill("SIGTERM");
      expect(await new Promise<number | null>((r) => p.on("exit", r))).toBe(0);
    }
  }, 30_000);
});
