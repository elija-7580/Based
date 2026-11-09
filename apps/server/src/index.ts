// @based/server – TS-based-server (Phase 3, BSD-158): Sync v2, MCP. Der Swift-based-server bleibt bis zur
// Ablösung im Einsatz (ADR 0011, Strangler); beide sprechen dasselbe Protokoll auf demselben Dateiformat.
import { SYNC_PROTOCOL_VERSION } from "@based/sync";

export function health(): { ok: true; protocol: number } {
  return { ok: true, protocol: SYNC_PROTOCOL_VERSION };
}

export { createApp, type App, type AppOptions } from "./app.js";
export { SyncService, decodePush, BadRequest, type PullPage, type PushReply, type WireDeletion } from "./sync.js";
export { createMcpServer } from "./mcp.js";
export { Pages } from "./pages.js";
export { Router } from "./router.js";
