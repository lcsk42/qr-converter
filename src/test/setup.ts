import { afterEach, beforeAll, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createCanvas } from "@napi-rs/canvas";
// Registers toBeInTheDocument / toHaveBeenCalledWith-style DOM matchers and
// augments vitest's Assertion type. Without it tsc rejects the matchers and
// every DOM assertion throws "Invalid Chai property".
import "@testing-library/jest-dom/vitest";

// ── Tauri IPC ────────────────────────────────────────────────────────────────
// The logger calls invoke("write_log") on every log line. Without Tauri running
// there is no IPC, so stub it out. Tests that care inspect
// vi.mocked(invoke).mock.calls.

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => Promise.resolve()),
}));

// ── Canvas ───────────────────────────────────────────────────────────────────
// jsdom has no 2D context. @napi-rs/canvas is a real native-backed canvas, so
// drawing and getImageData work — which lets the round-trip tests render a QR
// and decode it back with jsQR.
//
// Note that nothing needs width/height forwarding: every code path in App sets
// the canvas size *before* calling getContext (JSX attributes, the offscreen
// sizing, and renderQR's fixed 420), so the backing store is created at the
// right size the first time.

type Backed = HTMLCanvasElement & { __ctx?: CanvasRenderingContext2D; __legacy?: boolean };

// ── Paste pipeline ───────────────────────────────────────────────────────────
// processImage draws a pasted image onto an offscreen canvas, then decodes its
// pixels. jsdom can't decode an image, so instead the offscreen canvas is made
// to synthesise `source` — the pixels a pasted QR image would have had.
// Only canvases created *after* this is installed are affected, which is just
// the offscreen one (UI canvases already exist).

interface Pipeline {
  /** Source canvas whose pixels the fake pasted image contains. */
  source: HTMLCanvasElement;
  /** Throw from drawImage instead, to exercise processImage's catch. */
  throwOnDraw?: boolean;
}

let pipeline: Pipeline | null = null;

export function installPastePipeline(p: Pipeline | null) {
  if (p) {
    for (const el of Array.from(document.querySelectorAll("canvas"))) {
      (el as Backed).__legacy = true;
    }
  }
  pipeline = p;
  return () => {
    pipeline = null;
  };
}

/**
 * The pixels of a test fixture canvas live in the @napi-rs/canvas bitmap behind
 * the patched getContext, not in the jsdom element itself. @napi-rs/canvas
 * rejects jsdom's HTMLCanvasElement in drawImage, so hand it the native canvas.
 */
function backingCanvas(source: HTMLCanvasElement) {
  return (source as Backed).__ctx?.canvas ?? null;
}

function wrapWithPipeline(canvas: Backed, ctx: CanvasRenderingContext2D) {
  const { source, throwOnDraw } = pipeline!;
  return new Proxy(ctx, {
    get(target, prop) {
      if (prop === "drawImage") {
        return () => {
          if (throwOnDraw) throw new Error("drawImage exploded");
        };
      }
      if (prop === "getImageData") {
        // Resample the source to the canvas's own size, the way a real
        // drawImage(img, 0, 0, w, h) would (this also covers the downscale path).
        return () => {
          const w = canvas.width;
          const h = canvas.height;
          const native = backingCanvas(source);
          if (!native) return new ImageData(w, h);
          const scratch = createCanvas(w, h);
          const scratchCtx = scratch.getContext("2d");
          scratchCtx.drawImage(native as never, 0, 0, w, h);
          return scratchCtx.getImageData(0, 0, w, h) as unknown as ImageData;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, prop, value) {
      return Reflect.set(target, prop, value, target);
    },
  });
}

beforeAll(() => {
  const proto = HTMLCanvasElement.prototype as unknown as Record<string, unknown>;

  proto.getContext = function (this: Backed, type: string, ...rest: unknown[]) {
    if (type !== "2d") return null;
    if (!this.__ctx) {
      // SKRSContext2D is structurally compatible enough for everything App
      // draws, but it lacks drawFocusIfNeeded from the DOM interface.
      this.__ctx = createCanvas(this.width || 300, this.height || 150).getContext(
        "2d",
        ...(rest as [])
      ) as unknown as CanvasRenderingContext2D;
    }
    const ctx = this.__ctx;
    if (pipeline && !this.__legacy) return wrapWithPipeline(this, ctx);
    return ctx;
  };
});

// ── Object URLs ──────────────────────────────────────────────────────────────
Object.defineProperty(URL, "createObjectURL", {
  value: vi.fn(() => "blob:mock"),
  writable: true,
});
Object.defineProperty(URL, "revokeObjectURL", {
  value: vi.fn(),
  writable: true,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  pipeline = null;
});
