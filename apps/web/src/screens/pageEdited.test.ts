import { describe, expect, it } from "vitest";
import { editedLabel } from "./PageView.js";

const SWIFT_EPOCH_MS = 978_307_200_000;
const swift = (d: Date) => (d.getTime() - SWIFT_EPOCH_MS) / 1000;

describe("„Edited …“ in der Kopfzeile (BSD-204)", () => {
  it("formuliert relativ zur Gegenwart", () => {
    const now = new Date(2026, 10, 10, 22, 0, 0);
    expect(editedLabel(swift(new Date(2026, 10, 10, 21, 59, 30)), now)).toBe("Edited just now");
    expect(editedLabel(swift(new Date(2026, 10, 10, 21, 55, 0)), now)).toBe("Edited 5 min ago");
    expect(editedLabel(swift(new Date(2026, 10, 10, 19, 0, 0)), now)).toBe("Edited 3 h ago");
    expect(editedLabel(swift(new Date(2026, 10, 9, 12, 0, 0)), now)).toBe("Edited yesterday");
    expect(editedLabel(swift(new Date(2026, 10, 3, 12, 0, 0)), now)).toBe("Edited 3 Nov");
    expect(editedLabel(undefined, now)).toBeUndefined();
  });
});
