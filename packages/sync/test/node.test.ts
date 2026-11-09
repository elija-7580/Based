// BSD-145: Gerätekennung nach Kopie/Wiederherstellung der Datenbank neu wählen.
import { describe, expect, it } from "vitest";
import { openWorkspace, resolveNode, type DeviceNodeStore } from "../src/index.js";
import { openNodeDatabase } from "../src/drivers/node.js";

const deviceStore = (initial?: string): DeviceNodeStore & { value: string | undefined } => {
  const d = { value: initial, get: () => d.value, set: (v: string) => void (d.value = v) };
  return d;
};

describe("resolveNode", () => {
  let n = 0;
  const make = () => `NEW${++n}`;
  it("gleiches Gerät, gleiche Datei → gleiche Kennung", () => {
    expect(resolveNode("AAAA", "AAAA", make)).toEqual({ node: "AAAA", rotated: false, reason: "same" });
  });
  it("Datei von einem anderen Gerät → neue Kennung", () => {
    expect(resolveNode("AAAA", "BBBB", make)).toMatchObject({ rotated: true, reason: "copied" });
  });
  it("alte Datei ohne meta.node → Gerätekennung", () => {
    expect(resolveNode("AAAA", undefined, make)).toEqual({ node: "AAAA", rotated: false, reason: "adopted" });
  });
  it("Gerät ohne Kennung öffnet vorhandene Datei → neue Kennung (Kopie oder Neuinstallation)", () => {
    expect(resolveNode(undefined, "BBBB", make)).toMatchObject({ rotated: true, reason: "unknownDevice" });
  });
  it("alles neu", () => {
    expect(resolveNode(undefined, undefined, make)).toMatchObject({ rotated: false, reason: "new" });
  });
});

describe("openWorkspace mit Gerät", () => {
  it("bleibt über Neustarts gleich, wird bei Kopie auf ein zweites Gerät neu gewählt", () => {
    const db = openNodeDatabase();
    const mac = deviceStore();
    const first = openWorkspace(db, { device: mac });
    const node = first.store.clock.node;
    expect(mac.value).toBe(node);
    expect(first.persistence.meta("node")).toBe(node);
    expect(openWorkspace(db, { device: mac }).store.clock.node).toBe(node);

    // Dieselbe Datei auf einem zweiten Gerät (Kopie, Wiederherstellung auf neuem Mac).
    const other = deviceStore("ZZZZ");
    const rotations: string[] = [];
    const copy = openWorkspace(db, { device: other, onNodeRotated: (r) => rotations.push(r.reason) });
    expect(copy.store.clock.node).not.toBe(node);
    expect(copy.store.clock.node).not.toBe("ZZZZ");
    expect(rotations).toEqual(["copied"]);
    expect(copy.persistence.meta("node.rotated")).toMatch(/^copied at /);

    // Das ursprüngliche Gerät öffnet sie danach wieder: auch das ist jetzt eine fremde Datei → nochmals neu.
    expect(openWorkspace(db, { device: mac }).store.clock.node).not.toBe(node);
  });

  it("alte Datei ohne meta.node übernimmt die Gerätekennung und trägt sie ein", () => {
    const db = openNodeDatabase();
    openWorkspace(db, { node: "X" }).persistence.setMeta("node", undefined);
    const mac = deviceStore("MAC1");
    const w = openWorkspace(db, { device: mac });
    expect(w.store.clock.node).toBe("MAC1");
    expect(w.persistence.meta("node")).toBe("MAC1");
  });

  it("kein Datenformat-Wechsel: nur meta wird geschrieben", () => {
    const db = openNodeDatabase();
    openWorkspace(db, { device: deviceStore() });
    const before = db.all("SELECT COUNT(*) AS n FROM changes")[0];
    openWorkspace(db, { device: deviceStore("OTHER") });
    expect(db.all("SELECT COUNT(*) AS n FROM changes")[0]).toEqual(before);
  });
});
