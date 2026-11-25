// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
// Verdrahtung von „Write anywhere“ im Hauptfenster der Mac-App: Einstellung, Chat-Modell, Gedächtnis, Privacy-Redact.
import { Redactor } from "@based/brain";
import { BrainClient } from "../brain/client.js";
import { brainSettings } from "../brain/settings.js";
import { chatWrite } from "../chat/load.js";
import { aiSetting } from "../shell/ai.js";
import type { StoreClient } from "../worker/client.js";
import { startAnywhere } from "./anywhere.js";

export function startAnywhereService(client: StoreClient): () => void {
  const brain = new BrainClient(client);
  return startAnywhere({
    enabled: () => aiSetting.get() && brainSettings().getState().anywhere === true,
    subscribe: (fn) => {
      const a = brainSettings().subscribe(fn), b = aiSetting.subscribe(fn);
      return () => { a(); b(); };
    },
    write: (system, prompt, signal) => chatWrite(client, system, prompt, signal),
    personal: (query) => brain.personal(query),
    redact: async () => {
      const r = brainSettings().getState().redact;
      if (!r.enabled) return undefined;
      const names = await brain.personNames().catch(() => [] as string[]);
      const redactor = new Redactor({ names: [...names, ...r.names], kinds: new Set(r.kinds) });
      return { out: (s) => redactor.redact(s).text, back: (s) => redactor.restore(s) };
    },
  });
}
