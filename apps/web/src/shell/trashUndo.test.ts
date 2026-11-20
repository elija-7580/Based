// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { lastTrashed, movedToTrash, subscribeTrashed, takeTrashed, trashedText } from "./trashUndo.js";

describe("BSD-619: zuletzt gelöschte Seiten", () => {
  it("merkt das letzte Löschen, gibt es einmal zurück und meldet Änderungen", () => {
    let calls = 0;
    const off = subscribeTrashed(() => calls++);
    movedToTrash(["a"], "a");
    movedToTrash(["b", "c"]);
    expect(lastTrashed()).toMatchObject({ ids: ["b", "c"], reopen: undefined });
    expect(takeTrashed()?.ids).toEqual(["b", "c"]);
    expect(takeTrashed()).toBeUndefined();
    expect(lastTrashed()).toBeUndefined();
    movedToTrash([]);
    expect(lastTrashed()).toBeUndefined();
    expect(calls).toBe(3);
    off();
  });
  it("Text im Hinweis", () => {
    expect(trashedText(1)).toBe("Moved to Trash");
    expect(trashedText(3)).toBe("Moved 3 pages to Trash");
  });
});
