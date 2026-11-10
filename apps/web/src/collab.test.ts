// BSD-220 Teil 3: Adresse von /collab aus der Sync-Adresse (Token nie in der URL).
import { describe, expect, it } from "vitest";
import { collabURL, createCollab } from "./collab.js";

describe("collabURL", () => {
  it("http → ws, https → wss, Pfad bleibt, Query/Fragment fallen weg", () => {
    expect(collabURL("http://127.0.0.1:8787")).toBe("ws://127.0.0.1:8787/collab");
    expect(collabURL("https://based.example.com/sync/")).toBe("wss://based.example.com/sync/collab");
    expect(collabURL("https://based.example.com/?token=x#y")).toBe("wss://based.example.com/collab");
  });

  it("aus oder ohne Server: kein Collab-Dokument", async () => {
    const docs = { load: () => undefined, save: () => undefined };
    expect(await createCollab(docs, () => undefined).open("P")).toBeUndefined();
    expect(await createCollab(docs, () => ({ url: "https://s", token: "t" })).open("P")).toBeUndefined();
  });
});
