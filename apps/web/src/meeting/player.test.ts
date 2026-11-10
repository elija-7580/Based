// BSD-226: welche Spuren eine Stelle im Meeting abspielt.
import { describe, expect, it } from "vitest";
import { tracksAt } from "./player.js";

const t = (role: "microphone" | "system", offset: number, duration: number, id: string) => ({ role, offset, duration, asset: { id, name: id } });

describe("tracksAt", () => {
  const tracks = [t("microphone", 0, 60, "m1"), t("system", 0, 60, "s1"), t("microphone", 60, 30, "m2")];
  it("alle Spuren der Aufnahme, in die die Stelle fällt", () => {
    expect(tracksAt(tracks, 12).map((x) => x.asset.id)).toEqual(["m1", "s1"]);
    expect(tracksAt(tracks, 75).map((x) => x.asset.id)).toEqual(["m2"]);
  });
  it("hinter dem Ende: die letzte Aufnahme davor; ohne Spuren nichts", () => {
    expect(tracksAt(tracks, 200).map((x) => x.asset.id)).toEqual(["m2"]);
    expect(tracksAt([], 3)).toEqual([]);
  });
});
