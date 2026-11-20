import qrcode from "qrcode-generator";
import { toWellFormed } from "./segments";

// qrcode-generator defaults to a Latin-1 encoder that silently mangles any
// non-ASCII text. Must be set before addData(), since QR8BitByte captures this
// function at construction time. Doing it here (rather than in App) means every
// renderer — including tests and helpers that import this module — shares the
// same encoding.
qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

export const SINGLE_QR_CSS = 420;
export const SINGLE_QR_PADDING = 16;
export const SHEET_CARD_CSS = 210;
export const SHEET_CARD_PADDING = 8;

export function getDevicePixelRatio(): number {
  if (typeof window === "undefined") return 1;
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

export interface RenderOptions {
  cssSize: number;
  paddingCss?: number;
  dpr?: number;
}

export interface RenderResult {
  moduleCount: number;
  /** Module size in device pixels. Always an integer so edges stay crisp. */
  cellSize: number;
  dpr: number;
  backingSize: number;
}

function backingSizeFor(cssSize: number, dpr: number): number {
  return Math.max(1, Math.round(cssSize * dpr));
}

/**
 * Renders a QR code into `canvas` at DPR-aware device resolution.
 *
 * The canvas backing store matches the screen's physical pixels (CSS size ×
 * devicePixelRatio) and modules are drawn on integer device-pixel boundaries.
 * This avoids the compositor re-sampling the bitmap when the OS uses fractional
 * scaling (125%/150%), which blurs 1–2 px modules enough to defeat barcode
 * detection. The element keeps its CSS size, so layout is unchanged.
 *
 * Returns null when the content cannot fit, or when the requested CSS size is
 * too small for the QR's module count at the current DPR.
 */
export function renderQRToCanvas(
  canvas: HTMLCanvasElement,
  content: string,
  options: RenderOptions
): RenderResult | null {
  const dpr = options.dpr ?? getDevicePixelRatio();
  const paddingCss = options.paddingCss ?? SINGLE_QR_PADDING;
  const backingSize = backingSizeFor(options.cssSize, dpr);

  canvas.width = backingSize;
  canvas.height = backingSize;
  canvas.style.width = `${options.cssSize}px`;
  canvas.style.height = `${options.cssSize}px`;

  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, backingSize, backingSize);

  let qr: ReturnType<typeof qrcode>;
  try {
    qr = qrcode(0, "M");
    qr.addData(toWellFormed(content));
    qr.make();
  } catch {
    return null;
  }

  const moduleCount = qr.getModuleCount();
  const pad = Math.round(paddingCss * dpr);
  const inner = backingSize - 2 * pad;
  const cellSize = Math.floor(inner / moduleCount);
  if (cellSize < 1) return null;

  const offset = pad + Math.floor((inner - moduleCount * cellSize) / 2);

  ctx.fillStyle = "#000000";
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect(
          offset + col * cellSize,
          offset + row * cellSize,
          cellSize,
          cellSize
        );
      }
    }
  }

  return { moduleCount, cellSize, dpr, backingSize };
}

/** Clears a canvas (including its DPR-aware backing store) to transparent. */
export function clearQRCanvas(
  canvas: HTMLCanvasElement,
  options: { cssSize: number; dpr?: number }
): void {
  const dpr = options.dpr ?? getDevicePixelRatio();
  const backingSize = backingSizeFor(options.cssSize, dpr);
  canvas.width = backingSize;
  canvas.height = backingSize;
  canvas.style.width = `${options.cssSize}px`;
  canvas.style.height = `${options.cssSize}px`;
  canvas.getContext("2d")?.clearRect(0, 0, backingSize, backingSize);
}
