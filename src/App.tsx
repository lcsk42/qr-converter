import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { Copy, Check } from "lucide-react";
import { isMac } from "./platform";

// ── UTF-8 encoding for QR generation ───────────────────────────────────────────
// qrcode-generator defaults to "default" stringToBytes, which keeps only the low
// 8 bits of each charCode (Latin-1). Any non-ASCII text would be silently
// mangled into garbage bytes. Must be set before qr.addData(), since QR8bitByte
// reads qrcode.stringToBytes at construction time.

qrcode.stringToBytes = qrcode.stringToBytesFuncs["UTF-8"];

// ── Logger ─────────────────────────────────────────────────────────────────────
// Writes to both the browser console and the on-disk log file via Tauri.
// Errors from write_log are silently swallowed so they never break the UI.

function fmt(...args: unknown[]): string {
  return args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
}
function log(...args: unknown[]) {
  const msg = fmt(...args);
  console.log(msg);
  invoke("write_log", { message: msg }).catch(() => {});
}
function logError(...args: unknown[]) {
  const msg = fmt(...args);
  console.error(msg);
  invoke("write_log", { message: `ERROR: ${msg}` }).catch(() => {});
}

// ── QR payload decoding ────────────────────────────────────────────────────────
// jsQR decodes each byte-mode segment with decodeURIComponent and swallows the
// error when the bytes aren't valid UTF-8, so `result.data` comes back empty for
// GBK/GB18030 payloads (common in QR codes from older Chinese/Windows tools that
// don't emit an ECI segment). The raw bytes survive in `result.binaryData`, so
// decode those ourselves: strict UTF-8 first, then fall back to GB18030.

export function decodePayload(bytes: Uint8ClampedArray | number[]): string {
  const buf = new Uint8Array(bytes).buffer as ArrayBuffer;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder("gb18030").decode(buf);
  }
}

type AppState = "idle" | "processing" | "not-found" | "decode-error" | "error";

export default function App() {
  const [text, setText] = useState("");
  const [qrReady, setQrReady] = useState(false);
  const [qrError, setQrError] = useState("");
  const [copied, setCopied] = useState(false);
  const [appState, setAppState] = useState<AppState>("idle");

  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const processingRef = useRef(false);

  // ── QR generation ──────────────────────────────────────────────────────────

  const renderQR = useCallback((content: string) => {
    // The canvas is always mounted (see the JSX), so this ref is always set.
    // State is still updated before drawing so an overflow error can be cleared
    // by the next valid edit — that used to be impossible when the error text
    // replaced the canvas and left this ref null.
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    const clear = () => {
      ctx.clearRect(0, 0, 420, 420);
    };

    if (!content.trim()) {
      clear();
      setQrReady(false);
      setQrError("");
      return;
    }

    let qr: ReturnType<typeof qrcode>;
    try {
      qr = qrcode(0, "M");
      qr.addData(content);
      qr.make();
    } catch {
      clear();
      setQrReady(false);
      setQrError("Content exceeds QR code capacity");
      return;
    }

    const moduleCount = qr.getModuleCount();
    const cellSize = Math.floor(388 / moduleCount);
    const offset = Math.floor((388 - moduleCount * cellSize) / 2) + 16;

    canvas.width = 420;
    canvas.height = 420;

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, 420, 420);

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

    setQrError("");
    setQrReady(true);
  }, []);

  useEffect(() => {
    renderQR(text);
  }, [text, renderQR]);

  // ── Image → jsQR ───────────────────────────────────────────────────────────

  const processImage = useCallback((file: File) => {
    log("[processImage] start", { name: file.name, type: file.type, size: file.size });
    setAppState("processing");

    const url = URL.createObjectURL(file);
    const img = new Image();

    // Clear the paste guard exactly once, whether decoding succeeded, failed,
    // or the image never loaded. Without the timeout, a broken blob would leave
    // processingRef stuck at true and swallow every later paste.
    const releaseGuard = () => {
      processingRef.current = false;
    };
    const guardTimeout = setTimeout(() => {
      logError("[processImage] timed out loading image, releasing guard");
      URL.revokeObjectURL(url);
      releaseGuard();
      setAppState("error");
      setTimeout(() => setAppState("idle"), 2500);
    }, 5000);

    img.onload = () => {
      clearTimeout(guardTimeout);
      try {
        const MAX_DIM = 2000;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        log("[processImage] image loaded", { naturalWidth: w, naturalHeight: h });

        if (w > MAX_DIM || h > MAX_DIM) {
          const scale = MAX_DIM / Math.max(w, h);
          w = Math.floor(w * scale);
          h = Math.floor(h * scale);
          log("[processImage] scaled down to", { w, h });
        }

        const offscreen = document.createElement("canvas");
        offscreen.width = w;
        offscreen.height = h;
        const ctx = offscreen.getContext("2d")!;
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);

        const imageData = ctx.getImageData(0, 0, w, h);
        log("[processImage] running jsQR on", { w, h, dataLength: imageData.data.length });
        const result = jsQR(imageData.data, w, h);
        log(
          "[processImage] jsQR result",
          result
            ? { data: result.data, byteLength: result.binaryData.length }
            : null
        );

        // Decode the raw payload bytes rather than result.data: jsQR leaves
        // `data` empty whenever the bytes aren't valid UTF-8 (see decodePayload).
        // An empty result after that is a genuine decode failure, not "no QR".
        const decoded = result ? decodePayload(result.binaryData) : "";
        if (result && decoded !== result.data) {
          log("[processImage] payload is not UTF-8, decoded via GB18030 fallback");
        }
        log("[processImage] decoded text length", decoded.length);

        if (result && decoded !== "") {
          setText(decoded);
          setAppState("idle");
        } else {
          setAppState(result ? "decode-error" : "not-found");
          setTimeout(() => setAppState("idle"), 2500);
        }
      } catch (e) {
        logError("[processImage] decode failed", e);
        setAppState("error");
        setTimeout(() => setAppState("idle"), 2500);
      } finally {
        releaseGuard();
      }
    };

    img.onerror = (e) => {
      clearTimeout(guardTimeout);
      logError("[processImage] image load error", e);
      URL.revokeObjectURL(url);
      setAppState("error");
      releaseGuard();
      setTimeout(() => setAppState("idle"), 2500);
    };

    img.src = url;
  }, []);

  // ── Global paste listener ──────────────────────────────────────────────────
  //
  // Two complementary paths:
  //
  //  1. keydown Ctrl/Cmd+V  →  navigator.clipboard.read()
  //     Primary path on Windows. WebView2's ClipboardEvent.clipboardData
  //     sometimes doesn't expose image items, but the Clipboard API works
  //     reliably. processingRef prevents a second invocation from path 2.
  //     Deliberately NOT registered on macOS: there the paste event is
  //     reliable, and reading the clipboard here races the default paste
  //     action, so the first ⌘V appeared to be swallowed.
  //
  //  2. paste event  →  ClipboardEvent.clipboardData
  //     The only path on macOS, and the fallback on Windows.

  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (!((e.ctrlKey || e.metaKey) && e.key === "v")) return;
      log("[keydown] Ctrl/Cmd+V detected, processingRef=", processingRef.current);
      if (processingRef.current) return;

      try {
        log("[keydown] calling navigator.clipboard.read()...");
        const clipItems = await navigator.clipboard.read();
        log("[keydown] clipboard.read() returned", clipItems.length, "item(s)");

        for (let i = 0; i < clipItems.length; i++) {
          const clipItem = clipItems[i];
          log(`[keydown] item[${i}] types:`, clipItem.types);
          const imgType = clipItem.types.find((t) => t.startsWith("image/"));
          if (imgType) {
            log("[keydown] found image type:", imgType);
            const blob = await clipItem.getType(imgType);
            log("[keydown] blob size:", blob.size, "type:", blob.type);
            processingRef.current = true;
            processImage(new File([blob], "paste", { type: imgType }));
            return;
          }
        }
        log("[keydown] no image type found in clipboard items");
      } catch (err) {
        logError("[keydown] clipboard.read() failed:", err);
      }
    };

    const handlePaste = (e: ClipboardEvent) => {
      log("[paste] event fired, processingRef=", processingRef.current);

      const items = Array.from(e.clipboardData?.items ?? []);
      log("[paste] clipboardData.items count:", items.length);
      items.forEach((item, i) => {
        log(`[paste] item[${i}] kind=${item.kind} type=${item.type}`);
      });

      const imageItem = items.find((item) => item.type.startsWith("image/"));
      if (!imageItem) {
        log("[paste] no image item found, letting text paste through");
        return;
      }

      // Always claim the event for an image, even when another path is already
      // handling it. Letting the default paste through here would have the
      // native paste and our pipeline both touch the clipboard.
      e.preventDefault();
      if (processingRef.current) {
        log("[paste] skipped (already processing)");
        return;
      }

      log("[paste] found image item:", imageItem.type);
      const file = imageItem.getAsFile();
      log("[paste] getAsFile():", file ? `size=${file.size}` : "null");
      if (file) {
        processingRef.current = true;
        processImage(file);
      }
    };

    // macOS relies on the paste event alone; only Windows needs the
    // clipboard.read() path.
    if (!isMac) document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("paste", handlePaste);
    };
  }, [processImage]);

  // ── Copy ───────────────────────────────────────────────────────────────────

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Clipboard write failed:", e);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const pasteKey = isMac ? "⌘V" : "Ctrl+V";

  const statusText: Partial<Record<AppState, string>> = {
    processing: "Detecting QR code…",
    "not-found": "No QR code found in pasted image",
    "decode-error": "QR code found, but its content isn't valid UTF-8 text",
    error: "Could not read image from clipboard",
  };

  const statusColor: Partial<Record<AppState, string>> = {
    processing: "text-zinc-400",
    "not-found": "text-orange-500",
    "decode-error": "text-orange-500",
    error: "text-red-500",
  };

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4 p-6">
      {/* Textarea with copy button */}
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Enter text to generate a QR code"
          className="resize-none p-3 pr-10 text-sm text-zinc-900 placeholder-zinc-400 outline-none focus:border-zinc-400 transition-colors"
          style={{
            width: 800,
            height: 160,
            border: "1px solid #e4e4e7",
            borderRadius: 6,
          }}
        />
        <button
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy"}
          className="absolute top-2 right-2 p-1.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>

      {/* Status line */}
      <p className={`text-xs h-4 transition-colors ${statusColor[appState] ?? "text-transparent"}`}>
        {statusText[appState] ?? ""}
      </p>

      {/* QR Code display */}
      <div
        className="relative flex items-center justify-center"
        style={{
          width: 420,
          height: 420,
          border: "1px dashed #d4d4d8",
          borderRadius: 6,
          boxSizing: "border-box",
        }}
      >
        {/* Mounted unconditionally: unmounting it on error left
            qrCanvasRef.current null, so renderQR could never clear the error. */}
        <canvas
          ref={qrCanvasRef}
          width={420}
          height={420}
          className={qrReady ? undefined : "invisible"}
        />
        {qrError ? (
          <p className="absolute inset-0 flex items-center justify-center text-red-500 text-sm text-center px-4">
            {qrError}
          </p>
        ) : !qrReady ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 select-none">
            <p className="text-zinc-400 text-sm">QR code will appear here</p>
            <p className="text-zinc-300 text-xs text-center leading-relaxed">
              Take a screenshot, then press{" "}
              <kbd className="px-1.5 py-0.5 text-xs bg-zinc-100 text-zinc-500 rounded border border-zinc-200 font-mono">
                {pasteKey}
              </kbd>{" "}
              to detect QR codes
            </p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
