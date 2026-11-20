import { describe, expect, it } from "vitest";
import { decodeQRCodes, fitImageDimensions } from "./decode";
import { renderQRToCanvas } from "./qrRender";
import { canvasBitmap } from "./test/setup";

function imageData(canvas: HTMLCanvasElement): ImageData {
  return canvas
    .getContext("2d")!
    .getImageData(0, 0, canvas.width, canvas.height) as unknown as ImageData;
}

describe("decodeQRCodes", () => {
  it("decodes a single QR through zxing", async () => {
    const canvas = document.createElement("canvas");
    renderQRToCanvas(canvas, "hello from zxing", { cssSize: 420, dpr: 1 });

    const results = await decodeQRCodes(imageData(canvas));

    expect(results.map((result) => result.text)).toEqual(["hello from zxing"]);
  });

  it("decodes several QR codes from one image", async () => {
    const sheet = document.createElement("canvas");
    sheet.width = 460;
    sheet.height = 230;
    const ctx = sheet.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, sheet.width, sheet.height);

    for (const [index, text] of ["first", "second"].entries()) {
      const card = document.createElement("canvas");
      renderQRToCanvas(card, text, { cssSize: 210, dpr: 1 });
      ctx.drawImage(canvasBitmap(card) as never, index * 230, 10);
    }

    const results = await decodeQRCodes(imageData(sheet));

    expect(results.map((result) => result.text).sort()).toEqual(["first", "second"]);
  });

  it("returns an empty list for an image without codes", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 200;
    canvas.height = 200;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, 200, 200);

    await expect(decodeQRCodes(imageData(canvas))).resolves.toEqual([]);
  });
});

describe("fitImageDimensions", () => {
  it("keeps images below the pixel budget at native size", () => {
    expect(fitImageDimensions(1024, 768)).toEqual({
      width: 1024,
      height: 768,
      scaled: false,
    });
    expect(fitImageDimensions(3000, 3000)).toEqual({
      width: 3000,
      height: 3000,
      scaled: false,
    });
  });

  it("scales larger images down preserving the aspect ratio", () => {
    const fitted = fitImageDimensions(6000, 5000, 24_000_000);
    expect(fitted.scaled).toBe(true);
    expect(fitted.width * fitted.height).toBeLessThanOrEqual(24_000_000);
    expect(fitted.width / fitted.height).toBeCloseTo(1.2, 1);
  });
});
