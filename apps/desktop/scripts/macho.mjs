// BSD-452: Mach-O-Helfer ohne Xcode – damit der Universal-Build eine universelle Node (arm64 + x86_64) bekommt und das
// auf jedem Rechner (auch Linux) gebaut und geprüft werden kann. Macht dasselbe wie `lipo -create` bzw. `lipo -info`:
//   thinArch(buf)       Architektur einer einfachen 64-Bit-Mach-O-Datei (cputype/cpusubtype aus dem Kopf)
//   makeFat(slices)     universelle Datei (fat header, Big Endian; Slices an 2^14 für arm64, 2^12 für x86_64)
//   fatArchs(buf)       Slices einer universellen Datei bzw. die eine Architektur einer einfachen
// Signiert wird danach die universelle Datei (codesign signiert jede Slice, BSD-433).
const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
export const CPU_TYPE_X86_64 = 0x01000007;
export const CPU_TYPE_ARM64 = 0x0100000c;
const NAMES = { [CPU_TYPE_X86_64]: "x86_64", [CPU_TYPE_ARM64]: "arm64" };
const ALIGN = { [CPU_TYPE_X86_64]: 12, [CPU_TYPE_ARM64]: 14 };

export const archName = (cputype) => NAMES[cputype] ?? `cputype ${cputype}`;

/** Kopf einer einfachen 64-Bit-Mach-O-Datei (Little Endian, wie auf allen heutigen Macs); sonst `undefined`. */
export function thinArch(buf) {
  if (buf.length < 32 || buf.readUInt32LE(0) !== MH_MAGIC_64) return undefined;
  const cputype = buf.readInt32LE(4);
  const cpusubtype = buf.readInt32LE(8);
  return { cputype, cpusubtype, name: archName(cputype) };
}

/** Universelle Datei aus einfachen Mach-O-Dateien (jede Architektur höchstens einmal). */
export function makeFat(slices) {
  const archs = slices.map((data) => {
    const a = thinArch(data);
    if (!a) throw new Error("not a 64-bit Mach-O file");
    return { ...a, data, align: ALIGN[a.cputype] ?? 14 };
  });
  if (new Set(archs.map((a) => a.cputype)).size !== archs.length) throw new Error("duplicate architecture");
  // wie lipo: kleinere Ausrichtung zuerst (x86_64 vor arm64)
  archs.sort((a, b) => a.align - b.align || a.cputype - b.cputype);
  const header = 8 + 20 * archs.length;
  let offset = header;
  const placed = archs.map((a) => {
    const step = 2 ** a.align;
    offset = Math.ceil(offset / step) * step;
    const at = offset;
    offset += a.data.length;
    return { ...a, offset: at };
  });
  const out = Buffer.alloc(offset);
  out.writeUInt32BE(FAT_MAGIC, 0);
  out.writeUInt32BE(placed.length, 4);
  placed.forEach((a, i) => {
    const o = 8 + 20 * i;
    out.writeInt32BE(a.cputype, o);
    out.writeInt32BE(a.cpusubtype, o + 4);
    out.writeUInt32BE(a.offset, o + 8);
    out.writeUInt32BE(a.data.length, o + 12);
    out.writeUInt32BE(a.align, o + 16);
    Buffer.from(a.data.buffer, a.data.byteOffset, a.data.length).copy(out, a.offset);
  });
  return out;
}

/** Architekturen einer Datei (`lipo -info`): universell → alle Slices, einfach → eine, sonst leer. */
export function fatArchs(buf) {
  if (buf.length >= 8 && buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    const out = [];
    for (let i = 0; i < n; i++) {
      const o = 8 + 20 * i;
      const cputype = buf.readInt32BE(o);
      const offset = buf.readUInt32BE(o + 8), size = buf.readUInt32BE(o + 12);
      const inner = thinArch(buf.subarray(offset, offset + size));
      // die Slice muss zu ihrem Eintrag passen
      out.push({ cputype, cpusubtype: buf.readInt32BE(o + 4), offset, size, align: buf.readUInt32BE(o + 16), name: archName(cputype), valid: inner?.cputype === cputype && offset + size <= buf.length });
    }
    return out;
  }
  const thin = thinArch(buf);
  return thin ? [{ ...thin, offset: 0, size: buf.length, align: 0, valid: true }] : [];
}
