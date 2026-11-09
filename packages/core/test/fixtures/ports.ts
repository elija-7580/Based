// BSD-149/151: Welche Module im TS-Kern schon portiert sind. Ein Port bekommt die Eingabe eines Falls und die
// Datei-Metadaten (z. B. Records, `now`) und liefert die Ausgabe im Fixture-Format. Nicht eingetragene Module
// werden übersprungen und im Bericht als „nicht portiert“ geführt.
// Offen: formulas, queries, values, merge, conversion, search, clipboard, undo-remote.
import { compareStamps, isValidKey, keyBetween, keysBetween, parseStamp, StampClock, stampToString } from "../../src/index.js";
import type { Stamp } from "../../src/hlc.js";
import type { FixtureCase } from "./load.js";

export type Port = (input: FixtureCase["input"], meta: Record<string, unknown>) => unknown;

type HlcInput =
  | { op: "compare"; a: Stamp; b: Stamp }
  | { op: "description"; stamp: Stamp }
  | { op: "parse"; text: string }
  | { op: "clock"; node: string; last: Stamp; maxDrift: number; steps: ({ op: "now"; wall: number } | { op: "observe"; wall: number; remote: Stamp })[] };

type SortKeysInput =
  | { op: "between"; a: string | null; b: string | null }
  | { op: "isValid"; key: string }
  | { op: "keys"; count: number; a: string | null; b: string | null };

const hlc: Port = (raw) => {
  const input = raw as HlcInput;
  switch (input.op) {
    case "compare": return compareStamps(input.a, input.b);
    case "description": return stampToString(input.stamp);
    case "parse": return parseStamp(input.text) ?? null;
    case "clock": {
      if (input.maxDrift !== StampClock.maxDrift) throw new Error("maxDrift weicht ab");
      const clock = new StampClock(input.node, input.last);
      return input.steps.map((s) => {
        clock.wallClock = () => s.wall;
        if (s.op === "now") return { result: clock.now() };
        const result = clock.observe(s.remote);
        return { result, current: clock.current };
      });
    }
  }
};

const sortkeys: Port = (raw) => {
  const input = raw as SortKeysInput;
  switch (input.op) {
    case "between": return keyBetween(input.a, input.b);
    case "isValid": return isValidKey(input.key);
    case "keys": return keysBetween(input.count, input.a, input.b);
  }
};

export const PORTS: Record<string, Port | undefined> = { hlc, sortkeys };
