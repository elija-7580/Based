// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
//
// BSD-631: read-only waitlist numbers of the waitlist service.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER = join(ROOT, "server", "waitlist.mjs");

async function withServer(fn, extraEnv = {}, dir = mkdtempSync(join(tmpdir(), "based-api-"))) {
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    env: { ...process.env, PORT: "0", WAITLIST_DB: join(dir, "w.sqlite"), WAITLIST_ORIGINS: "https://basednotes.app", BETA_DIR: join(dir, "beta"), WAITLIST_STATS_TOKEN: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d; });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => { const m = /waitlist service on :(\d+)/.exec(String(d)); if (m) resolve(Number(m[1])); });
    child.on("exit", (c) => reject(new Error(`server exited ${c}: ${stderr.trim().split("\n").slice(-3).join(" | ")}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const get = (path, init = {}) => fetch(`${base}${path}`, init);
  try {
    await fn({ post, get, dir, base, stderr: () => stderr });
  } finally {
    const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise((resolve) => child.once("exit", resolve));
    child.kill();
    await exited;
  }
  return dir;
}

// ---- BSD-631 --------------------------------------------------------------------------------

test("stats (BSD-631): off without a token, 401 with a wrong one, numbers and yes/no only with the right one", async () => {
  await withServer(async ({ get }) => {
    assert.equal((await get("/api/waitlist/stats")).status, 404);
    assert.equal((await get("/api/waitlist/check?email=a@b.co")).status, 404);
  });
  const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";
  await withServer(async ({ post, get }) => {
    assert.equal((await post("/api/waitlist", { email: "Ada@Example.org", name: "Ada" })).status, 200);
    assert.equal((await get("/api/waitlist/stats")).status, 401, "no header");
    assert.equal((await get("/api/waitlist/stats", { headers: { authorization: "Bearer wrong" } })).status, 401, "wrong token");
    const auth = { headers: { authorization: `Bearer ${TOKEN}` } };
    const res = await get("/api/waitlist/stats", auth);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.doesNotMatch(text, /@|Ada/, "no addresses or names in stats");
    const s = JSON.parse(text);
    assert.equal(s.count, 1);
    assert.match(s.last_created_at, /^2\d{3}-\d\d-\d\dT/);
    assert.equal(s.invites_active, 0);
    assert.deepEqual(await (await get("/api/waitlist/check?email=ADA@example.org", auth)).json(), { listed: true, created_at: s.last_created_at });
    assert.deepEqual(await (await get("/api/waitlist/check?email=bob@example.org", auth)).json(), { listed: false, created_at: null });
    assert.equal((await get("/api/waitlist/check?email=nope", auth)).status, 422);
    // the same rate limit as the forms (8 per 10 minutes), counted before the token check
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await get("/api/waitlist/stats", auth)).status);
    assert.deepEqual(codes.slice(0, 2), [200, 200]);
    assert.equal(codes.at(-1), 429);
  }, { WAITLIST_STATS_TOKEN: TOKEN });
});

test("deploy (BSD-631): the token reaches the service, documented for Elija", () => {
  const repo = join(ROOT, "..", "..");
  for (const f of ["docker-compose.yml", "edge/docker-compose.yml"]) {
    const yml = readFileSync(join(repo, "deploy", "website", f), "utf8");
    assert.match(yml, /WAITLIST_STATS_TOKEN: \$\{WAITLIST_STATS_TOKEN:-\}/, f);
  }
  const readme = readFileSync(join(repo, "deploy", "website", "README.md"), "utf8");
  assert.match(readme, /openssl rand -hex 24/);
  assert.match(readme, /api\/waitlist\/stats/);
  const env = readFileSync(join(repo, "deploy", "website", ".env.example"), "utf8");
  assert.match(env, /# WAITLIST_STATS_TOKEN=/);
});
