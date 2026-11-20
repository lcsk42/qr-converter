import { describe, expect, it } from "vitest";
import { decodeQRCodes } from "./decode";
import { clearQRCanvas, renderQRToCanvas } from "./qrRender";
import { SEGMENT_DATA_BYTES, encodeSegment } from "./segments";

function imageData(canvas: HTMLCanvasElement): ImageData {
  return canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height) as unknown as ImageData;
}

// Each case renders into a fresh canvas: the jsdom test harness creates the
// native backing store on the first getContext call, so changing DPR on an
// existing canvas would not resize the backing.
describe("renderQRToCanvas", () => {
  it("renders a decodable single QR at all common device pixel ratios", async () => {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      const canvas = document.createElement("canvas");
      const rendered = renderQRToCanvas(canvas, "DPR test", { cssSize: 420, dpr });

      expect(rendered).not.toBeNull();
      expect(rendered!.dpr).toBe(dpr);
      expect(rendered!.backingSize).toBe(Math.round(420 * dpr));
      expect(Number.isInteger(rendered!.cellSize)).toBe(true);
      expect(rendered!.cellSize).toBeGreaterThanOrEqual(1);

      const decoded = await decodeQRCodes(imageData(canvas));
      expect(decoded.map((result) => result.text)).toContain("DPR test");
    }
  });

  it("renders a maximum-size V40 segment into a 210px sheet card", async () => {
    const payload = encodeSegment("x".repeat(SEGMENT_DATA_BYTES), 0, 2, 0);

    for (const dpr of [1, 1.25, 1.5, 2]) {
      const canvas = document.createElement("canvas");
      const rendered = renderQRToCanvas(canvas, payload, {
        cssSize: 210,
        paddingCss: 8,
        dpr,
      });

      expect(rendered).not.toBeNull();
      expect(rendered!.moduleCount).toBe(177);
      expect(rendered!.cellSize).toBeGreaterThanOrEqual(1);

      const decoded = await decodeQRCodes(imageData(canvas));
      expect(decoded).toHaveLength(1);
      expect(decoded[0].text).toBe(payload);
    }
  });

  it("returns null when the content does not fit a single QR", () => {
    const canvas = document.createElement("canvas");
    expect(
      renderQRToCanvas(canvas, "a".repeat(2332), { cssSize: 420, paddingCss: 16, dpr: 1 })
    ).toBeNull();
  });

  it("clears the DPR-aware backing store", () => {
    const canvas = document.createElement("canvas");
    renderQRToCanvas(canvas, "erase me", { cssSize: 420, paddingCss: 16, dpr: 1 });

    clearQRCanvas(canvas, { cssSize: 420, dpr: 1 });

    const ctx = canvas.getContext("2d")!;
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    expect(pixels.every((value) => value === 0)).toBe(true);
  });
});
