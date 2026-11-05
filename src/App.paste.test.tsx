import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import { installPastePipeline } from "./test/setup";
import {
  dispatchPaste,
  makeImageFile,
  makePasteEvent,
  renderBlankCanvas,
  renderBytesToCanvas,
  renderQRToCanvas,
  stubImage,
} from "./test/helpers";
import { gbkEncode } from "./test/gbk";

// Image → text (paste), platform-neutral behaviour. The image loader is faked
// and the offscreen canvas synthesises the pasted image's pixels, so the real
// jsQR + decodePayload path runs on real bitmaps. Platform-specific keydown
// behaviour lives in App.mac.test.tsx / App.win.test.tsx.

const textarea = () =>
  screen.getByPlaceholderText("Enter text to generate a QR code") as HTMLTextAreaElement;
const status = () => document.querySelector("p.text-xs") as HTMLParagraphElement;
const logMessages = () =>
  vi.mocked(invoke).mock.calls.map(([, args]) => String((args as { message: string }).message));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Feeds `source` to the component as if it had been pasted. */
async function pasteImage(
  source: HTMLCanvasElement,
  opts: { throwOnDraw?: boolean } = {}
) {
  installPastePipeline({ source, ...opts });
  stubImage({ source });
  await dispatchPaste(
    makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
  );
}

describe("paste → decode", () => {
  it("writes decoded text into the textarea", async () => {
    render(<App />);
    await pasteImage(renderQRToCanvas("hello from qr"));

    await waitFor(() => expect(textarea().value).toBe("hello from qr"));
    expect(status().textContent).toBe("");
  });

  it("decodes a UTF-8 Chinese payload", async () => {
    render(<App />);
    const text = "用户角色ID";

    await pasteImage(renderQRToCanvas(text));

    await waitFor(() => expect(textarea().value).toBe(text));
    expect(logMessages().join("\n")).not.toContain("decoded via GB18030 fallback");
  });

  it("decodes a GBK payload that jsQR alone drops", async () => {
    render(<App />);
    const sql = "COMMENT '用户角色ID'";
    await pasteImage(renderBytesToCanvas(gbkEncode(sql)));

    await waitFor(() => expect(textarea().value).toBe(sql));
    expect(logMessages().join("\n")).toContain("decoded via GB18030 fallback");
  });

  it("immediately regenerates the QR from the decoded text", async () => {
    render(<App />);
    await pasteImage(renderQRToCanvas("round trip"));

    await waitFor(() => expect(textarea().value).toBe("round trip"));
    await waitFor(() =>
      expect(document.querySelector("canvas")!.className).not.toContain("invisible")
    );
  });

  it("shows a not-found status for an image without a QR code", async () => {
    render(<App />);
    await pasteImage(renderBlankCanvas());

    await waitFor(() =>
      expect(status().textContent).toBe("No QR code found in pasted image")
    );
    expect(textarea().value).toBe("");
  });

  it("auto-clears the not-found status after 2.5s", async () => {
    render(<App />);
    await pasteImage(renderBlankCanvas());

    await waitFor(() =>
      expect(status().textContent).toBe("No QR code found in pasted image")
    );
    await act(async () => {
      vi.advanceTimersByTime(2500);
    });
    await waitFor(() =>
      expect(status().textContent).not.toBe("No QR code found in pasted image")
    );
  });

  it("reports an error when the image fails to load", async () => {
    render(<App />);
    stubImage({ source: renderQRToCanvas("unused"), fail: true });

    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );

    await waitFor(() =>
      expect(status().textContent).toBe("Could not read image from clipboard")
    );
  });

  it("ignores paste events carrying only text", () => {
    render(<App />);
    const event = makePasteEvent([{ kind: "string", type: "text/plain" }]);

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(status().textContent).toBe("");
  });

  it("ignores pasted files that are not images", () => {
    render(<App />);
    const event = makePasteEvent([
      {
        kind: "file",
        type: "application/pdf",
        file: new File(["%PDF"], "doc.pdf", { type: "application/pdf" }),
      },
    ]);

    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(logMessages().join("\n")).toContain("no image item found");
  });

  it("picks the image even when a text item comes first", async () => {
    render(<App />);
    const source = renderQRToCanvas("second item");
    installPastePipeline({ source });
    stubImage({ source });

    const event = makePasteEvent([
      { kind: "string", type: "text/plain" },
      { kind: "file", type: "image/png", file: makeImageFile() },
    ]);
    await dispatchPaste(event);

    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(textarea().value).toBe("second item"));
  });

  it("does not process an image item that yields no file", async () => {
    render(<App />);
    const event = makePasteEvent([{ kind: "file", type: "image/png" }]);

    await dispatchPaste(event);

    // Claimed so the native paste can't run, but there is nothing to decode.
    expect(event.defaultPrevented).toBe(true);
    expect(logMessages().join("\n")).toContain("getAsFile(): null");
    expect(logMessages().join("\n")).not.toContain("[processImage] start");

    // The guard was never taken, so the next real paste still works.
    await pasteImage(renderQRToCanvas("still works"));
    await waitFor(() => expect(textarea().value).toBe("still works"));
  });

  it("prevents the default paste for an image", async () => {
    render(<App />);
    const source = renderQRToCanvas("x");
    installPastePipeline({ source });
    stubImage({ source });
    const event = makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }]);

    await dispatchPaste(event);

    // Letting the native paste run alongside ours is what produced the
    // "press ⌘V twice" behaviour.
    expect(event.defaultPrevented).toBe(true);
  });

  it("ignores a second image paste while the first is still processing", async () => {
    render(<App />);
    stubImage({ source: renderQRToCanvas("first"), hang: true });

    const first = makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }]);
    const second = makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }]);
    await dispatchPaste(first);
    await dispatchPaste(second);

    // The second event is claimed (so the native paste can't sneak in) but must
    // not start a second decode.
    expect(second.defaultPrevented).toBe(true);
    expect(logMessages().filter((m) => m.includes("[processImage] start"))).toHaveLength(1);
    expect(logMessages().join("\n")).toContain("[paste] skipped (already processing)");
    await waitFor(() => expect(status().textContent).toBe("Detecting QR code…"));
  });

  it("releases the paste guard after the 5s load timeout", async () => {
    render(<App />);
    stubImage({ source: renderQRToCanvas("never"), hang: true });

    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(logMessages().join("\n")).toContain("timed out loading image, releasing guard");
    expect(status().textContent).toBe("Could not read image from clipboard");

    // A later paste must still work — a stuck guard used to swallow them all.
    vi.unstubAllGlobals();
    await pasteImage(renderQRToCanvas("after timeout"));
    await waitFor(() => expect(textarea().value).toBe("after timeout"));
  });

  it("releases the paste guard when drawing throws", async () => {
    render(<App />);
    await pasteImage(renderQRToCanvas("boom"), { throwOnDraw: true });

    await waitFor(() =>
      expect(status().textContent).toBe("Could not read image from clipboard")
    );
    expect(logMessages().join("\n")).toContain("[processImage] decode failed");

    vi.unstubAllGlobals();
    await pasteImage(renderQRToCanvas("after throw"));
    await waitFor(() => expect(textarea().value).toBe("after throw"));
  });

  it("downscales a very large image before decoding", async () => {
    render(<App />);
    await pasteImage(renderQRToCanvas("large image", 3000));

    await waitFor(() => expect(textarea().value).toBe("large image"));
    // Longest side clamps to 2000 while preserving the square aspect ratio.
    expect(logMessages().join("\n")).toContain('{"w":2000,"h":2000}');
  });

  it("replaces the previous text instead of appending", async () => {
    render(<App />);
    await pasteImage(renderQRToCanvas("first"));
    await waitFor(() => expect(textarea().value).toBe("first"));

    vi.unstubAllGlobals();
    await pasteImage(renderQRToCanvas("second"));

    await waitFor(() => expect(textarea().value).toBe("second"));
  });

  it("revokes the object URL after a successful decode", async () => {
    render(<App />);
    const create = vi.mocked(URL.createObjectURL);
    const revoke = vi.mocked(URL.revokeObjectURL);
    create.mockReturnValueOnce("blob:one");

    await pasteImage(renderQRToCanvas("release me"));
    await waitFor(() => expect(textarea().value).toBe("release me"));

    expect(create).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith("blob:one");
  });

  it("revokes the object URL when the image fails to load", async () => {
    render(<App />);
    const create = vi.mocked(URL.createObjectURL);
    const revoke = vi.mocked(URL.revokeObjectURL);
    create.mockReturnValueOnce("blob:broken");
    stubImage({ source: renderQRToCanvas("unused"), fail: true });

    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );

    await waitFor(() =>
      expect(status().textContent).toBe("Could not read image from clipboard")
    );
    expect(revoke).toHaveBeenCalledWith("blob:broken");
  });

  it("auto-clears the load-error status after 2.5s", async () => {
    render(<App />);
    stubImage({ source: renderQRToCanvas("unused"), fail: true });

    await dispatchPaste(
      makePasteEvent([{ kind: "file", type: "image/png", file: makeImageFile() }])
    );
    await waitFor(() =>
      expect(status().textContent).toBe("Could not read image from clipboard")
    );

    await act(async () => {
      vi.advanceTimersByTime(2500);
    });

    await waitFor(() => expect(status().textContent).toBe(""));
  });

  it("stops listening for pastes after unmount", () => {
    const { unmount } = render(<App />);
    unmount();

    const event = makePasteEvent([
      { kind: "file", type: "image/png", file: makeImageFile() },
    ]);
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(logMessages().join("\n")).not.toContain("[paste]");
  });
});

describe("copy button", () => {
  // userEvent.setup() installs its own clipboard stub, so the component must be
  // given the test's writeText *after* setup — otherwise the component writes
  // through userEvent's stub and the spy never sees the call.
  function setup(writeText: (text: string) => Promise<void>) {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    return user;
  }

  it("does nothing when the textarea is empty", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    render(<App />);
    await user.click(screen.getByTitle("Copy"));

    expect(writeText).not.toHaveBeenCalled();
  });

  it("copies the textarea contents and shows a check mark", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    render(<App />);
    await user.type(textarea(), "copy me");
    await user.click(screen.getByTitle("Copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("copy me"));
    await waitFor(() => expect(screen.getByTitle("Copied!")).toBeInTheDocument());
  });

  it("resets the check mark after 1.5s", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const user = setup(writeText);
    render(<App />);
    await user.type(textarea(), "copy me");
    await user.click(screen.getByTitle("Copy"));
    await waitFor(() => expect(screen.getByTitle("Copied!")).toBeInTheDocument());

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });
    await waitFor(() => expect(screen.getByTitle("Copy")).toBeInTheDocument());
  });

  it("does not mark as copied when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const user = setup(writeText);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    render(<App />);
    await user.type(textarea(), "nope");
    await user.click(screen.getByTitle("Copy"));

    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.queryByTitle("Copied!")).not.toBeInTheDocument();
    expect(consoleError).toHaveBeenCalledWith("Clipboard write failed:", expect.any(Error));
    consoleError.mockRestore();
  });
});
