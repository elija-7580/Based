import { WorkspaceStore } from "@based/core";
// Testserver auf einem freien Port aus 18100–18199 (parallele Arbeitsordner teilen sich die Maschine).
import { createApp, type App, type AppOptions } from "../src/app.js";
import { silentLogger } from "../src/log.js";

export const TOKEN = "test-token-0123456789";

// Jeder Start nimmt den nächsten Port (keine Wiederverwendung im selben Lauf: fetch hält Verbindungen offen).
let next = Math.floor(Math.random() * 100);

export async function startApp(opts: Partial<AppOptions> = {}): Promise<App & { url: string; port: number }> {
  for (let i = 0; i < 100; i++) {
    const port = 18_100 + (next++ % 100);
    const app = createApp({ token: TOKEN, log: silentLogger, compactEvery: false, ...opts });
    try {
      const addr = await app.listen(port, "127.0.0.1");
      return Object.assign(app, addr);
    } catch (e) {
      await app.close().catch(() => {});
      if ((e as NodeJS.ErrnoException).code !== "EADDRINUSE") throw e;
    }
  }
  throw new Error("no free port in 18100–18199");
}

export const auth = { Authorization: `Bearer ${TOKEN}` };

/** BSD-30: Läuft die Suite im neuen Format (BASED_PROPERTY_RECORDS=1), sprechen die Helfer Protokoll 3. */
export const protocolHeader = (): Record<string, string> => (WorkspaceStore.propertyRecordsByDefault ? { "X-Based-Protocol": "3" } : {});

export async function get(url: string, headers: Record<string, string> = auth) {
  const r = await fetch(url, { headers: { ...protocolHeader(), ...headers } });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined, headers: r.headers };
}

export async function post(url: string, body: unknown, headers: Record<string, string> = auth) {
  const r = await fetch(url, { method: "POST", headers: { ...protocolHeader(), ...headers, "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as Record<string, unknown> | undefined };
}
