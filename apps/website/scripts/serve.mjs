#!/usr/bin/env node
// Local preview of the built site: serves public/ like Caddy does in production and
// forwards /api/* to the waitlist service (start it with `pnpm --filter @based/website waitlist`).
//   node scripts/serve.mjs [port]   → http://localhost:4321
import { createServer, request } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PUB = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const PORT = Number(process.argv[2] || 4321);
const API = Number(process.env.WAITLIST_PORT || 8790);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".xml": "application/xml", ".txt": "text/plain" };

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname.startsWith("/api/")) {
    const p = request({ port: API, path: req.url, method: req.method, headers: { ...req.headers, "x-forwarded-for": "127.0.0.1" } }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    p.on("error", () => { res.writeHead(502); res.end("waitlist service not running"); });
    req.pipe(p);
    return;
  }
  let file = join(PUB, decodeURIComponent(url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(400); res.end(); return; }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
  } catch {
    file = join(PUB, "404.html");
    res.statusCode = 404;
  }
  try {
    const body = await readFile(file);
    res.setHeader("content-type", TYPES[extname(file)] || "application/octet-stream");
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
