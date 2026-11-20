import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { MAX_CONTENT_BYTES, parseSegment } from "./segments";
import { decodeCanvas, decodeCanvasWithZXing } from "./test/helpers";

// Text → QR generation. Runs against the real canvas backend, so "a QR
// appeared" means pixels were actually drawn and can be decoded again.

const qrCanvas = () => document.querySelector("canvas") as HTMLCanvasElement;
const textarea = () =>
  screen.getByPlaceholderText("Enter text to generate a QR code") as HTMLTextAreaElement;
const segmentCards = () =>
  Array.from(document.querySelectorAll<HTMLCanvasElement>("canvas[data-segment-index]"));
const sheetSummary = () => screen.getByText(/QR codes ·/);

describe("QR generation", () => {
  it("shows the empty state before any text is entered", () => {
    render(<App />);
    expect(screen.getByText("QR code will appear here")).toBeInTheDocument();
    expect(qrCanvas().className).toContain("invisible");
  });

  it("renders a decodable QR for simple text", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("hello");

    await waitFor(() =>
      expect(screen.queryByText("QR code will appear here")).not.toBeInTheDocument()
    );
    expect(qrCanvas().className).not.toContain("invisible");
    expect(decodeCanvas(qrCanvas())).toBe("hello");
  });

  it("round-trips UTF-8 Chinese text", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("用户角色ID");

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("用户角色ID"));
  });

  it("round-trips multi-line SQL", async () => {
    const user = userEvent.setup();
    render(<App />);
    const sql = "CREATE TABLE `t` (\n  `id` bigint\n);";

    await user.click(textarea());
    await user.paste(sql);

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe(sql));
  });

  it("re-renders when the text changes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("first");
    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("first"));

    await user.clear(textarea());
    await user.paste("second");
    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("second"));
  });

  it("splits content beyond a single QR into a sheet of segments", async () => {
    const user = userEvent.setup();
    render(<App />);
    const content = "a".repeat(2400);

    await user.click(textarea());
    await user.paste(content);

    await waitFor(() => expect(sheetSummary()).toBeInTheDocument());
    const cards = segmentCards();
    expect(cards).toHaveLength(2);

    const payloads = await Promise.all(cards.map(decodeCanvasWithZXing));
    for (const [index, decoded] of payloads.entries()) {
      expect(decoded).toHaveLength(1);
      const segment = parseSegment(new TextEncoder().encode(decoded[0]));
      expect(segment).not.toBeNull();
      expect(segment).toMatchObject({ index, total: 2 });
    }
    expect(payloads[0][0].startsWith("QRS1")).toBe(true);
    expect(textarea().value).toBe(content);
  });

  it("returns to a single QR when the text shrinks", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2400));
    await waitFor(() => expect(sheetSummary()).toBeInTheDocument());

    await user.clear(textarea());
    await user.paste("ok");

    await waitFor(() =>
      expect(screen.queryByText(/QR codes ·/)).not.toBeInTheDocument()
    );
    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("ok"));
  });

  it("clears the sheet when all text is deleted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2400));
    await waitFor(() => expect(segmentCards()).toHaveLength(2));

    await user.clear(textarea());

    await waitFor(() =>
      expect(screen.getByText("QR code will appear here")).toBeInTheDocument()
    );
    expect(segmentCards()).toHaveLength(0);
  });

  it("switches from a sheet to a single QR at the 2,331-byte boundary", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2332));
    await waitFor(() => expect(segmentCards()).toHaveLength(2));

    await user.clear(textarea());
    await user.paste("a".repeat(2331));

    await waitFor(() => expect(segmentCards()).toHaveLength(0));
    await waitFor(
      () => expect(decodeCanvas(qrCanvas())).toBe("a".repeat(2331)),
      { timeout: 5000 }
    );
  });

  it("shows a limit error beyond 255 segments and recovers", async () => {
    render(<App />);
    const tooLarge = "a".repeat(MAX_CONTENT_BYTES + 1);

    fireEvent.change(textarea(), { target: { value: tooLarge } });

    await waitFor(() =>
      expect(screen.getByText(/Content exceeds the multi-code limit/)).toBeInTheDocument()
    );
    // The regression this guards: the canvas used to be unmounted on error, so
    // the null ref made every later render bail out permanently.
    expect(qrCanvas()).toBeInTheDocument();

    fireEvent.change(textarea(), { target: { value: "ok" } });

    await waitFor(() =>
      expect(screen.queryByText(/Content exceeds the multi-code limit/)).not.toBeInTheDocument()
    );
    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("ok"));
  });

  it("treats whitespace-only text as empty", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("   \n\t ");

    expect(screen.getByText("QR code will appear here")).toBeInTheDocument();
    expect(qrCanvas().className).toContain("invisible");
  });

  it("generates a QR from typed input, not just paste", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.type(textarea(), "typed");

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("typed"));
  });

  it("round-trips 4-byte UTF-8 characters", async () => {
    const user = userEvent.setup();
    render(<App />);
    const text = "扫码 😀✓";

    await user.click(textarea());
    await user.paste(text);

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe(text));
  });

  it("still decodes at the maximum payload size", async () => {
    const user = userEvent.setup();
    render(<App />);
    // 2331 bytes is exactly the byte-mode capacity of a version-40 level-M QR.
    // This exercises the largest module grid (cell size 2), not just "no error".
    const content = "a".repeat(2331);

    await user.click(textarea());
    await user.paste(content);

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe(content), { timeout: 5000 });
  });

  it("clears the drawn modules when the text is deleted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("erase me");
    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBe("erase me"));

    await user.clear(textarea());

    await waitFor(() => expect(decodeCanvas(qrCanvas())).toBeNull());
    expect(qrCanvas().className).toContain("invisible");
  });
});
