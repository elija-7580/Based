// BSD-217 Teil 2: HTTP für den Notion-API-Import. In der Desktop-App über das Tauri-HTTP-Plugin (Rust, kein CORS;
// erlaubte Adressen stehen in apps/desktop/src-tauri/capabilities/default.json), im Browser über fetch – dort lehnt
// Notion Anfragen aus fremden Ursprüngen ab, das sagen wir dem Nutzer verständlich.
import { fetchTransport, type NotionTransport } from "@based/core";
import { isTauri } from "../desktop.js";
import { secretVault } from "./storage.js";

export const NOTION_TOKEN_SECRET = "notion:token";

/** Das gespeicherte Token (verschlüsselt, nur auf diesem Gerät). */
export const notionToken = {
  get: () => secretVault().getSecret(NOTION_TOKEN_SECRET),
  has: () => secretVault().hasSecret(NOTION_TOKEN_SECRET),
  set: (token: string | undefined) => secretVault().setSecret(NOTION_TOKEN_SECRET, token?.trim() || undefined),
};

export async function notionTransport(): Promise<NotionTransport> {
  if (isTauri()) {
    const http = await import("@tauri-apps/plugin-http");
    return fetchTransport((input, init) => http.fetch(input as string, init));
  }
  return fetchTransport();
}

/** Andere API-Adresse für Tests (Fake-Server): `__based.notionBaseURL`. */
export function notionBaseURL(g: { __based?: { notionBaseURL?: string } } = globalThis as never): string | undefined {
  const u = g.__based?.notionBaseURL;
  return typeof u === "string" && u ? u : undefined;
}

/**
 * Fehlermeldung für Menschen. Im Browser scheitert die Anfrage schon vor Notion (CORS) – das ist kein Tippfehler im
 * Token, sondern eine Grenze des Browsers.
 */
export function describeNotionError(e: unknown, opts: { tauri?: boolean; customBase?: boolean } = {}): string {
  const tauri = opts.tauri ?? isTauri();
  const message = e instanceof Error ? e.message : String(e);
  const network = e instanceof TypeError || /failed to fetch|load failed|networkerror|not allowed by access-control/i.test(message);
  if (network && !tauri && !opts.customBase) {
    return "A browser tab can't reach Notion's API (Notion blocks requests from other websites). Open Based in the desktop app to import directly from Notion — or export from Notion and import the ZIP here.";
  }
  if (network) return "Couldn't reach Notion. Check your internet connection and try again.";
  return message;
}
