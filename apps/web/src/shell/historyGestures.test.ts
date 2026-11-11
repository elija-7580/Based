import { expect, it } from "vitest";
import { newSwipe, SWIPE_DISTANCE, swipeStep, type SwipeState, type WheelLike } from "./historyGestures.js";

function run(events: Partial<WheelLike>[], start: SwipeState = newSwipe()) {
  let state = start;
  const gos: number[] = [];
  let t = 0, progress = 0;
  for (const e of events) {
    const r = swipeStep(state, { deltaX: 0, deltaY: 0, time: (t += 16), ...e });
    state = r.state;
    progress = r.progress;
    if (r.go) gos.push(r.go);
  }
  return { gos, state, progress };
}

it("Wisch nach rechts (deltaX negativ) geht genau einmal zurück, auch wenn die Geste ausläuft", () => {
  const steps = Array.from({ length: 30 }, () => ({ deltaX: -20 }));
  expect(run(steps).gos).toEqual([-1]);
});

it("Wisch nach links geht vor; ein kurzer Wisch tut nichts und zeigt Fortschritt", () => {
  expect(run(Array.from({ length: 13 }, () => ({ deltaX: 20 }))).gos).toEqual([1]);
  const short = run(Array.from({ length: 5 }, () => ({ deltaX: -20 })));
  expect(short.gos).toEqual([]);
  expect(short.progress).toBeCloseTo(100 / SWIPE_DISTANCE);
});

it("senkrechtes Scrollen und scrollbare Elemente verbrauchen die Geste", () => {
  expect(run([{ deltaY: 30 }, ...Array.from({ length: 30 }, () => ({ deltaX: -20 }))]).gos).toEqual([]);
  expect(run([{ deltaX: -20, blocked: true }, ...Array.from({ length: 30 }, () => ({ deltaX: -20 }))]).gos).toEqual([]);
  expect(run(Array.from({ length: 30 }, () => ({ deltaX: -20, ctrlKey: true }))).gos).toEqual([]);
});

it("nach einer Pause beginnt eine neue Geste", () => {
  const first = run(Array.from({ length: 30 }, () => ({ deltaX: -20 })));
  const r = swipeStep(first.state, { deltaX: -SWIPE_DISTANCE, deltaY: 0, time: first.state.last + 1000 });
  expect(r.go).toBe(-1);
});

it("Richtungswechsel setzt neu an", () => {
  expect(run([...Array.from({ length: 10 }, () => ({ deltaX: -20 })), ...Array.from({ length: 10 }, () => ({ deltaX: 20 }))]).gos).toEqual([]);
});
