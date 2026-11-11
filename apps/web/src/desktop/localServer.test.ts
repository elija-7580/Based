// BSD-138: reine Teile der Beilage „lokaler Server“ (Argumente, Bereit-Zeile, Install-Befehl, Token).
import { describe, expect, it } from "vitest";
import { installCommand, LOCAL_SERVER_PORT, localServer, newToken, parseReady, sidecarArgs, sidecarPathFor } from "./localServer.js";

describe("lokaler Server (Desktop-Beilage)", () => {
  it("Argumente: --local, fester Port, Datenbank, Coding-Ordner; kein Token", () => {
    const a = sidecarArgs({ db: "/d/local-server.sqlite", home: "/Users/e" });
    expect(a).toEqual(["--local", "--port", String(LOCAL_SERVER_PORT), "--db", "/d/local-server.sqlite", "--coding-root", "/Users/e"]);
    expect(a.join(" ")).not.toMatch(/token/i);
  });

  it("Bereit-Zeile nur mit Loopback-Adresse", () => {
    expect(parseReady('BASED_LOCAL_READY {"url":"http://127.0.0.1:47821","pid":7}\n')).toEqual({ url: "http://127.0.0.1:47821", pid: 7 });
    expect(parseReady('BASED_LOCAL_READY {"url":"http://evil.example:1","pid":7}')).toBeUndefined();
    expect(parseReady("BASED_LOCAL_READY {")).toBeUndefined();
    expect(parseReady('{"t":"…","message":"based-server listening"}')).toBeUndefined();
  });

  it("Install-Befehl: Symlink auf die Beilage, Pfad sicher zitiert", () => {
    const p = sidecarPathFor("/Applications/Based Next.app/Contents/Resources");
    expect(p).toBe("/Applications/Based Next.app/Contents/MacOS/based-server");
    expect(installCommand(p)).toBe("sudo ln -sf '/Applications/Based Next.app/Contents/MacOS/based-server' /usr/local/bin/based");
    expect(installCommand("/a/it's/x")).toBe("sudo ln -sf '/a/it'\\''s/x' /usr/local/bin/based");
  });

  it("Token: 32 Byte base64url", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
  });

  it("im Browser: nicht verfügbar, Start tut nichts", async () => {
    expect(localServer().getState().status).toBe("unavailable");
    await localServer().start();
    expect(localServer().getState().status).toBe("unavailable");
    expect(await localServer().cliInstall()).toBeUndefined();
  });
});
