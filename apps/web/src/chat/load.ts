// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// BSD-595: Der Chat-Code (ChatController, Anbieter, Agent Brain, MCP) ist ein eigener Chunk. Er wird erst geladen,
// wenn AI an ist – auf der Beta (AI ausgeblendet) nie. Editor und Datenbank fragen ihn über diese Datei an.
import type { StoreClient } from "../worker/client.js";
import type { ChatController } from "./controller.js";

type ChatRuntime = typeof import("./runtime.js");

let pending: Promise<ChatRuntime> | undefined;
let loaded: ChatRuntime | undefined;

/** Chat-Code laden (einmal); danach liefert `loadedChatController` ihn sofort. */
export function loadChatRuntime(): Promise<ChatRuntime> {
  return (pending ??= import("./runtime.js").then((m) => (loaded = m)));
}

/** Der ChatController, sobald geladen; sonst `undefined` (und das Laden beginnt). */
export function loadedChatController(client: StoreClient): ChatController | undefined {
  if (loaded) return loaded.chatController(client);
  void loadChatRuntime();
  return undefined;
}

/** Ein Schreib-Turn ohne Werkzeuge (Ask AI im Editor, Autofill in Datenbanken) über den geladenen Chat. */
export async function chatWrite(client: StoreClient, system: string, prompt: string, signal: AbortSignal): Promise<string> {
  return (await loadChatRuntime()).chatController(client).write(system, prompt, signal);
}

/** Kann der Chat gerade schreiben (Modell eingerichtet)? Vor dem Laden: nein. */
export const chatCanWrite = (client: StoreClient): boolean => loadedChatController(client)?.canWrite() ?? false;
