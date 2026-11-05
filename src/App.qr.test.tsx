import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { decodeCanvas } from "./test/helpers";

// Text → QR generation. Runs against the real canvas backend, so "a QR
// appeared" means pixels were actually drawn and can be decoded again.

const qrCanvas = () => document.querySelector("canvas") as HTMLCanvasElement;
const textarea = () =>
  screen.getByPlaceholderText("Enter text to generate a QR code") as HTMLTextAreaElement;
const CAPACITY_ERROR = "Content exceeds QR code capacity";

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

  it("shows an error and keeps the canvas mounted when content is too large", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2400));

    await waitFor(() => expect(screen.getByText(CAPACITY_ERROR)).toBeInTheDocument());
    // The regression this guards: the canvas used to be unmounted on error, and
    // the resulting null ref made every later render bail out permanently.
    expect(qrCanvas()).toBeInTheDocument();
  });

  it("recovers from the capacity error once the text gets smaller", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2400));
    await waitFor(() => expect(screen.getByText(CAPACITY_ERROR)).toBeInTheDocument());

    await user.clear(textarea());
    await user.paste("ok");

    await waitFor(() => expect(screen.queryByText(CAPACITY_ERROR)).not.toBeInTheDocument());
    expect(decodeCanvas(qrCanvas())).toBe("ok");
  });

  it("clears the error when all text is deleted", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2400));
    await waitFor(() => expect(screen.getByText(CAPACITY_ERROR)).toBeInTheDocument());

    await user.clear(textarea());

    await waitFor(() => expect(screen.queryByText(CAPACITY_ERROR)).not.toBeInTheDocument());
    expect(screen.getByText("QR code will appear here")).toBeInTheDocument();
  });

  it("recovers right at the 2331-byte boundary", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(textarea());
    await user.paste("a".repeat(2332));
    await waitFor(() => expect(screen.getByText(CAPACITY_ERROR)).toBeInTheDocument());

    await user.clear(textarea());
    await user.paste("a".repeat(2331));

    await waitFor(() => expect(screen.queryByText(CAPACITY_ERROR)).not.toBeInTheDocument());
    expect(qrCanvas().className).not.toContain("invisible");
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
