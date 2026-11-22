// BSD-558: fehlende Dateien beim Wiederherstellen werden genannt, nicht verschluckt.
import { describe, expect, it } from "vitest";
import { damagedBackupText, restoredMessage } from "./backupText.js";

describe("restoredMessage", () => {
  const at = Date.UTC(2026, 10, 18, 10, 0);
  it("ohne fehlende Dateien wie bisher", () => {
    expect(restoredMessage(at)).toMatch(/^Restored the backup from .+ restore that one to undo\.$/);
    expect(restoredMessage(at, 0)).toBe(restoredMessage(at));
  });
  it("nennt fehlende Dateien (Einzahl/Mehrzahl)", () => {
    expect(restoredMessage(at, 1)).toContain("1 file (image or attachment) from this backup was not found");
    expect(restoredMessage(at, 3)).toContain("3 files (images or attachments) from this backup were not found");
  });
});

describe("damagedBackupText (BSD-648)", () => {
  it("unversehrt: nichts", () => expect(damagedBackupText(undefined)).toBe(""));
  it("beschädigt: sagt es zuerst, mit N von M Records, und was das Wiederherstellen tut", () => {
    expect(damagedBackupText({ readable: 2, expected: 7 })).toBe("This backup is damaged: only 2 of 7 records can be read. ");
  });
});
