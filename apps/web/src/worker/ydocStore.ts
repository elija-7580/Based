// BSD-220 Teil 2: Y-Zustände der Editor-Dokumente im Store-Worker (ydocs.sqlite). Der Editor holt den Zustand vor dem
// Öffnen einer Sitzung (`prepare`), `load` gibt ihn dann synchron heraus; `save` schickt den ganzen Zustand an den
// Worker (Nachrichten laufen der Reihe nach – ein Speichern vor dem nächsten Laden kommt also immer zuerst an).
// Im Hauptthread bleibt nichts liegen: die offene Sitzung hält ihr Y.Doc selbst.
import type { YDocStore } from "@based/editor";
import type { StoreClient } from "./client.js";

export class WorkerYDocStore implements YDocStore {
  private readonly ready = new Map<string, Uint8Array>();

  constructor(private readonly client: Pick<StoreClient, "ydocLoad" | "ydocSave">, private readonly onError: (e: unknown) => void = () => undefined) {}

  async prepare(rootID: string): Promise<void> {
    const state = await this.client.ydocLoad(rootID);
    if (state && state.length) this.ready.set(rootID, state);
    else this.ready.delete(rootID);
  }

  load(rootID: string): Uint8Array | undefined {
    const state = this.ready.get(rootID);
    this.ready.delete(rootID);
    return state;
  }

  save(rootID: string, state: Uint8Array): void {
    this.client.ydocSave(rootID, state).catch(this.onError);
  }
}
