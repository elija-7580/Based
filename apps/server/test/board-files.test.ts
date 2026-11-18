// Dateien für Agenten: Links laden (http/https, Weiterleitungen geprüft, nie ins eigene Netz) und PDFs genau vermessen.
import { createServer, type Server } from "node:http";
import type { LookupFunction } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchRemote, isPrivateAddress, pdfPageSizes } from "../src/board-files.js";

let servers: Server[] = [];
afterEach(async () => { for (const s of servers) await new Promise((r) => s.close(r)); servers = []; });

async function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}
// Testnamen zeigen auf den lokalen Testserver – nur hier, der echte Server lässt das eigene Netz nie zu.
const testLookup: LookupFunction = (host, options, cb) => {
  if (host.endsWith(".test")) return (options as { all?: boolean }).all ? (cb as unknown as (e: null, a: unknown[]) => void)(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4);
  cb(Object.assign(new Error("private address"), { code: "EPRIVATE" }), "", 4);
};

describe("fetchRemote", () => {
  it("folgt Weiterleitungen (auch relativ), lädt http, nimmt den Namen aus Content-Disposition", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/a") { res.writeHead(302, { location: `http://files.test:${port}/b` }); res.end(); }
      else if (req.url === "/b") { res.writeHead(301, { location: "/c" }); res.end(); }
      else { res.writeHead(200, { "content-type": "image/png; charset=binary", "content-disposition": 'attachment; filename="cat.png"' }); res.end("PNGDATA"); }
    });
    const r = await fetchRemote(`http://files.test:${port}/a`, 1000, 5000, testLookup);
    expect(r).toEqual({ bytes: Buffer.from("PNGDATA"), name: "cat.png", mime: "image/png" });
  });
  it("Weiterleitung ins eigene Netz, zu viele Weiterleitungen, zu groß, kein http(s): abgelehnt", async () => {
    const port = await serve((req, res) => {
      if (req.url === "/inner") { res.writeHead(302, { location: `http://127.0.0.1:${port}/secret` }); res.end(); }
      else if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); }
      else { res.writeHead(200); res.end("x".repeat(5000)); }
    });
    await expect(fetchRemote(`http://files.test:${port}/inner`, 1000, 5000, testLookup)).rejects.toThrow(/not reachable/);
    await expect(fetchRemote(`http://files.test:${port}/loop`, 1000, 5000, testLookup)).rejects.toThrow(/too many redirects/);
    await expect(fetchRemote(`http://files.test:${port}/big`, 1000, 5000, testLookup)).rejects.toThrow(/larger than/);
    await expect(fetchRemote("ftp://x.test/a", 1000)).rejects.toThrow(/only http and https/);
    // Ohne Test-Auflösung: localhost löst ins eigene Netz auf.
    await expect(fetchRemote(`http://localhost:${port}/x`, 1000)).rejects.toThrow(/not reachable/);
  });
  it("isPrivateAddress", () => {
    for (const ip of ["10.1.2.3", "127.0.0.1", "192.168.0.1", "172.20.0.1", "169.254.169.254", "100.100.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111", "172.32.0.1"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("pdfPageSizes", () => {
  it("jede Seite mit eigenem Maß, auch gedreht und in Objekt-Streams", async () => {
    // Drei Seiten: A4, eine gedrehte, ein Quadrat; Seitenbaum mit geerbter MediaBox.
    const objs = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /MediaBox [0 0 595 842] >>",
      "<< /Type /Page /Parent 2 0 R >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Rotate 90 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const xref = pdf.length;
    pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(await pdfPageSizes(new TextEncoder().encode(pdf))).toEqual([{ width: 595, height: 842 }, { width: 792, height: 612 }, { width: 300, height: 300 }]);
    expect(await pdfPageSizes(new TextEncoder().encode("not a pdf"))).toBeUndefined();
  });
});
