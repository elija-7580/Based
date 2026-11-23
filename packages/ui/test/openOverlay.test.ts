// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Elija Samuel Friedrich-Ulrich
import { describe, expect, it } from "vitest";
import { openOverlay } from "../src/native/openOverlay.js";

// BSD-657: WebKit vor 17 (macOS 13 mit Safari 16) wirft bei `:popover-open` – dann ohne den Selektor prüfen, ob das
// Popover gezeichnet wird.
type El = { name: string; closest: (s: string) => { getClientRects: () => { length: number } } | null };
const el = (name: string, popover?: "open" | "closed"): El => ({
  name,
  closest: () => (popover ? { getClientRects: () => ({ length: popover === "open" ? 1 : 0 }) } : null),
});
const fake = (supportsPopoverOpen: boolean, all: El[] = [], extraHit: El | null = null) => {
  const asked: string[] = [];
  const check = (sel: string) => {
    asked.push(sel);
    if (!supportsPopoverOpen && sel.includes(":popover-open")) throw new SyntaxError(`'${sel}' is not a valid selector.`);
  };
  return {
    asked,
    querySelector: (sel: string) => { check(sel); return extraHit; },
    querySelectorAll: (sel: string) => { check(sel); return all; },
  } as unknown as ParentNode & { asked: string[] };
};

describe("openOverlay", () => {
  it("nimmt Elemente in geschlossenen Popovers aus, wenn der Browser :popover-open kennt", () => {
    const doc = fake(true);
    expect(openOverlay(doc, "[role=menu], [role=dialog]")).toBeNull();
    expect(doc.asked).toEqual([":is([role=menu], [role=dialog]):not([popover]:not(:popover-open) *)"]);
  });
  it("hängt weitere Selektoren ohne Filter an", () => {
    const doc = fake(true);
    openOverlay(doc, "[role=menu]", ".dbui-popover, dialog[open]");
    expect(doc.asked[0]).toBe(":is([role=menu]):not([popover]:not(:popover-open) *), .dbui-popover, dialog[open]");
  });
  it("WebKit vor 17: wirft nicht, zählt geschlossene Popovers nicht, offene und freie Menüs schon", () => {
    expect(openOverlay(fake(false, [el("closed", "closed")]), "[role=menu]")).toBeNull();
    expect((openOverlay(fake(false, [el("closed", "closed"), el("open", "open")]), "[role=menu]") as unknown as El).name).toBe("open");
    expect((openOverlay(fake(false, [el("plain")]), "[role=menu]") as unknown as El).name).toBe("plain");
    const extra = el("extra");
    expect(openOverlay(fake(false, [el("closed", "closed")], extra), "[role=menu]", ".dbui-popover")).toBe(extra);
  });
});
