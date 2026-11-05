import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { installPastePipeline } from "./test/setup";

// macOS registers only the paste listener: the keydown/clipboard.read() path
// races the native paste there, which made the first ⌘V disappear. The platform
// is pinned so this file runs identically on any host OS.

vi.mock("./platform", () => ({ isMac: true }));

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

describe("macOS", () => {
  it("shows the ⌘V hint", async () => {
    const { default: App } = await import("./App");
    render(<App />);
    expect(screen.getByText("⌘V")).toBeInTheDocument();
  });

  it("does not read the clipboard on ⌘V", async () => {
    const { default: App } = await import("./App");
    const read = vi.fn().mockResolvedValue([]);
    Object.defineProperty(navigator, "clipboard", { value: { read }, configurable: true });

    render(<App />);
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true })
      );
    });

    // Only the paste event may touch the clipboard here.
    expect(read).not.toHaveBeenCalled();
    expect(logMessages().join("\n")).not.toContain("[keydown]");
  });

  it("decodes through the paste event", async () => {
    const { default: App } = await import("./App");
    const { dispatchPaste, makeImageFile, makePasteEvent, renderQRToCanvas, stubImage } =
      await import("./test/helpers");

    const source = renderQRToCanvas("via paste event");
    installPastePipeline({ source });
    stubImage({ source });

    render(<App />);
    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );

    await waitFor(() => expect(textarea().value).toBe("via paste event"));
  });
});
