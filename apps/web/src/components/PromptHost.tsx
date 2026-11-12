// Zeichnet die Dialoge aus shell/prompts.ts (Update-Rückfrage, Hinweise) als Based-Dialog.
import { useSyncExternalStore } from "react";
import { BasedButton, BasedDialog } from "@based/ui/astryx";
import { prompts } from "../shell/prompts.js";

export function PromptHost() {
  const p = useSyncExternalStore(prompts.subscribe, prompts.current, prompts.current);
  if (!p) return null;
  const answer = (yes: boolean) => prompts.settle(p.id, yes);
  return (
    <BasedDialog key={p.id} open onClose={() => answer(false)} title={p.title}
      actions={<>
        {p.kind === "ask" ? <BasedButton label={p.cancelLabel} variant="ghost" onClick={() => answer(false)} /> : null}
        <BasedButton label={p.okLabel} variant="primary" onClick={() => answer(true)} />
      </>}>
      {/* Mehrzeilig (Update-Hinweis mit „What’s new“): Zeilenumbrüche bleiben. */}
      <p className="t-body prompt-text" data-testid="prompt-text">{p.text}</p>
    </BasedDialog>
  );
}
