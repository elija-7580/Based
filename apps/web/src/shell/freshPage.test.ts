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
  it("Kürzel, Esc, Pfeile und ein zweites Enter beenden das Auffangen", () => {
    expect(typeAheadStep({ title: "" }, key("k", { meta: true }))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("k", { ctrl: true }))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("Escape"))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("ArrowDown"))).toBe("stop");
    expect(typeAheadStep({ title: "x", body: "" }, key("Enter"))).toBe("stop");
    expect(typeAheadStep({ title: "x", body: "" }, key("Backspace"))).toBe("stop");
    expect(typeAheadStep({ title: "" }, key("Meta"))).toBe("pass");
  });
  it("BSD-654: tote Taste und Eingabemethode beenden das Auffangen nicht (das alte Feld hat keinen Fokus mehr)", () => {
    const t: TypedAhead = { title: "Caf" };
    expect(typeAheadStep(t, key("Dead"))).toBe("pass");
    expect(typeAheadStep(t, key("a", { composing: true }))).toBe("pass");
    expect(typeAheadStep(t, key("Process"))).toBe("pass");
    expect(typeAheadStep(t, key("é"))).toBe("take");
    expect(t.title).toBe("Café");
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

describe("Zuordnung zum Anlegen (BSD-654)", () => {
  const type = (target: EventTarget, text: string) => {
    for (const k of text) target.dispatchEvent(Object.assign(new Event("keydown", { cancelable: true }), key(k)));
  };
  it("zweimal ⌥⌘N: das Getippte gehört der zuletzt angelegten Seite, die erste bekommt weder Text noch Fokus", () => {
    const win = new EventTarget() as unknown as Window;
    const first = beginFreshPage(win);
    type(win, "x");
    const second = beginFreshPage(win);
    type(win, "Second");
    markFreshPage("A", first); // die erste Seite kommt erst jetzt an
    expect(takeFreshPage("A")).toBe(false);
    expect(takeTypedAhead("A")).toBeUndefined();
    type(win, "!"); // wird weiter aufgefangen
    markFreshPage("B", second);
    expect(takeFreshPage("B")).toBe(true);
    expect(takeTypedAhead("B")).toEqual({ title: "Second!" });
  });
  it("ein gescheitertes älteres Anlegen bricht das neuere nicht ab", () => {
    const win = new EventTarget() as unknown as Window;
    const first = beginFreshPage(win);
    const second = beginFreshPage(win);
    type(win, "ok");
    cancelFreshPage(first);
    markFreshPage("B", second);
    expect(takeTypedAhead("B")).toEqual({ title: "ok" });
  });
  it("Text, der ohne Tastendruck kommt (beforeinput), wird aufgefangen statt durchgelassen", () => {
    const win = new EventTarget() as unknown as Window;
    const tok = beginFreshPage(win);
    type(win, "Caf");
    const ev = Object.assign(new Event("beforeinput", { cancelable: true }), { inputType: "insertText", data: "é" });
    win.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    markFreshPage("C", tok);
    expect(takeTypedAhead("C")).toEqual({ title: "Café" });
  });
});
