import jsQR from "jsqr";
import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";
import type { Position } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

// ── Payload decoding ─────────────────────────────────────────────────────────
// jsQR/ZXing decode each byte-mode segment with a UTF-8 decoder and leave the
// text empty when the bytes aren't valid UTF-8 (common for GBK/GB18030 payloads
// from older Chinese/Windows tools that don't emit an ECI segment). The raw
// bytes survive, so decode those ourselves: strict UTF-8 first, then GB18030.

export function decodePayload(bytes: Uint8ClampedArray | number[] | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const buffer = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("gb18030").decode(buffer);
  }
}

// ── Multi-code decoder ───────────────────────────────────────────────────────
// jsQR returns at most one symbol per image. zxing-cpp (via WASM) returns every
// QR code it finds in a single pass, which is what makes "screenshot a page of
// codes and paste it once" work. It also preserves the raw payload bytes.
//
// The reader wasm (928 KB) is bundled locally through Vite's `?url` import;
// zxing-wasm's default is a jsDelivr CDN path, which is unacceptable for an
// offline desktop app. In tests, wasmBinary is injected by src/test/setup.ts
// instead (see the MODE check below).

export interface DecodedQR {
  bytes: Uint8Array;
  /** Text as decoded by zxing/jsQR; may be empty for non-UTF-8 payloads. */
  text: string;
  position?: Position;
}

/** Above this, decoding is slow and high-density modules may be lost. */
export const MAX_DECODE_PIXELS = 24_000_000;

export function fitImageDimensions(
  width: number,
  height: number,
  maxPixels: number = MAX_DECODE_PIXELS
): { width: number; height: number; scaled: boolean } {
  const pixels = width * height;
  if (!Number.isFinite(pixels) || pixels <= maxPixels) {
    return { width, height, scaled: false };
  }
  const scale = Math.sqrt(maxPixels / pixels);
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
    scaled: true,
  };
}

let ready: Promise<void> | null = null;

/**
 * Preloads the WASM module so the first paste doesn't pay the compile cost.
 * The binary is fetched explicitly and injected as `wasmBinary`: this works
 * regardless of the asset protocol's MIME type, whereas Emscripten's default
 * `locateFile` path relies on streaming compilation.
 */
export function initQRDecoder(): Promise<void> {
  if (ready) return ready;

  ready = (async () => {
    // Vitest injects the wasm binary via prepareZXingModule in test setup.
    if (import.meta.env.MODE === "test") return;
    const response = await fetch(wasmUrl);
    if (!response.ok) {
      throw new Error(`Could not load zxing wasm (HTTP ${response.status})`);
    }
    const wasmBinary = await response.arrayBuffer();
    await prepareZXingModule({
      overrides: { wasmBinary },
      fireImmediately: true,
    });
  })();

  return ready;
}

export async function decodeQRCodes(imageData: ImageData): Promise<DecodedQR[]> {
  try {
    await initQRDecoder();
    const results = await readBarcodes(imageData, {
      formats: ["QRCode"],
      tryHarder: true,
      tryRotate: true,
    });
    return results
      .filter((result) => result.isValid !== false && result.bytes?.length > 0)
      .map((result) => ({
        bytes: Uint8Array.from(result.bytes),
        text: result.text,
        position: result.position,
      }));
  } catch (error) {
    // Keep single-code decoding working if the WASM asset fails to load.
    console.error("[decode] zxing failed; falling back to jsQR", error);
    const result = jsQR(imageData.data, imageData.width, imageData.height);
    if (!result) return [];
    return [
      {
        bytes: Uint8Array.from(result.binaryData),
        text: result.data ?? "",
      },
    ];
  }
}

/** Sorts results top-to-bottom, left-to-right for the "multiple plain QRs" case. */
export function sortByPosition(results: DecodedQR[]): DecodedQR[] {
  const topLeft = (result: DecodedQR): { x: number; y: number } => {
    const position = result.position;
    if (!position) return { x: 0, y: 0 };
    const points = [
      position.topLeft,
      position.topRight,
      position.bottomLeft,
      position.bottomRight,
    ];
    return {
      x: Math.min(...points.map((point) => point.x)),
      y: Math.min(...points.map((point) => point.y)),
    };
  };

  return [...results].sort((a, b) => {
    const pa = topLeft(a);
    const pb = topLeft(b);
    return pa.y - pb.y || pa.x - pb.x;
  });
}
