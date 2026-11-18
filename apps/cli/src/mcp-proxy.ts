// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-581: `based mcp` – MCP über stdio für Clients, die einen Befehl starten (Claude Desktop, Claude Code, Cursor).
// Der Befehl leitet jede Nachricht unverändert an `POST /mcp` des Servers weiter (lokaler Server der Mac-App oder ein
// eigener Server) und die Antworten zurück. So steht kein Token in der Konfiguration des Clients: `based` liest ihn wie
// jeder andere Befehl (Discovery-Datei der App, BASED_TOKEN, --token-file, `based login`).
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/** Die Protokollversion aus der Antwort auf `initialize` (der HTTP-Transport schickt sie danach als Header mit). */
export function negotiatedVersion(m: JSONRPCMessage): string | undefined {
  const r = (m as { result?: { protocolVersion?: unknown; serverInfo?: unknown } }).result;
  return r && typeof r.protocolVersion === "string" && r.serverInfo !== undefined ? r.protocolVersion : undefined;
}

/**
 * Verbindet zwei Transporte: `client` (stdio, der MCP-Client) und `server` (Streamable HTTP). Endet, sobald eine Seite
 * schließt; ein Fehler beim Weiterleiten einer Anfrage geht als JSON-RPC-Fehler an den Client zurück, damit er nicht
 * auf eine Antwort wartet, die nie kommt.
 */
export function bridge(client: Transport, server: Transport & { setProtocolVersion?: (v: string) => void }, onError: (e: Error) => void = () => undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      void Promise.allSettled([client.close(), server.close()]).then(() => resolve());
    };
    client.onmessage = (m) => {
      server.send(m).catch((e: unknown) => {
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
        const id = (m as { id?: string | number }).id;
        if (id !== undefined && "method" in m) void client.send({ jsonrpc: "2.0", id, error: { code: -32000, message: `Based server: ${err.message.slice(0, 300)}` } }).catch(() => undefined);
      });
    };
    server.onmessage = (m) => {
      const v = negotiatedVersion(m);
      if (v) server.setProtocolVersion?.(v);
      client.send(m).catch((e: unknown) => onError(e instanceof Error ? e : new Error(String(e))));
    };
    client.onclose = close;
    server.onclose = close;
    client.onerror = onError;
    server.onerror = onError;
    void Promise.all([server.start(), client.start()]).catch((e: unknown) => {
      onError(e instanceof Error ? e : new Error(String(e)));
      close();
    });
  });
}
