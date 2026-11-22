import { describe, expect, it } from "vitest";
import { beginFreshPage, cancelFreshPage, markFreshPage, takeFreshPage, takeTypedAhead, stopTypedAhead, typeAheadStep, type TypedAhead } from "./freshPage.js";

describe("freshPage (BSD-482)", () => {
  it("gibt eine vorgemerkte Seite genau einmal her, andere nie", () => {
    markFreshPage("a");
    expect(takeFreshPage("b")).toBe(false);
    expect(takeFreshPage("a")).toBe(true);
    expect(takeFreshPage("a")).toBe(false);
  });
  it("die zuletzt angelegte Seite gewinnt", () => {
    markFreshPage("a");
    markFreshPage("b");
    expect(takeFreshPage("a")).toBe(false);
    expect(takeFreshPage("b")).toBe(true);
  });
});

const key = (k: string, mods: { meta?: boolean; ctrl?: boolean; composing?: boolean } = {}) =>
  ({ key: k, metaKey: Boolean(mods.meta), ctrlKey: Boolean(mods.ctrl), isComposing: Boolean(mods.composing) });

describe("Tippen vor dem Fokus im neuen Titel (BSD-645)", () => {
  it("Zeichen und ⌫ gehen in den Titel, Enter wechselt in den Text", () => {
    const t: TypedAhead = { title: "" };
    for (const k of [..."Helo", "Backspace", ..."lo", "Shift", "Ä", " ", "Enter", ..."ok"]) expect(typeAheadStep(t, key(k))).not.toBe("stop");
    expect(t).toEqual({ title: "HelloÄ ", body: "ok" });
  });
  it("Kürzel, Esc, Pfeile, Eingabemethode und ein zweites Enter beenden das Auffangen", () => {
    expect(typeAheadStep({ title: "" }, key("k", { meta: true }))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("k", { ctrl: true }))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("Escape"))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("ArrowDown"))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("a", { composing: true }))).toBe("stop");
    expect(typeAheadStep({ title: "x", body: "" }, key("Enter"))).toBe("stop");
    expect(typeAheadStep({ title: "x", body: "" }, key("Backspace"))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("Meta"))).toBe("pass");
  });

  const press = (target: EventTarget, k: string, mods: { meta?: boolean } = {}) => {
    const e = Object.assign(new Event("keydown", { cancelable: true }), key(k, mods));
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it("fängt zwischen Anlegen und Titel auf, gibt es einmal her und hört dann auf", () => {
    const win = new EventTarget() as unknown as Window;
    beginFreshPage(win);
    expect(press(win, "H")).toBe(true);
    expect(press(win, "i")).toBe(true);
    expect(takeTypedAhead()).toEqual({ title: "Hi" });
    expect(takeTypedAhead()).toBeUndefined();
    expect(press(win, "x")).toBe(false);
  });
  it("nach Enter fängt es weiter auf, bis der Text der Seite die Schreibmarke hat", () => {
    const win = new EventTarget() as unknown as Window;
    beginFreshPage(win);
    for (const k of ["T", "Enter", "a"]) press(win, k);
    const t = takeTypedAhead()!;
    expect(press(win, "b")).toBe(true);
    expect(t).toEqual({ title: "T", body: "ab" });
    stopTypedAhead();
    expect(press(win, "c")).toBe(false);
  });
  it("ein Kürzel beendet das Auffangen, das bis dahin Getippte bleibt; Abbrechen verwirft es", () => {
    const win = new EventTarget() as unknown as Window;
    beginFreshPage(win);
    press(win, "a");
    expect(press(win, "k", { meta: true })).toBe(false);
    expect(press(win, "b")).toBe(false);
    expect(takeTypedAhead()).toEqual({ title: "a" });
    beginFreshPage(win);
    press(win, "z");
    cancelFreshPage();
    expect(press(win, "y")).toBe(false);
    expect(takeTypedAhead()).toBeUndefined();
  });
});
