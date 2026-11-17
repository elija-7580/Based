// BSD-138: reine Teile (Node-Suche, Ergebnis-Zeilen, Umgebung, Token) – ohne Tauri.
import { describe, expect, it } from "vitest";
import { actionEnv, channelServerEnv, BUNDLED_PROBE, BUNDLED_RUN, chooseNode, failureLine, folderSyncEnv, ICLOUD_FOLDER, localServer, parseFailed, newToken, pairingLink, parseNodeProbe, parsePairingLink, parseReady, parseResult, PROBE, RUN } from "./localServer.js";

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

  it("BSD-455: Umgebung pro Kanal – Beta mit eigenem Port, Besitzer, Backup- und iCloud-Ordner", () => {
    expect(channelServerEnv("/Users/e/Documents", "next")).toEqual({ BASED_PORT: "47821", BASED_LOCAL_OWNER: "Based Next", BASED_CHANNEL: "next", BASED_BACKUP_DIR: "/Users/e/Documents/Based Backups" });
    expect(channelServerEnv("/Users/e/Documents/", "beta")).toEqual({ BASED_PORT: "47822", BASED_LOCAL_OWNER: "Based Beta", BASED_CHANNEL: "beta", BASED_BACKUP_DIR: "/Users/e/Documents/Based Beta Backups" });
    expect(folderSyncEnv("/Users/e", true, "mac-1", "beta").BASED_FOLDER_SYNC).toBe("/Users/e/Library/Mobile Documents/com~apple~CloudDocs/Based Beta");
    expect(actionEnv("/b.cjs", "install-cli", {}, "beta")).toMatchObject({ BASED_CHANNEL: "beta" });
    // Tests/Entwicklung: Based Next
    expect(actionEnv("/b.cjs", "cli-status")).toMatchObject({ BASED_CHANNEL: "next" });
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

  it("BSD-424: Fehlerzeile statt „Node.js v26“ (Absturz mit Stacktrace) und BASED_LOCAL_FAILED", () => {
    const crash = [
      "node:events:486\n      throw er; // Unhandled 'error' event\n      ^\n",
      "Error: listen EADDRINUSE: address already in use 127.0.0.1:47821\n    at Server.setupListenHandle [as _listen2] (node:net:1940:16)\n    at listenInCluster (node:net:1997:12)\n",
      "{\n  code: 'EADDRINUSE',\n  errno: -48,\n  syscall: 'listen',\n  address: '127.0.0.1',\n  port: 47821\n}\n",
      "\nNode.js v26.13.0\n",
    ];
    expect(failureLine(crash)).toBe("Error: listen EADDRINUSE: address already in use 127.0.0.1:47821");
    expect(failureLine(["some warning", "Node.js v26.13.0"])).toBe("some warning");
    expect(failureLine(["based-server: Port 47821 is already in use by another program", "Node.js v26.13.0"])).toContain("Port 47821");
    expect(failureLine([])).toBe("");
    expect(parseFailed('BASED_LOCAL_FAILED {"message":"Port 47821 is already in use","code":"EADDRINUSE"}\n')).toBe("Port 47821 is already in use");
    expect(parseFailed("BASED_LOCAL_READY {}")).toBeUndefined();
    expect(parseFailed("BASED_LOCAL_FAILED {kaputt")).toBeUndefined();
  });

  it("BSD-414: mitgelieferte Node vor der Login-Shell, Rückfall ohne sie", async () => {
    expect(BUNDLED_PROBE.args).toEqual(["-c", `printf '%s\\n' "$BASED_NODE" && exec "$BASED_NODE" --version`]);
    expect(BUNDLED_RUN.args).toEqual(["-ilc", 'exec "$BASED_NODE" "$BASED_BUNDLE" desktop']);
    expect(BUNDLED_RUN.args.join(" ")).not.toContain("TOKEN");
    let asked = 0;
    const shell = async () => { asked += 1; return parseNodeProbe("/opt/homebrew/bin/node\nv26.13.0\n", 0); };
    const built = parseNodeProbe("/Applications/Based Next.app/Contents/Resources/node/bin/node\nv24.22.2\n", 0);
    expect(await chooseNode(built, shell)).toMatchObject({ ok: true, bundled: true, version: "v24.22.2", message: "Node.js v24.22.2 (built in)" });
    expect(asked).toBe(0);
    // fehlt (Entwickler-Build ohne Netz) oder scheitert: Login-Shell
    expect(await chooseNode(undefined, shell)).toMatchObject({ ok: true, path: "/opt/homebrew/bin/node" });
    expect(await chooseNode(parseNodeProbe("", 127), shell)).toMatchObject({ ok: true, path: "/opt/homebrew/bin/node" });
    expect(asked).toBe(2);
    // BSD-452: Rückfall sichtbar (Einstellungen zeigen die Meldung, wenn nicht die eingebaute läuft)
    expect((await chooseNode(undefined, shell)).message).toContain("uses the one installed on this Mac");
    expect((await chooseNode(undefined, shell)).bundled).toBeUndefined();
    expect(await chooseNode(undefined, async () => parseNodeProbe("", 1))).toMatchObject({ ok: false, message: expect.stringContaining("wasn't found") });
  });
});
