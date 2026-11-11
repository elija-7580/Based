// Testserver auf einem freien Port aus 18100–18199 (parallele Arbeitsordner teilen sich die Maschine).
import { createApp, type App, type AppOptions } from "../src/app.js";
import { silentLogger } from "../src/log.js";

export const TOKEN = "test-token-0123456789";

// Jeder Start nimmt den nächsten Port (keine Wiederverwendung im selben Lauf: fetch hält Verbindungen offen).

export async function startApp(opts: Partial<AppOptions> = {}): Promise<App & { url: string; port: number }> {
  // Port 0: das Betriebssystem wählt einen freien. Feste Ports stießen zwischen parallel laufenden Testdateien
  // zusammen; der Fehlversuch schloss dann die App und beendete damit die Sandboxen des Tests (sandbox.test.ts).
  const app = createApp({ token: TOKEN, log: silentLogger, compactEvery: false, ...opts });
  const addr = await app.listen(0, "127.0.0.1");
  return Object.assign(app, addr);
}

export const auth = { Authorization: `Bearer ${TOKEN}` };

export async function get(url: string, headers: Record<string, string> = auth) {
  const r = await fetch(url, { headers });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined, headers: r.headers };
}

export async function post(url: string, body: unknown, headers: Record<string, string> = auth) {
  const r = await fetch(url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}
