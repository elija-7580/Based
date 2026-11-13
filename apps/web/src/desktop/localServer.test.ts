// BSD-138: reine Teile (Node-Suche, Ergebnis-Zeilen, Umgebung, Token) – ohne Tauri.
import { describe, expect, it } from "vitest";
import { actionEnv, folderSyncEnv, ICLOUD_FOLDER, localServer, newToken, pairingLink, parseNodeProbe, parsePairingLink, parseReady, parseResult, PROBE, RUN } from "./localServer.js";

describe("lokaler Server und CLI (Desktop)", () => {
  it("Node suchen: gefunden, zu alt, fehlt", () => {
    expect(parseNodeProbe("/opt/homebrew/bin/node\nv22.11.0\n", 0)).toMatchObject({ ok: true, path: "/opt/homebrew/bin/node", version: "v22.11.0" });
    expect(parseNodeProbe("motd\n/usr/local/bin/node\nv18.19.0\n", 0)).toMatchObject({ ok: false, message: expect.stringContaining("too old") });
    expect(parseNodeProbe("", 1)).toMatchObject({ ok: false, message: expect.stringContaining("wasn't found") });
    expect(parseNodeProbe("", 1).message).toContain("brew install node");
  });

  it("BSD-334: iCloud-Ordner nur, wenn eingeschaltet und mit gültiger Gerätekennung", () => {
    expect(folderSyncEnv("/Users/e", true, "mac-1a2b3c4d")).toEqual({ BASED_FOLDER_SYNC: `/Users/e/${ICLOUD_FOLDER}`, BASED_FOLDER_DEVICE: "mac-1a2b3c4d" });
    expect(ICLOUD_FOLDER).toBe("Library/Mobile Documents/com~apple~CloudDocs/Based");
    expect(folderSyncEnv("/Users/e/", true, "mac-1")).toMatchObject({ BASED_FOLDER_SYNC: `/Users/e/${ICLOUD_FOLDER}` });
    expect(folderSyncEnv("/Users/e", false, "mac-1")).toEqual({});
    expect(folderSyncEnv("/Users/e", true, undefined)).toEqual({});
    expect(folderSyncEnv("/Users/e", true, "../x")).toEqual({});
  });

  it("feste Aufrufe, Umgebung nur mit BASED_*, kein Token in Argumenten", () => {
    expect(PROBE.args).toEqual(["-ilc", "command -v node && node --version"]);
    expect(RUN.args).toEqual(["-ilc", 'exec node "$BASED_BUNDLE" desktop']);
    const env = actionEnv("/App/Resources/based-server.cjs", "local", { BASED_TOKEN: "t" });
    expect(Object.keys(env).every((k) => k.startsWith("BASED_"))).toBe(true);
    expect(RUN.args.join(" ")).not.toContain("TOKEN");
  });

  it("Ergebnis- und Bereit-Zeilen", () => {
    expect(parseResult('noise\nBASED_RESULT {"ok":true,"target":"/h/.local/bin/based","inPath":false}\n')).toEqual({ ok: true, target: "/h/.local/bin/based", inPath: false });
    expect(parseResult("nothing")).toBeUndefined();
    expect(parseReady('BASED_LOCAL_READY {"url":"http://127.0.0.1:47821","pid":7}\n')).toEqual({ url: "http://127.0.0.1:47821", pid: 7 });
    expect(parseReady('BASED_LOCAL_READY {"url":"http://evil.example:1","pid":7}')).toBeUndefined();
  });

  it("Token: 32 Byte base64url", () => {
    expect(newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("im Browser: nicht verfügbar, nichts startet", async () => {
    expect(localServer().getState().status).toBe("unavailable");
    await localServer().start();
    expect(await localServer().probeNode()).toBeUndefined();
    expect(localServer().getState().status).toBe("unavailable");
  });
});

describe("Tailnet (BSD-315)", () => {
  it("READY-Zeile: nur Tailscale-Adressen werden übernommen", () => {
    expect(parseReady('BASED_LOCAL_READY {"url":"http://127.0.0.1:47821","pid":7,"tailnet":["http://100.101.102.103:47821","http://[fd7a:115c:a1e0::42]:47821","http://192.168.1.5:47821","http://100.128.0.1:47821"]}'))
      .toEqual({ url: "http://127.0.0.1:47821", pid: 7, tailnet: ["http://100.101.102.103:47821", "http://[fd7a:115c:a1e0::42]:47821"] });
    expect(parseReady('BASED_LOCAL_READY {"url":"http://127.0.0.1:47821","pid":7,"tailnet":[]}')).toEqual({ url: "http://127.0.0.1:47821", pid: 7, tailnet: [] });
  });
  it("Kopplungs-Link hin und zurück; nur Geräte-Token", () => {
    const link = pairingLink("http://100.101.102.103:47821", "bdo_abc");
    expect(link).toBe("based://pair?url=http%3A%2F%2F100.101.102.103%3A47821&token=bdo_abc");
    expect(parsePairingLink(link)).toEqual({ url: "http://100.101.102.103:47821", token: "bdo_abc" });
    expect(parsePairingLink(pairingLink("http://x:1", "main-token"))).toBeUndefined();
    expect(parsePairingLink("https://evil/pair?url=x")).toBeUndefined();
  });
});
