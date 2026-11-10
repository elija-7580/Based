// Server-Sent Events, inkrementell (Swift `SSEParser`, BasedBrain/AI/Streaming.swift). Arbeitet auf Bytes: Stücke
// dürfen überall getrennt sein – mitten in einer Zeile, in „\r\n“ oder in einem Mehrbyte-Zeichen. Kommentare
// („: ping“) werden übersprungen; ein Ereignis endet an einer Leerzeile.

export interface SSEEvent {
  event?: string;
  data: string;
}

export class SSEParser {
  private buffer = new Uint8Array(0);
  private event: string | undefined;
  private data: string[] = [];
  private readonly decoder = new TextDecoder();

  feed(chunk: Uint8Array): SSEEvent[] {
    const joined = new Uint8Array(this.buffer.length + chunk.length);
    joined.set(this.buffer);
    joined.set(chunk, this.buffer.length);
    const out: SSEEvent[] = [];
    let start = 0;
    for (let nl = joined.indexOf(0x0a, start); nl >= 0; nl = joined.indexOf(0x0a, start)) {
      let end = nl;
      if (end > start && joined[end - 1] === 0x0d) end -= 1;
      const e = this.take(this.decoder.decode(joined.subarray(start, end)));
      if (e) out.push(e);
      start = nl + 1;
    }
    this.buffer = joined.slice(start);
    return out;
  }

  /** Ende des Stroms: ein nicht abgeschlossenes letztes Ereignis zählt trotzdem. */
  finish(): SSEEvent[] {
    const out = this.feed(new Uint8Array([0x0a]));
    const e = this.take("");
    if (e) out.push(e);
    return out;
  }

  private take(line: string): SSEEvent | undefined {
    if (line === "") {
      const event = this.event, data = this.data;
      this.event = undefined;
      this.data = [];
      if (data.length === 0 && event === undefined) return undefined;
      return event === undefined ? { data: data.join("\n") } : { event, data: data.join("\n") };
    }
    if (line.startsWith(":")) return undefined;
    const c = line.indexOf(":");
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? "" : line.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }
}
