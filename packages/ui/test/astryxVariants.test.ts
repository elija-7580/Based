import { describe, expect, it } from "vitest";
import { buttonVariant, dialogPurpose, fieldStatus, menuItems, pickerText } from "../src/astryx/variants.js";

describe("Based-Wrapper um Astryx", () => {
  it("Button: danger heißt bei Astryx destructive, Standard ist secondary", () => {
    expect(buttonVariant(undefined)).toBe("secondary");
    expect(buttonVariant("primary")).toBe("primary");
    expect(buttonVariant("danger")).toBe("destructive");
  });
  it("Dialog: beschäftigt lässt sich nicht schließen, Formular nicht per Klick daneben", () => {
    expect(dialogPurpose({})).toBe("info");
    expect(dialogPurpose({ form: true })).toBe("form");
    expect(dialogPurpose({ form: true, busy: true })).toBe("required");
  });
  it("Filter-Pille (BasedPicker): „Label: Wert“, ohne passenden Wert nur das Label", () => {
    const opts = [{ id: "all", label: "All types" }, { id: "page", label: "Pages" }];
    expect(pickerText("Type", opts, "all")).toBe("Type: All types");
    expect(pickerText("Type", opts, "page")).toBe("Type: Pages");
    expect(pickerText("Type", opts, "gone")).toBe("Type");
  });
  it("Feld: nur ein nicht leerer Fehlertext wird zum Status", () => {
    expect(fieldStatus(undefined)).toBeUndefined();
    expect(fieldStatus("  ")).toBeUndefined();
    expect(fieldStatus(" Enter a URL ")).toEqual({ type: "error", message: "Enter a URL" });
  });
  it("Menü: Trennlinien nur zwischen Einträgen, danger wird destructive", () => {
    const run = () => undefined;
    expect(menuItems([{}, { label: "Rename", onSelect: run }, {}, {}, { label: "Delete", danger: true, disabled: true, description: "Moves it to Trash" }, {}])).toEqual([
      { label: "Rename", onClick: run },
      { type: "divider" },
      { label: "Delete", description: "Moves it to Trash", isDisabled: true, variant: "destructive" },
    ]);
    expect(menuItems([{}])).toEqual([]);
  });
});
