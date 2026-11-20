// ── Multi-QR segmentation protocol ───────────────────────────────────────────
//
// A payload that does not fit a single QR code is split into several QR codes.
// Every segment starts with a fixed 18-byte ASCII header:
//
//   offset  size  field
//   0..3     4    "QRS1" (magic + protocol version)
//   4..11    8    CRC32 of the *complete* UTF-8 content, 8 uppercase hex digits
//   12..14   3    segment index, 3 decimal digits (000..254)
//   15..17   3    segment total, 3 decimal digits (002..255)
//   18..     n    segment data (UTF-8 text)
//
// The CRC doubles as the transfer id: all segments of one content share it, so
// segments from different generations can never be mixed silently. The index is
// authoritative for ordering; spatial position and paste order are irrelevant.
//
// Header bytes are pure ASCII, which matters because qrcode-generator encodes
// every payload string as UTF-8. The data chunk is a slice of the original text,
// so its UTF-8 bytes follow the header unchanged.
//
// The header costs 18 bytes, leaving 2,313 data bytes in a version-40 level-M
// QR (2,331 bytes total). With 1-byte index/total fields encoded as 3 decimal
// digits, a transfer is capped at 255 segments / 589,815 bytes.

export const QR_MAX_BYTES = 2331;
export const SEGMENT_MAGIC = "QRS1";
export const SEGMENT_HEADER_BYTES = 18;
export const SEGMENT_DATA_BYTES = QR_MAX_BYTES - SEGMENT_HEADER_BYTES;
export const MAX_SEGMENTS = 255;
export const MAX_CONTENT_BYTES = SEGMENT_DATA_BYTES * MAX_SEGMENTS;

export interface ParsedSegment {
  crc: number;
  index: number;
  total: number;
  data: Uint8Array;
}

export type QRPlan =
  | { kind: "empty" }
  | { kind: "single"; content: string; totalBytes: number }
  | { kind: "sheet"; chunks: string[]; totalBytes: number; crc: number }
  | { kind: "error"; message: string; totalBytes: number };

export type Reassembly =
  | { ok: true; text: string; bytes: Uint8Array; crc: number; total: number }
  | {
      ok: false;
      reason: "missing" | "inconsistent" | "crc" | "encoding";
      /** 0-based indices that were not received, when reason === "missing". */
      missing?: number[];
    };

// ── CRC32 (IEEE 802.3, reflected polynomial 0xEDB88320) ──────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// ── Text handling ────────────────────────────────────────────────────────────
//
// qrcode-generator's UTF-8 encoder treats lone surrogates differently from
// TextEncoder (it consumes the following code unit), so both the byte count and
// the splitter could disagree with what is actually drawn. Normalising to
// well-formed Unicode first makes the two encoders agree; invalid lone
// surrogates become U+FFFD.

export function toWellFormed(text: string): string {
  const native = (text as unknown as { toWellFormed?: () => string }).toWellFormed;
  if (typeof native === "function") return native.call(text);

  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += text[i] + text[i + 1];
        i++;
      } else {
        out += "�";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      out += "�";
    } else {
      out += text[i];
    }
  }
  return out;
}

function utf8LengthOfCodePoint(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

/**
 * Packs code points into chunks of at most `target` UTF-8 bytes. A code point
 * is never split, so chunks are independently valid UTF-8 and re-encoding each
 * chunk reproduces the original bytes.
 */
function packChunks(points: string[], lengths: number[], target: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;

  for (let i = 0; i < points.length; i++) {
    const length = lengths[i];
    if (currentBytes + length > target && current.length > 0) {
      chunks.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(points[i]);
    currentBytes += length;
  }
  if (current.length > 0) chunks.push(current.join(""));
  return chunks;
}

/** Splits a well-formed string into chunks that each fit in a segment. */
function splitChunks(text: string, totalBytes: number): string[] | null {
  const minSegments = Math.ceil(totalBytes / SEGMENT_DATA_BYTES);
  if (minSegments > MAX_SEGMENTS) return null;

  const points = Array.from(text);
  const lengths = points.map((ch) => utf8LengthOfCodePoint(ch.codePointAt(0)!));

  // Prefer balanced chunks, but keep every chunk within the hard byte limit.
  // Code-point boundaries can produce an extra chunk right at a boundary; bump
  // the target until the count is acceptable (or we hit the per-QR limit).
  let target = Math.ceil(totalBytes / minSegments);
  let chunks = packChunks(points, lengths, target);
  while (chunks.length > MAX_SEGMENTS && target < SEGMENT_DATA_BYTES) {
    target++;
    chunks = packChunks(points, lengths, target);
  }
  return chunks.length <= MAX_SEGMENTS ? chunks : null;
}

/**
 * Pure planning step shared by rendering and tests. Returns the normalised
 * single-QR content, the segmented chunks, an empty plan, or an error.
 */
export function createQRPlan(raw: string): QRPlan {
  if (!raw.trim()) return { kind: "empty" };

  const text = toWellFormed(raw);
  const bytes = new TextEncoder().encode(text);

  if (bytes.length <= QR_MAX_BYTES) {
    return { kind: "single", content: text, totalBytes: bytes.length };
  }

  if (bytes.length > MAX_CONTENT_BYTES) {
    return {
      kind: "error",
      message: `Content exceeds the multi-code limit (${MAX_CONTENT_BYTES} bytes)`,
      totalBytes: bytes.length,
    };
  }

  const chunks = splitChunks(text, bytes.length);
  if (!chunks) {
    return {
      kind: "error",
      message: `Content exceeds the multi-code limit (${MAX_CONTENT_BYTES} bytes)`,
      totalBytes: bytes.length,
    };
  }

  return { kind: "sheet", chunks, totalBytes: bytes.length, crc: crc32(bytes) };
}

// ── Segment envelope ─────────────────────────────────────────────────────────

function crcHex(crc: number): string {
  return (crc >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

export function encodeSegment(
  chunk: string,
  index: number,
  total: number,
  crc: number
): string {
  if (total < 2 || total > MAX_SEGMENTS) {
    throw new Error(`Invalid segment total: ${total}`);
  }
  if (index < 0 || index >= total) {
    throw new Error(`Invalid segment index: ${index}`);
  }
  const payload = SEGMENT_MAGIC + crcHex(crc) + String(index).padStart(3, "0") + String(total).padStart(3, "0") + chunk;
  if (new TextEncoder().encode(payload).length > QR_MAX_BYTES) {
    throw new Error("Segment exceeds a single QR code");
  }
  return payload;
}

export function parseSegment(bytes: Uint8Array | ArrayLike<number>): ParsedSegment | null {
  const raw = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  if (raw.length <= SEGMENT_HEADER_BYTES) return null;

  let header = "";
  for (let i = 0; i < SEGMENT_HEADER_BYTES; i++) {
    // The header is ASCII by construction; reject any stray high byte.
    if (raw[i] > 0x7f) return null;
    header += String.fromCharCode(raw[i]);
  }

  if (!header.startsWith(SEGMENT_MAGIC)) return null;

  const crcPart = header.slice(4, 12);
  const indexPart = header.slice(12, 15);
  const totalPart = header.slice(15, 18);
  if (!/^[0-9A-F]{8}$/.test(crcPart)) return null;
  if (!/^\d{3}$/.test(indexPart) || !/^\d{3}$/.test(totalPart)) return null;

  const crc = parseInt(crcPart, 16) >>> 0;
  const index = Number(indexPart);
  const total = Number(totalPart);
  if (total < 2 || total > MAX_SEGMENTS) return null;
  if (index >= total) return null;

  return { crc, index, total, data: raw.slice(SEGMENT_HEADER_BYTES) };
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Reassembles a set of segments. Order of the input array does not matter;
 * duplicate indices are tolerated only when their bytes are identical.
 */
export function reassembleSegments(segments: ParsedSegment[]): Reassembly {
  if (segments.length === 0) return { ok: false, reason: "missing", missing: [] };

  const { crc, total } = segments[0];
  const parts = new Map<number, Uint8Array>();

  for (const segment of segments) {
    if (segment.crc !== crc || segment.total !== total) {
      return { ok: false, reason: "inconsistent" };
    }
    const existing = parts.get(segment.index);
    if (existing) {
      if (!equalBytes(existing, segment.data)) return { ok: false, reason: "inconsistent" };
      continue;
    }
    parts.set(segment.index, segment.data);
  }

  const missing: number[] = [];
  for (let i = 0; i < total; i++) if (!parts.has(i)) missing.push(i);
  if (missing.length > 0) return { ok: false, reason: "missing", missing };

  let length = 0;
  for (const part of parts.values()) length += part.length;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < total; i++) {
    const part = parts.get(i)!;
    bytes.set(part, offset);
    offset += part.length;
  }

  if (crc32(bytes) !== crc) return { ok: false, reason: "crc" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "encoding" };
  }

  return { ok: true, text, bytes, crc, total };
}
