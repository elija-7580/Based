import { describe, expect, it } from "vitest";
import { fetchServerRuns, scheduleHint } from "./serverRuns.js";

describe("Zeitpläne bei geschlossener App (BSD-243 Teil 3b)", () => {
  it("liest agents.runsOnServer; ohne Server oder bei Fehlern: nur bei offener App", async () => {
    const reply = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    expect(await fetchServerRuns(undefined)).toBe("none");
    expect(await fetchServerRuns({ url: "https://s", token: "t" }, reply({ agents: { runsOnServer: true } }))).toBe("server");
    expect(await fetchServerRuns({ url: "https://s", token: "t" }, reply({ agents: { runsOnServer: false } }))).toBe("app-only");
    expect(await fetchServerRuns({ url: "https://s", token: "t" }, reply({}, 401))).toBe("none");
    expect(await fetchServerRuns({ url: "https://s", token: "t" }, (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch)).toBe("none");
    expect(scheduleHint("server")).toContain("also start when Based is closed");
    expect(scheduleHint("app-only")).toContain("BASED_ANTHROPIC_API_KEY");
    expect(scheduleHint(undefined)).toBe("Scheduled runs start while Based is open in this browser or app.");
  });
});
