// Builds GBK/GB18030 byte sequences *without* hard-coded hex tables.
//
// Node's TextDecoder ships the real GB18030 mapping, so the inverse is built by
// scanning every two-byte code the standard assigns and decoding it back. The
// result is exact, not a hand-copied approximation — the first version of this
// fixture had 用 as b8e6 (it is b8e9) and the test caught it.

let table: Map<string, number[]> | null = null;

function buildTable(): Map<string, number[]> {
  const decoder = new TextDecoder("gb18030", { fatal: true });
  const map = new Map<string, number[]>();
  // GBK double-byte range: lead 0x81–0xFE, trail 0x40–0xFE (0x7F excluded).
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      try {
        const ch = decoder.decode(Uint8Array.from([lead, trail]));
        if (ch.length === 1 && !map.has(ch)) map.set(ch, [lead, trail]);
      } catch {
        // Unassigned code point.
      }
    }
  }
  return map;
}

/** GBK bytes for a string, or throws if a character has no GBK encoding. */
export function gbkEncode(text: string): number[] {
  table ??= buildTable();
  const out: number[] = [];
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) {
      out.push(ch.charCodeAt(0));
      continue;
    }
    const bytes = table.get(ch);
    if (!bytes) throw new Error(`"${ch}" is not encodable in GBK`);
    out.push(...bytes);
  }
  return out;
}

/** UTF-8 bytes for a string. */
export function utf8Encode(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}
