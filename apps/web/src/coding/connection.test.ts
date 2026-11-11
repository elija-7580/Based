import { describe, expect, it } from "vitest";
import { pickConnection } from "./connection.js";

describe("BSD-251 Verbindung für Coding und CLI-Verlauf", () => {
  it("der lokale Server geht vor, sonst der Sync-Server, sonst nichts", () => {
    const local = { url: "http://127.0.0.1:47821", token: "l" };
    const sync = { url: "https://based.example", token: "s" };
    expect(pickConnection(local, sync)).toEqual({ ...local, source: "local" });
    expect(pickConnection(undefined, sync)).toEqual({ ...sync, source: "server" });
    expect(pickConnection(undefined, undefined)).toBeUndefined();
    expect(pickConnection({ url: "", token: "" }, undefined)).toBeUndefined();
  });
});
