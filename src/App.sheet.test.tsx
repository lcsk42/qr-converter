import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "./App";
import { createQRPlan, encodeSegment } from "./segments";
import { renderQRToCanvas } from "./qrRender";
import { installPastePipeline } from "./test/setup";
import {
  composeCards,
  dispatchPaste,
  makeImageFile,
  makePasteEvent,
  stubImage,
} from "./test/helpers";

// Multi-QR sheets: generation, pagination, capture mode, and — most
// importantly — screenshot → paste → ordered reassembly across pages.

const textarea = () =>
  screen.getByPlaceholderText("Enter text to generate a QR code") as HTMLTextAreaElement;
const status = () => document.querySelector("p.text-xs") as HTMLParagraphElement;
const segmentCards = () =>
  Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[data-segment-index]"));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function pasteScreenshot(source: HTMLCanvasElement) {
  installPastePipeline({ source });
  stubImage({ source });
  await dispatchPaste(
    makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
  );
}

describe("multi-QR sheets", () => {
  it(
    "restores a long text from page screenshots pasted out of order",
    async () => {
      const text = "The quick brown fox jumps over the lazy dog.\n".repeat(700);
      const plan = createQRPlan(text);
      expect(plan.kind).toBe("sheet");
      if (plan.kind !== "sheet") return;

      const total = plan.chunks.length;
      expect(total).toBeGreaterThan(12);
      expect(Math.ceil(total / 12)).toBe(2);

      const sender = render(<App />);
      fireEvent.change(textarea(), { target: { value: text } });

      await waitFor(() =>
        expect(screen.getByText(new RegExp(`${total} QR codes`))).toBeInTheDocument()
      );
      await waitFor(() => expect(segmentCards()).toHaveLength(12));
      const pageOne = composeCards(segmentCards());

      fireEvent.click(screen.getByLabelText("Next page"));
      await waitFor(() =>
        expect(segmentCards()).toHaveLength(total - 12)
      );
      await waitFor(() =>
        expect(segmentCards()[0].dataset.segmentIndex).toBe("12")
      );
      const pageTwo = composeCards(segmentCards());

      sender.unmount();
      render(<App />);

      // Paste the second page first: nothing may overwrite the textarea yet.
      await pasteScreenshot(pageTwo);
      await waitFor(() =>
        expect(status().textContent).toContain(
          `Received ${total - 12} of ${total} segments`
        )
      );
      expect(status().textContent).toContain("missing 1, 2, 3");
      expect(textarea().value).toBe("");

      // Overlapping screenshots are expected; duplicates must be ignored.
      await pasteScreenshot(pageTwo);
      await waitFor(() =>
        expect(status().textContent).toContain(
          `Received ${total - 12} of ${total} segments`
        )
      );
      expect(textarea().value).toBe("");

      // Then the first page completes the set, regardless of paste order.
      await pasteScreenshot(pageOne);
      await waitFor(() => expect(textarea().value).toBe(text), { timeout: 10_000 });
      await waitFor(() =>
        expect(status().textContent).toContain(`Restored ${total} segments`)
      );
    },
    20_000
  );

  it("paginates the sheet and hides the editor in capture mode", async () => {
    render(<App />);
    const text = "a".repeat(30_000);
    const plan = createQRPlan(text);
    expect(plan.kind).toBe("sheet");
    if (plan.kind !== "sheet") return;
    const total = plan.chunks.length;
    expect(total).toBe(13);

    fireEvent.change(textarea(), { target: { value: text } });

    await waitFor(() =>
      expect(screen.getByText(new RegExp(`${total} QR codes`))).toBeInTheDocument()
    );
    await waitFor(() => expect(segmentCards()).toHaveLength(12));
    expect(screen.getByText(/Page 1 \/ 2/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Next page"));

    await waitFor(() => expect(screen.getByText(/Page 2 \/ 2/)).toBeInTheDocument());
    await waitFor(() => expect(segmentCards()).toHaveLength(1));
    expect(segmentCards()[0].dataset.segmentIndex).toBe("12");

    fireEvent.click(screen.getByText("Capture mode"));

    expect(
      screen.queryByPlaceholderText("Enter text to generate a QR code")
    ).not.toBeInTheDocument();
    expect(screen.getByText("Exit capture mode")).toBeInTheDocument();
    // Capture mode keeps the current page, so a page screenshot is repeatable.
    expect(segmentCards()).toHaveLength(1);

    fireEvent.click(screen.getByText("Exit capture mode"));
    expect(
      screen.getByPlaceholderText("Enter text to generate a QR code")
    ).toBeInTheDocument();
  });

  it(
    "reports a checksum failure when a segment is corrupted",
    async () => {
      render(<App />);

      const text = "x".repeat(3000);
      const plan = createQRPlan(text);
      expect(plan.kind).toBe("sheet");
      if (plan.kind !== "sheet") return;
      expect(plan.chunks.length).toBe(2);

      const payloads = plan.chunks.map((chunk, index) =>
        encodeSegment(chunk, index, plan.chunks.length, plan.crc)
      );

      // Flip one data byte while leaving the 18-byte header intact, so the
      // segment parses and its index is known but the CRC must fail.
      const corrupt = new TextEncoder().encode(payloads[1]);
      corrupt[corrupt.length - 1] ^= 1;
      const corruptPayload = String.fromCharCode(...corrupt);

      const cards = [payloads[0], corruptPayload].map((payload) => {
        const card = document.createElement("canvas");
        const rendered = renderQRToCanvas(card, payload, {
          cssSize: 210,
          paddingCss: 8,
          dpr: 1,
        });
        expect(rendered).not.toBeNull();
        return card;
      });

      await pasteScreenshot(composeCards(cards, 2, 8));

      await waitFor(() =>
        expect(status().textContent).toContain("checksum mismatch")
      );
      expect(textarea().value).toBe("");
    },
    10_000
  );
});
