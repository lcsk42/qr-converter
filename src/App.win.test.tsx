import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { installPastePipeline } from "./test/setup";

// Windows/WebView2 keeps the keydown + clipboard.read() path because
// clipboardData often omits image items there. The platform is pinned so this
// file runs identically on any host OS.

vi.mock("./platform", () => ({ isMac: false }));

const status = () => document.querySelector("p.text-xs") as HTMLParagraphElement;
const textarea = () =>
  screen.getByPlaceholderText("Enter text to generate a QR code") as HTMLTextAreaElement;
const logMessages = () =>
  vi.mocked(invoke).mock.calls.map(([, args]) => String((args as { message: string }).message));

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setClipboard(read: (() => Promise<unknown[]>) | undefined) {
  Object.defineProperty(navigator, "clipboard", {
    value: read ? { read } : undefined,
    configurable: true,
  });
}

const pressCtrlV = async () => {
  await act(async () => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true })
    );
  });
};

describe("Windows", () => {
  it("shows the Ctrl+V hint", async () => {
    const { default: App } = await import("./App");
    render(<App />);
    expect(screen.getByText("Ctrl+V")).toBeInTheDocument();
  });

  it("reads the clipboard on Ctrl+V and decodes the image", async () => {
    const { default: App } = await import("./App");
    const { renderQRToCanvas, stubImage } = await import("./test/helpers");

    const source = renderQRToCanvas("from clipboard");
    installPastePipeline({ source });
    stubImage({ source });
    const read = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
      },
    ]);
    setClipboard(read);

    render(<App />);
    await pressCtrlV();

    await waitFor(() => expect(read).toHaveBeenCalled());
    await waitFor(() => expect(textarea().value).toBe("from clipboard"));
  });

  it("picks the image item when the clipboard also holds text", async () => {
    const { default: App } = await import("./App");
    const { renderQRToCanvas, stubImage } = await import("./test/helpers");

    const source = renderQRToCanvas("image wins");
    installPastePipeline({ source });
    stubImage({ source });
    const read = vi.fn().mockResolvedValue([
      { types: ["text/plain"], getType: async () => new Blob([]) },
      {
        types: ["text/html", "image/png"],
        getType: async () => new Blob([new Uint8Array([1])], { type: "image/png" }),
      },
    ]);
    setClipboard(read);

    render(<App />);
    await pressCtrlV();

    await waitFor(() => expect(textarea().value).toBe("image wins"));
  });

  it("ignores other keys", async () => {
    const { default: App } = await import("./App");
    const read = vi.fn().mockResolvedValue([]);
    setClipboard(read);
    render(<App />);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    });

    expect(read).not.toHaveBeenCalled();
  });

  it("does nothing when the clipboard holds no image", async () => {
    const { default: App } = await import("./App");
    const read = vi
      .fn()
      .mockResolvedValue([{ types: ["text/plain"], getType: async () => new Blob([]) }]);
    setClipboard(read);
    render(<App />);

    await pressCtrlV();

    await waitFor(() => expect(read).toHaveBeenCalled());
    expect(textarea().value).toBe("");
    expect(logMessages().join("\n")).toContain("no image type found in clipboard items");
  });

  it("survives a clipboard.read() rejection without showing an error", async () => {
    const { default: App } = await import("./App");
    const read = vi.fn().mockRejectedValue(new Error("NotAllowedError"));
    setClipboard(read);
    render(<App />);

    await pressCtrlV();

    // The paste event is still free to run; a rejected read must not surface as
    // a user-facing error.
    await waitFor(() =>
      expect(logMessages().join("\n")).toContain("[keydown] clipboard.read() failed")
    );
    expect(status().textContent).toBe("");
  });

  it("does not read the clipboard while a paste is already processing", async () => {
    const { default: App } = await import("./App");
    const { dispatchPaste, makeImageFile, makePasteEvent, renderQRToCanvas, stubImage } =
      await import("./test/helpers");
    const read = vi.fn().mockResolvedValue([]);
    setClipboard(read);
    stubImage({ source: renderQRToCanvas("busy"), hang: true });
    render(<App />);

    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );
    await pressCtrlV();

    expect(read).not.toHaveBeenCalled();
  });

  it("still decodes image items delivered through the paste event", async () => {
    const { default: App } = await import("./App");
    const { dispatchPaste, makeImageFile, makePasteEvent, renderQRToCanvas, stubImage } =
      await import("./test/helpers");
    const source = renderQRToCanvas("paste fallback");
    installPastePipeline({ source });
    stubImage({ source });
    render(<App />);

    // WebView2's paste event is the fallback when clipboard.read() is blocked.
    const event = makePasteEvent([
      { kind: "file", type: "image/png", file: makeImageFile() },
    ]);
    await dispatchPaste(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(textarea().value).toBe("paste fallback"));
  });

  it("survives an item.getType() rejection", async () => {
    const { default: App } = await import("./App");
    const read = vi.fn().mockResolvedValue([
      {
        types: ["image/png"],
        getType: vi.fn().mockRejectedValue(new Error("decode error")),
      },
    ]);
    setClipboard(read);
    render(<App />);

    await pressCtrlV();

    await waitFor(() =>
      expect(logMessages().join("\n")).toContain("[keydown] clipboard.read() failed")
    );
    expect(status().textContent).toBe("");
  });
});
