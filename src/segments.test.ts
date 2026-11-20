import { describe, expect, it } from "vitest";
import {
  MAX_CONTENT_BYTES,
  MAX_SEGMENTS,
  QR_MAX_BYTES,
  SEGMENT_DATA_BYTES,
  SEGMENT_HEADER_BYTES,
  createQRPlan,
  crc32,
  encodeSegment,
  parseSegment,
  reassembleSegments,
  toWellFormed,
  type ParsedSegment,
} from "./segments";

const encoder = new TextEncoder();

function segmentsFor(text: string): { segments: ParsedSegment[]; crc: number; total: number } {
  const plan = createQRPlan(text);
  if (plan.kind !== "sheet") throw new Error(`expected sheet, got ${plan.kind}`);
  const segments = plan.chunks.map((chunk, index) => {
    const payload = encodeSegment(chunk, index, plan.chunks.length, plan.crc);
    const parsed = parseSegment(encoder.encode(payload));
    if (!parsed) throw new Error(`segment ${index} did not parse`);
    return parsed;
  });
  return { segments, crc: plan.crc, total: plan.chunks.length };
}

describe("crc32", () => {
  it("matches the canonical check vector", () => {
    expect(crc32(encoder.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("toWellFormed", () => {
  it("replaces lone surrogates but preserves valid pairs", () => {
    expect(toWellFormed("a\uD800b")).toBe("a�b");
    expect(toWellFormed("a\uDC00b")).toBe("a�b");
    expect(toWellFormed("😀")).toBe("😀");
  });
});

describe("createQRPlan", () => {
  it("treats empty and whitespace-only text as empty", () => {
    expect(createQRPlan("").kind).toBe("empty");
    expect(createQRPlan("  \n\t ").kind).toBe("empty");
  });

  it("uses a single QR exactly up to the version-40 M capacity", () => {
    expect(createQRPlan("a".repeat(QR_MAX_BYTES))).toMatchObject({
      kind: "single",
      totalBytes: QR_MAX_BYTES,
    });
    const over = createQRPlan("a".repeat(QR_MAX_BYTES + 1));
    expect(over.kind).toBe("sheet");
    if (over.kind === "sheet") expect(over.chunks.length).toBe(2);
  });

  it("keeps the exact 2,331-byte boundary for Chinese text", () => {
    // 777 × 3-byte characters = 2,331 bytes.
    expect(createQRPlan("中".repeat(777)).kind).toBe("single");
    const over = createQRPlan("中".repeat(778));
    expect(over.kind).toBe("sheet");
    if (over.kind === "sheet") expect(over.chunks.length).toBe(2);
  });

  it("splits without breaking surrogate pairs or UTF-8 characters", () => {
    const text = "扫码😀".repeat(400); // well past one QR
    const plan = createQRPlan(text);
    expect(plan.kind).toBe("sheet");
    if (plan.kind !== "sheet") return;

    for (const chunk of plan.chunks) {
      expect(encoder.encode(chunk).length).toBeLessThanOrEqual(SEGMENT_DATA_BYTES);
      expect(toWellFormed(chunk)).toBe(chunk);
    }
    expect(plan.chunks.join("")).toBe(text);
    expect(plan.chunks.length).toBeLessThanOrEqual(MAX_SEGMENTS);
  });

  it("uses the maximum 255 segments for the maximum content", () => {
    const plan = createQRPlan("a".repeat(MAX_CONTENT_BYTES));
    expect(plan.kind).toBe("sheet");
    if (plan.kind !== "sheet") return;
    expect(plan.chunks.length).toBe(MAX_SEGMENTS);
    expect(plan.chunks.every((chunk) => chunk.length === SEGMENT_DATA_BYTES)).toBe(true);
  });

  it("rejects content one byte over the multi-code limit", () => {
    const plan = createQRPlan("a".repeat(MAX_CONTENT_BYTES + 1));
    expect(plan.kind).toBe("error");
    if (plan.kind === "error") {
      expect(plan.message).toContain(String(MAX_CONTENT_BYTES));
    }
  });
});

describe("segment envelope", () => {
  it("round-trips a header plus data", () => {
    const payload = encodeSegment("hello 世界", 2, 7, 0x259d8b98);
    expect(payload.startsWith("QRS1259D8B98002007")).toBe(true);
    expect(encoder.encode(payload).length).toBe(SEGMENT_HEADER_BYTES + encoder.encode("hello 世界").length);

    const parsed = parseSegment(encoder.encode(payload));
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({ crc: 0x259d8b98, index: 2, total: 7 });
    expect(new TextDecoder().decode(parsed!.data)).toBe("hello 世界");
  });

  it("fits exactly the maximum data chunk", () => {
    const payload = encodeSegment("a".repeat(SEGMENT_DATA_BYTES), 0, 2, 0);
    expect(encoder.encode(payload).length).toBe(QR_MAX_BYTES);
    expect(() => encodeSegment("a".repeat(SEGMENT_DATA_BYTES + 1), 0, 2, 0)).toThrow();
  });

  it("rejects malformed headers", () => {
    const valid = encoder.encode(encodeSegment("data", 0, 2, 1));
    const mutate = (index: number, value: number) => {
      const copy = Uint8Array.from(valid);
      copy[index] = value;
      return copy;
    };

    expect(parseSegment(new Uint8Array())).toBeNull();
    expect(parseSegment(valid.slice(0, SEGMENT_HEADER_BYTES))).toBeNull();
    expect(parseSegment(mutate(0, 0x58))).toBeNull(); // magic
    expect(parseSegment(mutate(4, 0x67))).toBeNull(); // lowercase hex
    expect(parseSegment(mutate(12, 0x58))).toBeNull(); // non-digit index
    expect(parseSegment(encoder.encode("QRS100000000000001" + "x"))).toBeNull(); // total < 2
    expect(parseSegment(encoder.encode("QRS100000000255256" + "x"))).toBeNull(); // total > 255
    expect(parseSegment(encoder.encode("QRS100000000003002" + "x"))).toBeNull(); // index >= total
    expect(parseSegment(mutate(1, 0x80))).toBeNull(); // non-ASCII header
  });
});

describe("reassembleSegments", () => {
  it("restores out-of-order segments exactly", () => {
    const text = "乱序还原 😀\n".repeat(700);
    const { segments } = segmentsFor(text);
    const shuffled = [...segments].reverse();

    const result = reassembleSegments(shuffled);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.text).toBe(text);
      expect(result.total).toBe(segments.length);
    }
  });

  it("ignores identical duplicates", () => {
    const { segments } = segmentsFor("x".repeat(10_000));
    const result = reassembleSegments([...segments, ...segments]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toBe("x".repeat(10_000));
  });

  it("reports missing 0-based indices when a segment is absent", () => {
    const { segments } = segmentsFor("y".repeat(10_000));
    const result = reassembleSegments(segments.filter((segment) => segment.index !== 2));
    expect(result).toMatchObject({ ok: false, reason: "missing" });
    if (!result.ok) expect(result.missing).toEqual([2]);
  });

  it("detects a tampered payload with the CRC", () => {
    const { segments } = segmentsFor("z".repeat(10_000));
    const tampered = segments.map((segment, index) =>
      index === 1
        ? { ...segment, data: Uint8Array.from(segment.data, (byte, i) => (i === 0 ? byte ^ 1 : byte)) }
        : segment
    );

    expect(reassembleSegments(tampered)).toMatchObject({ ok: false, reason: "crc" });
  });

  it("rejects segments from different transfers", () => {
    const a = segmentsFor("a".repeat(10_000)).segments;
    const b = segmentsFor("b".repeat(10_000)).segments;
    expect(reassembleSegments([a[0], b[1]])).toMatchObject({
      ok: false,
      reason: "inconsistent",
    });
  });

  it("rejects conflicting bytes for the same index", () => {
    const { segments } = segmentsFor("q".repeat(10_000));
    const duplicate = { ...segments[0], data: new Uint8Array([1, 2, 3]) };
    expect(reassembleSegments([...segments, duplicate])).toMatchObject({
      ok: false,
      reason: "inconsistent",
    });
  });
});
