// BSD-315: Erreichbarkeit im Tailnet – nur Tailscale-Adressen, eigene widerrufbare Geräte-Token statt Haupt-Token.
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { isTailnetAddress, tailnetAddresses, urlFor } from "../src/tailnet.js";
import { parseOptions } from "../src/main.js";
import { startApp, TOKEN } from "./helpers.js";

const apps: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });
const call = (url: string, token: string, method = "GET", body?: unknown) =>
  fetch(url, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("Tailnet (BSD-315)", () => {
  it("nur 100.64.0.0/10 und fd7a:115c:a1e0::/48, nie WLAN/LAN/Loopback", () => {
    expect(["100.64.0.1", "100.100.12.3", "100.127.255.254", "fd7a:115c:a1e0::1"].every(isTailnetAddress)).toBe(true);
    expect(["100.63.255.255", "100.128.0.1", "192.168.1.5", "10.0.0.2", "127.0.0.1", "fd00::1", "0.0.0.0"].some(isTailnetAddress)).toBe(false);
    const ifaces = {
      en0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
      lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      utun4: [{ address: "fd7a:115c:a1e0::42", family: "IPv6", internal: false }, { address: "100.101.102.103", family: "IPv4", internal: false }],
    } as unknown as Parameters<typeof tailnetAddresses>[0];
    expect(tailnetAddresses(ifaces)).toEqual(["100.101.102.103", "fd7a:115c:a1e0::42"]);
    expect(urlFor("fd7a:115c:a1e0::42", 47821)).toBe("http://[fd7a:115c:a1e0::42]:47821");
    expect(parseOptions(["--local", "--tailnet"], {}).tailnet).toBe(true);
    expect(parseOptions(["--local"], { BASED_TAILNET: "1" }).tailnet).toBe(true);
    expect(() => parseOptions(["--token", "x".repeat(20), "--tailnet"], {})).toThrow(/only works with --local/);
  });

  it("Geräte-Token: anlegen nur mit Haupt-Token, gilt dann wie der Besitzer, widerrufbar", async () => {
    const app = await startApp();
    apps.push(app);
    const r = await call(`${app.url}/devices`, TOKEN, "POST", { name: "Elija's iPhone" });
    expect(r.status).toBe(201);
    const { device, token } = (await r.json()) as { device: { id: string; name: string }; token: string };
    expect(token).toMatch(/^bdo_/);
    expect(device.name).toBe("Elija's iPhone");
    // gilt für Owner-Routen
    expect((await call(`${app.url}/sync/v2/info`, token)).status).toBe(200);
    const listed = (await (await call(`${app.url}/devices`, token)).json()) as { devices: { id: string; lastSeenAt?: number }[]; current: string };
    expect(listed.current).toBe(device.id);
    expect(listed.devices.map((d) => d.id)).toEqual([device.id]);
    // darf keine Geräte verwalten
    expect((await call(`${app.url}/devices`, token, "POST", { name: "x" })).status).toBe(403);
    expect((await call(`${app.url}/devices/${device.id}`, token, "DELETE")).status).toBe(403);
    // widerrufen → 401
    expect((await call(`${app.url}/devices/${device.id}`, TOKEN, "DELETE")).status).toBe(200);
    expect((await call(`${app.url}/sync/v2/info`, token)).status).toBe(401);
    expect((await call(`${app.url}/devices/${device.id}`, TOKEN, "DELETE")).status).toBe(404);
    expect((await call(`${app.url}/sync/v2/info`, "bdo_wrong")).status).toBe(401);
  });

  it("listenAlso: dieselben Routen auf einer zweiten Adresse, schließt mit der App", async () => {
    const app = await startApp();
    apps.push(app);
    await app.listenAlso(app.port, "127.0.0.2");
    const r = await fetch(`http://127.0.0.2:${app.port}/health`);
    expect(r.status).toBe(200);
    // WebSocket-Upgrades auch dort (unbekannter Pfad wird geschlossen, nicht hängen gelassen)
    const ws = new WebSocket(`ws://127.0.0.2:${app.port}/nope`);
    await new Promise<void>((res) => { ws.on("error", () => res()); ws.on("close", () => res()); });
  });
});

describe("OwnerDevices", () => {
  it("speichert nur den Hash", async () => {
    const { openNodeDatabase } = await import("@based/sync/node");
    const { OwnerDevices } = await import("../src/devices.js");
    const db = openNodeDatabase(":memory:");
    const d = new OwnerDevices(db);
    const { token } = d.add("  ");
    const rows = JSON.stringify(db.all("SELECT * FROM owner_devices"));
    expect(rows).not.toContain(token.slice(4));
    expect(d.list()[0]!.name).toBe("Device");
    expect(d.check(token)).toBeDefined();
    expect(d.check("bdo_x")).toBeUndefined();
  });
});
