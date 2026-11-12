// Rückfragen und Hinweise als Based-Dialog statt als Systemdialog (früher tauri-plugin-dialog). Aufruf von überall
// (auch außerhalb von React, z. B. desktop.ts); gezeichnet wird in components/PromptHost.tsx.

export interface Prompt {
  id: number;
  kind: "message" | "ask";
  title: string;
  text: string;
  okLabel: string;
  cancelLabel: string;
  resolve: (yes: boolean) => void;
}

let next = 1;
let queue: readonly Prompt[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export const prompts = {
  subscribe(f: () => void): () => void { listeners.add(f); return () => { listeners.delete(f); }; },
  /** Der vorderste offene Dialog (weitere warten dahinter). */
  current: (): Prompt | undefined => queue[0],
  settle(id: number, yes: boolean) {
    const p = queue.find((x) => x.id === id);
    if (!p) return;
    queue = queue.filter((x) => x.id !== id);
    emit();
    p.resolve(yes);
  },
};

function open(kind: Prompt["kind"], title: string, text: string, okLabel: string, cancelLabel: string): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { id: next++, kind, title, text, okLabel, cancelLabel, resolve }];
    emit();
  });
}

/** Hinweis mit einem Knopf. */
export async function showMessage(text: string, opts: { title: string; okLabel?: string }): Promise<void> {
  await open("message", opts.title, text, opts.okLabel ?? "OK", "");
}

/** Rückfrage; `true`, wenn bestätigt. */
export function askUser(text: string, opts: { title: string; okLabel: string; cancelLabel?: string }): Promise<boolean> {
  return open("ask", opts.title, text, opts.okLabel, opts.cancelLabel ?? "Cancel");
}
