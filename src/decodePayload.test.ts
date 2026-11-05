import { describe, expect, it } from "vitest";
import { decodePayload } from "./App";
import { gbkEncode, utf8Encode } from "./test/gbk";

// jsQR hands byte-mode payloads to decodeURIComponent and drops the whole
// segment when that throws, so GBK payloads (no ECI) arrive as raw bytes only.
// decodePayload is the single place that turns those bytes into text.

describe("decodePayload", () => {
  it("returns an empty string for an empty payload", () => {
    expect(decodePayload([])).toBe("");
    expect(decodePayload(new Uint8ClampedArray(0))).toBe("");
  });

  it("decodes ASCII", () => {
    expect(decodePayload(utf8Encode("CREATE TABLE"))).toBe("CREATE TABLE");
  });

  it("decodes UTF-8 multi-byte text", () => {
    expect(decodePayload(utf8Encode("用户角色ID"))).toBe("用户角色ID");
  });

  it("decodes UTF-8 multi-byte text from a Uint8ClampedArray", () => {
    expect(decodePayload(new Uint8ClampedArray(utf8Encode("中文")))).toBe("中文");
  });

  it("falls back to GB18030 when the bytes are not valid UTF-8", () => {
    // 用户角色 as GBK double-byte pairs — no valid UTF-8 sequence anywhere.
    expect(decodePayload(gbkEncode("用户角色"))).toBe("用户角色");
  });

  it("falls back to GB18030 for a mixed ASCII + GBK payload", () => {
    const bytes = [...utf8Encode("COMMENT '"), ...gbkEncode("中文"), ...utf8Encode("'")];
    expect(decodePayload(bytes)).toBe("COMMENT '中文'");
  });

  it("prefers UTF-8 so valid UTF-8 is never reinterpreted as GB18030", () => {
    // 用户 is e7 94 a8 e6 88 b7 in UTF-8; the same bytes read as GB18030 would
    // come out as 鐢ㄦ埛. This keeps the fallback from mangling valid content.
    const bytes = utf8Encode("用户");
    expect(decodePayload(bytes)).toBe("用户");
    expect(decodePayload(bytes)).not.toBe("鐢ㄦ埛");
  });

  it("handles multi-line payloads with CRLF", () => {
    const text = "-- table\r\nCREATE TABLE `t` (\r\n  `ID` bigint\r\n)";
    expect(decodePayload(utf8Encode(text))).toBe(text);
  });

  it("does not throw on bytes that are invalid in both UTF-8 and GB18030", () => {
    // 0xff is never a valid lead byte; TextDecoder substitutes U+FFFD.
    const out = decodePayload([0xff, 0xff]);
    expect(typeof out).toBe("string");
    expect(out).toContain("�");
  });

  it("decodes a full demo-shaped SQL statement with Chinese comments", () => {
    const text =
      "CREATE TABLE `t_user_role` (\r\n" +
      "  `USER_ROLE_ID` bigint(20) NOT NULL COMMENT '用户角色ID',\r\n" +
      "  `ETPS_ID` bigint(20) NOT NULL COMMENT '企业ID'\r\n" +
      ");";
    expect(decodePayload(gbkEncode(text))).toBe(text);
  });

  it("decodes 4-byte UTF-8 characters", () => {
    expect(decodePayload(utf8Encode("扫码 😀✓"))).toBe("扫码 😀✓");
  });

  it("preserves NUL and control bytes", () => {
    expect(decodePayload([0x61, 0x00, 0x62, 0x0a, 0x63])).toBe("a\u0000b\nc");
  });

  it("falls back to GB18030 for full-width punctuation", () => {
    const text = "提示：请稍候……";
    expect(decodePayload(gbkEncode(text))).toBe(text);
  });

  it("accepts a plain number[] even when values are ordinary ASCII", () => {
    expect(decodePayload([0x61, 0x62, 0x63])).toBe("abc");
  });
});
