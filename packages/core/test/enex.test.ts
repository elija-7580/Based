// BSD-260 Teil 2: Evernote ENEX – MD5 (RFC-1321-Testvektoren), Datum, Notizbuch als Datenbank (Tags, Created,
// Updated, Source, Author), ENML: Bilder/PDF per Hash, alte und neue To-dos, Verschlüsseltes, nicht gezeigte Anhänge.
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { enexDate, enmlToHTML, ImportFiles, importNotionItems, md5Hex, MemoryAssetSink, MemoryPersistence, parseEnex, plainText, WorkspaceStore, type Block } from "../src/index.js";

const enc = new TextEncoder();
const store = () => new WorkspaceStore({ persistence: new MemoryPersistence(), node: "t" });
const b64 = (s: string) => Buffer.from(s).toString("base64");

const PNG = "fake-png-bytes";
const PDF = "%PDF-1.4 fake";
const ZIPPED = "zip-bytes";

const ENEX = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">
<en-export export-date="20240102T030405Z" application="Evernote" version="10.0">
  <note>
    <title>Trip &amp; plans</title>
    <created>20230115T093000Z</created>
    <updated>20230116T101500Z</updated>
    <tag>travel</tag>
    <tag>Lisbon</tag>
    <note-attributes><author>Elija</author><source-url>https://example.com/lisbon</source-url></note-attributes>
    <content><![CDATA[<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd">
<en-note><div><b>Pack</b> list</div>
<div><en-todo checked="true"/>Passport</div>
<div><en-todo checked="false"/>Sunscreen</div>
<ul style="--en-todo:true;"><li style="--en-checked:true;"><div>Tickets</div></li><li style="--en-checked:false;"><div>Hotel</div></li></ul>
<en-media hash="${md5Hex(enc.encode(PNG))}" type="image/png"/>
<en-media hash="${md5Hex(enc.encode(PDF))}" type="application/pdf"></en-media>
<en-crypt cipher="AES">secret</en-crypt>
</en-note>]]></content>
    <resource><data encoding="base64">${b64(PNG)}</data><mime>image/png</mime><resource-attributes><file-name>map.png</file-name></resource-attributes></resource>
    <resource><data encoding="base64">${b64(PDF)}</data><mime>application/pdf</mime><resource-attributes><file-name>tickets.pdf</file-name></resource-attributes></resource>
    <resource><data encoding="base64">${b64(ZIPPED)}</data><mime>application/zip</mime><resource-attributes><file-name>extra.zip</file-name></resource-attributes></resource>
  </note>
  <note>
    <title>Second</title>
    <content>&lt;en-note&gt;&lt;p&gt;Escaped content&lt;/p&gt;&lt;/en-note&gt;</content>
    <tag>travel</tag>
  </note>
</en-export>`;

const kids = (s: WorkspaceStore, parent: string): Block[] => s.children(parent).map((id) => s.blocks.get(id)!);

describe("Evernote ENEX", () => {
  it("MD5 nach RFC 1321", () => {
    expect(md5Hex(enc.encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5Hex(enc.encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5Hex(enc.encode("message digest"))).toBe("f96b697d7cb7938d525a2f31aaf161d0");
    expect(md5Hex(enc.encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890"))).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("Datum und Notizen lesen", () => {
    expect(enexDate("20010101T000000Z")).toBe(0);
    expect(enexDate("bad")).toBeUndefined();
    const notes = parseEnex(ENEX);
    expect(notes.map((n) => n.title)).toEqual(["Trip & plans", "Second"]);
    expect(notes[0]!.tags).toEqual(["travel", "Lisbon"]);
    expect(notes[0]!.resources.map((r) => r.name)).toEqual(["map.png", "tickets.pdf", "extra.zip"]);
    expect(notes[1]!.content).toContain("<p>Escaped content</p>");
    expect(enmlToHTML('<en-note><div><en-todo checked="true"/>A</div></en-note>')).toContain('<input type="checkbox" checked>A');
  });

  it("Notizbuch als Datenbank mit Inhalt, To-dos und Dateien", () => {
    const s = store();
    const assets = new MemoryAssetSink();
    const r = importNotionItems(s, [{ files: new ImportFiles([["Travel.enex", enc.encode(ENEX)]]), path: "Travel.enex" }], { assets });
    expect(r.databases).toBe(1);
    expect(r.rows).toBe(2);
    expect(r.assets).toBe(3);
    const dbBlock = s.blocks.get(r.rootIDs[0]!)!;
    expect(dbBlock.type).toBe("databasePage");
    const db = [...s.databases.values()].find((d) => d.blockID === dbBlock.id)!;
    expect(db.title).toBe("Travel");
    expect(db.properties.map((p) => [p.name, p.type])).toEqual([["Name", "title"], ["Tags", "multiSelect"], ["Created", "date"], ["Updated", "date"], ["Source", "url"], ["Author", "text"]]);
    const rows = kids(s, "d:" + db.id);
    expect(rows.map((b) => plainText(b.text))).toEqual(["Trip & plans", "Second"]);
    const trip = rows[0]!;
    const tags = db.properties[1]!;
    expect(tags.options!.map((o) => o.name)).toEqual(["travel", "Lisbon"]);
    expect(trip.values![tags.id]).toEqual({ multiSelect: { _0: tags.options!.map((o) => o.id) } });
    expect((trip.values![db.properties[2]!.id] as { date: { _0: { start: number } } }).date._0.start).toBe(enexDate("20230115T093000Z"));
    expect(trip.values![db.properties[4]!.id]).toEqual({ url: { _0: "https://example.com/lisbon" } });
    expect(trip.createdAt).toBe(enexDate("20230115T093000Z"));

    const body = kids(s, "b:" + trip.id);
    const todos = body.filter((b) => b.type === "todo");
    expect(todos.map((b) => [plainText(b.text), b.props?.checked])).toEqual([["Passport", true], ["Sunscreen", false], ["Tickets", true], ["Hotel", false]]);
    expect(body.find((b) => b.type === "image")!.props?.asset?.name).toBe("map.png");
    expect(body.find((b) => b.type === "pdf")!.props?.asset?.name).toBe("tickets.pdf");
    expect(body.at(-1)).toMatchObject({ type: "file", props: { asset: { name: "extra.zip" } } }); // nicht gezeigt → ans Ende
    expect(body.map((b) => plainText(b.text)).join("\n")).toContain("[encrypted content]");
    expect(kids(s, "b:" + rows[1]!.id).map((b) => plainText(b.text))).toEqual(["Escaped content"]);
  });

  it("ENEX-Dateien in einem ZIP", () => {
    const zip = zipSync({ "Evernote/Travel.enex": enc.encode(ENEX), "Evernote/Work.enex": enc.encode("<en-export><note><title>W</title><content></content></note></en-export>") });
    const s = store();
    const r = importNotionItems(s, [{ files: new ImportFiles([["export.zip", zip]]), path: "export.zip" }]);
    expect(kids(s, "w").map((b) => plainText(b.text))).toEqual(["Travel", "Work"]);
    expect(r.rows).toBe(3);
  });
});
