// @based/server – TS-Server (Sync v2, Hocuspocus, MCP) kommt in Phase 3.
// Bis dahin bleibt der Swift-based-server im Einsatz (ADR 0011, Strangler).
import { SYNC_PROTOCOL_VERSION } from "@based/sync";

export function health(): { ok: true; protocol: number } {
  return { ok: true, protocol: SYNC_PROTOCOL_VERSION };
}
