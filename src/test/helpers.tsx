import { vi } from "vitest";
import { act } from "@testing-library/react";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { decodePayload } from "../App";

// ── QR rendering ─────────────────────────────────────────────────────────────
// Mirrors App.renderQR's geometry (level M, floor(388/moduleCount) cells, 16px
// padding in a 420px canvas) so round-trip tests assert that what the UI draws
// is actually decodable.

function paint(qr: ReturnType<typeof qrcode>, size: number): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  const ctx = el.getContext("2d")!;
  const moduleCount = qr.getModuleCount();
  const cellSize = Math.floor(388 / moduleCount);
  const offset = Math.floor((388 - moduleCount * cellSize) / 2) + 16;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(offset + col * cellSize, offset + row * cellSize, cellSize, cellSize);
      }
    }
  }
  return el;
}

/** Renders text the way App does (qrcode-generator with UTF-8 bytes). */
export function renderQRToCanvas(content: string, size = 420): HTMLCanvasElement {
  const qr = qrcode(0, "M");
  qr.addData(content);
  qr.make();
  return paint(qr, size);
}

/**
 * Renders a QR whose byte-mode payload is exactly `bytes` — how an old GBK
 * generator behaves: raw double-byte Chinese, no ECI segment.
 */
export function renderBytesToCanvas(bytes: number[], size = 420): HTMLCanvasElement {
  const previous = qrcode.stringToBytes;
  qrcode.stringToBytes = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
  try {
    const qr = qrcode(0, "M");
    qr.addData(String.fromCharCode(...bytes));
    qr.make();
    return paint(qr, size);
  } finally {
    qrcode.stringToBytes = previous;
  }
}

/** A blank QR-free image, for the "no QR code found" path. */
export function renderBlankCanvas(size = 420): HTMLCanvasElement {
  const el = document.createElement("canvas");
  el.width = size;
  el.height = size;
  const ctx = el.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, size, size);
  return el;
}

// ── Image stub for the paste path ────────────────────────────────────────────
// processImage does `new Image(); img.src = objectURL; img.onload`. jsdom never
// loads images, so the constructor is replaced with one resolving on the next
// microtask.

export interface FakeImageOptions {
  /** Source canvas whose dimensions the fake image reports. */
  source: HTMLCanvasElement;
  /** Fire onerror instead of onload. */
  fail?: boolean;
  /** Never settle — exercises processImage's guard timeout. */
  hang?: boolean;
}

export function stubImage(opts: FakeImageOptions) {
  const { width, height } = opts.source;
  class FakeImage {
    naturalWidth = width;
    naturalHeight = height;
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;

    set src(_value: string) {
      if (opts.hang) return;
      queueMicrotask(() => {
        if (opts.fail) this.onerror?.(new Event("error"));
        else this.onload?.();
      });
    }
  }
  vi.stubGlobal("Image", FakeImage);
}

/** Decodes a canvas exactly the way App.processImage does. */
export function decodeCanvas(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext("2d")!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const result = jsQR(data, width, height);
  return result ? decodePayload(result.binaryData) : null;
}

// ── ClipboardEvent construction ──────────────────────────────────────────────

export interface FakeClipboardItem {
  kind: "file" | "string";
  type: string;
  file?: File;
}

/** Builds a ClipboardEvent whose clipboardData exposes the given items. */
export function makePasteEvent(items: FakeClipboardItem[]): ClipboardEvent {
  const data = {
    items: items.map((item) => ({
      kind: item.kind,
      type: item.type,
      getAsFile: () => item.file ?? null,
      getAsString: () => "",
    })),
    types: items.map((i) => i.type),
    files: items.filter((i) => i.file).map((i) => i.file!),
  };
  const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: data });
  return event;
}

/** A File that the fake Image loader will "decode". */
export function makeImageFile(type = "image/png") {
  return new File([new Uint8Array([137, 80, 78, 71])], "paste", { type });
}

/**
 * Dispatches a paste event inside act and lets the microtasks it queues —
 * the fake image's onload/onerror — run before act flushes. Dispatching
 * raw leaves React state updates from the decode outside act, which floods the
 * output with "not wrapped in act" warnings.
 */
export async function dispatchPaste(event: ClipboardEvent) {
  await act(async () => {
    document.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}
