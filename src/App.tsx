import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { Copy, Check } from "lucide-react";

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

type AppState = "idle" | "processing" | "not-found" | "error";

const isMac =
  typeof navigator !== "undefined" &&
  /mac/i.test(navigator.userAgent) &&
  !/iphone|ipad/i.test(navigator.userAgent);

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
    const canvas = qrCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;

    if (!content.trim()) {
      ctx.clearRect(0, 0, 420, 420);
      setQrReady(false);
      setQrError("");
      return;
    }

    try {
      const qr = qrcode(0, "M");
      qr.addData(content);
      qr.make();

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

      setQrReady(true);
      setQrError("");
    } catch {
      if (qrCanvasRef.current) {
        qrCanvasRef.current.getContext("2d")!.clearRect(0, 0, 420, 420);
      }
      setQrReady(false);
      setQrError("Content exceeds QR code capacity");
    }
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

    img.onload = () => {
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
      log("[processImage] jsQR result", result ? { data: result.data } : null);

      if (result) {
        setText(result.data);
        setAppState("idle");
      } else {
        setAppState("not-found");
        setTimeout(() => setAppState("idle"), 2500);
      }
      processingRef.current = false;
    };

    img.onerror = (e) => {
      logError("[processImage] image load error", e);
      URL.revokeObjectURL(url);
      setAppState("error");
      processingRef.current = false;
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
  //
  //  2. paste event  →  ClipboardEvent.clipboardData
  //     Primary path on macOS (and fallback on Windows when path 1 skips
  //     because processingRef is already set).

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
      if (processingRef.current) {
        log("[paste] skipped (already processing)");
        return;
      }

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

      e.preventDefault();
      log("[paste] found image item:", imageItem.type);
      const file = imageItem.getAsFile();
      log("[paste] getAsFile():", file ? `size=${file.size}` : "null");
      if (file) {
        processingRef.current = true;
        processImage(file);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
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
    error: "Could not read image from clipboard",
  };

  const statusColor: Partial<Record<AppState, string>> = {
    processing: "text-zinc-400",
    "not-found": "text-orange-500",
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
        {statusText[appState] ?? "placeholder"}
      </p>

      {/* QR Code display */}
      <div
        className="flex items-center justify-center"
        style={{
          width: 420,
          height: 420,
          border: "1px dashed #d4d4d8",
          borderRadius: 6,
          boxSizing: "border-box",
        }}
      >
        {qrError ? (
          <p className="text-red-500 text-sm text-center px-4">{qrError}</p>
        ) : qrReady ? (
          <canvas ref={qrCanvasRef} width={420} height={420} />
        ) : (
          <>
            <canvas ref={qrCanvasRef} width={420} height={420} className="hidden" />
            <div className="flex flex-col items-center gap-3 select-none">
              <p className="text-zinc-400 text-sm">QR code will appear here</p>
              <p className="text-zinc-300 text-xs text-center leading-relaxed">
                Take a screenshot, then press{" "}
                <kbd className="px-1.5 py-0.5 text-xs bg-zinc-100 text-zinc-500 rounded border border-zinc-200 font-mono">
                  {pasteKey}
                </kbd>{" "}
                to detect QR codes
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
