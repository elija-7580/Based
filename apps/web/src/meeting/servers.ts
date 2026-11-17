// Feedback 17. 11.: Wo kann transkribiert werden? Zuerst der lokale Server der Mac-App (auf diesem Mac, nichts
// verlässt ihn), dann der verbundene based-server. Bisher wurde nur der verbundene gefragt – die Mac-App meldete
// deshalb immer „Transcription isn't available“.
import { localServer } from "../desktop/localServer.js";
import { syncConfig } from "../shell/storage.js";
import type { ServerAccess } from "./whisper.js";

export interface TranscriptionServer extends ServerAccess { local: boolean }

/** Reine Regel (getestet): lokaler Server vorn, derselbe Server nur einmal. */
export function orderServers(local: ServerAccess | undefined, sync: ServerAccess | undefined): TranscriptionServer[] {
  const norm = (u: string) => u.replace(/\/+$/, "");
  const out: TranscriptionServer[] = [];
  if (local?.url) out.push({ ...local, local: true });
  if (sync?.url && !out.some((s) => norm(s.url) === norm(sync.url))) out.push({ url: sync.url, token: sync.token, local: false });
  return out;
}

export async function transcriptionServers(): Promise<TranscriptionServer[]> {
  const local = await localServer().syncConfig().catch(() => undefined);
  return orderServers(local, syncConfig.get());
}
