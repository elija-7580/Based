import { describe, expect, it } from "vitest";
import { askUser, prompts, showMessage } from "./prompts.js";

describe("prompts", () => {
  it("zeigt Dialoge nacheinander und löst sie mit der Antwort auf", async () => {
    const seen: (string | undefined)[] = [];
    const off = prompts.subscribe(() => seen.push(prompts.current()?.title));
    const first = askUser("Install now?", { title: "Update available", okLabel: "Install and Restart", cancelLabel: "Later" });
    const second = showMessage("Done.", { title: "Updates" });
    expect(prompts.current()).toMatchObject({ kind: "ask", title: "Update available", okLabel: "Install and Restart", cancelLabel: "Later" });
    prompts.settle(prompts.current()!.id, false);
    expect(await first).toBe(false);
    expect(prompts.current()).toMatchObject({ kind: "message", title: "Updates", okLabel: "OK" });
    prompts.settle(prompts.current()!.id, true);
    await second;
    expect(prompts.current()).toBeUndefined();
    expect(seen).toEqual(["Update available", "Update available", "Updates", undefined]);
    off();
  });

  it("ignoriert Antworten auf unbekannte Dialoge", () => {
    prompts.settle(9999, true);
    expect(prompts.current()).toBeUndefined();
  });
});
