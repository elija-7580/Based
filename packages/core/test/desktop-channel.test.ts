// BSD-455: Based Beta neben Based Next – keine zwei Kanäle teilen Port, Datei, Ordner oder Befehl; Next bleibt wie bisher.
import { describe, expect, it } from "vitest";
import { DESKTOP_CHANNELS, desktopChannel, desktopPlaces } from "../src/index.js";

describe("Desktop-Kanäle (BSD-455)", () => {
  it("Based Next behält alle bisherigen Namen (keine Migration)", () => {
    expect(desktopPlaces("next")).toMatchObject({ appName: "Based Next", port: 47821, discoveryFile: "local.json", tokenFile: "local-token", backupFolder: "Based Backups", icloudFolder: "Based", cliName: "based" });
    expect(desktopPlaces()).toEqual(desktopPlaces("next"));
  });

  it("Based Beta: eigener Port, eigene Dateien und Ordner", () => {
    expect(desktopPlaces("beta")).toMatchObject({ appName: "Based Beta", port: 47822, backupFolder: "Based Beta Backups", cliName: "based-beta" });
  });

  it("kein Wert wird von zwei Kanälen geteilt", () => {
    for (const key of ["appName", "port", "discoveryFile", "tokenFile", "backupFolder", "icloudFolder", "cliName"] as const) {
      const values = DESKTOP_CHANNELS.map((c) => desktopPlaces(c)[key]);
      expect(new Set(values).size, key).toBe(values.length);
    }
  });

  it("Kanal aus Umgebung/Build-Schalter: nur „beta“ ist die Beta", () => {
    expect(desktopChannel("beta")).toBe("beta");
    expect(desktopChannel(" Beta ")).toBe("beta");
    for (const v of [undefined, null, "", "dev", "next", "stable"]) expect(desktopChannel(v)).toBe("next");
    expect(desktopPlaces("dev").channel).toBe("next");
  });
});
