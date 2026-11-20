import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ChangeEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { Copy, Check, ChevronLeft, ChevronRight, Maximize2, Minimize2, Shrink } from "lucide-react";
import { isMac } from "./platform";
import {
  decodePayload,
  decodeQRCodes,
  fitImageDimensions,
  initQRDecoder,
  sortByPosition,
  type DecodedQR,
} from "./decode";
import {
  SEGMENT_DATA_BYTES,
  createQRPlan,
  encodeSegment,
  parseSegment,
  reassembleSegments,
  type ParsedSegment,
} from "./segments";
import {
  SHEET_CARD_CSS,
  SHEET_CARD_PADDING,
  SINGLE_QR_CSS,
  SINGLE_QR_PADDING,
  clearQRCanvas,
  getDevicePixelRatio,
  renderQRToCanvas,
} from "./qrRender";

// Re-exported so existing callers/tests can keep importing it from App.
export { decodePayload } from "./decode";

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

// ── Multi-QR sheet layout ────────────────────────────────────────────────────
// 4 × 3 cards of 210 CSS px fit a 1024×768 window (the app's minimum size) even
// with a compact capture toolbar. Each page is one screenshot.

const SHEET_COLUMNS = 4;
const SHEET_PAGE_SIZE = SHEET_COLUMNS * 3;
const SHEET_GAP = 8;
const MAX_PENDING_TRANSFERS = 3;

type AppState =
  | "idle"
  | "processing"
  | "not-found"
  | "decode-error"
  | "error"
  | "partial"
  | "restored"
  | "crc-error"
  | "multiple";

interface PendingTransfer {
  crc: number;
  total: number;
  parts: Map<number, Uint8Array>;
  updatedAt: number;
}

interface PendingSummary {
  total: number;
  received: number;
  missing: number[];
}

function summarizePending(entry: PendingTransfer): PendingSummary {
  const missing: number[] = [];
  for (let i = 0; i < entry.total; i++) {
    if (!entry.parts.has(i)) missing.push(i);
  }
  return {
    total: entry.total,
    received: entry.parts.size,
    missing,
  };
}

function latestSummary(pending: Map<number, PendingTransfer>): PendingSummary | null {
  let latest: PendingTransfer | null = null;
  for (const entry of pending.values()) {
    if (!latest || entry.updatedAt >= latest.updatedAt) latest = entry;
  }
  return latest ? summarizePending(latest) : null;
}

function partialMessage(summary: PendingSummary): string {
  const shown = summary.missing
    .slice(0, 10)
    .map((index) => index + 1)
    .join(", ");
  const more =
    summary.missing.length > 10 ? ` (+${summary.missing.length - 10} more)` : "";
  return `Received ${summary.received} of ${summary.total} segments — missing ${shown}${more}. Paste the rest in any order.`;
}

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(getDevicePixelRatio);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const update = () => setDpr(getDevicePixelRatio());
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return dpr;
}

// ── Sheet card / grid ────────────────────────────────────────────────────────

interface SheetGridProps {
  chunks: string[];
  startIndex: number;
  total: number;
  crc: number;
  dpr: number;
}

function SheetCard({
  content,
  index,
  total,
  dpr,
}: {
  content: string;
  index: number;
  total: number;
  dpr: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rendered = renderQRToCanvas(canvas, content, {
      cssSize: SHEET_CARD_CSS,
      paddingCss: SHEET_CARD_PADDING,
      dpr,
    });
    setFailed(!rendered);
  }, [content, dpr]);

  return (
    <div
      className="relative"
      style={{ width: SHEET_CARD_CSS, height: SHEET_CARD_CSS }}
    >
      <canvas
        ref={canvasRef}
        width={SHEET_CARD_CSS}
        height={SHEET_CARD_CSS}
        data-segment-index={index}
        aria-label={`QR code ${index + 1} of ${total}`}
        style={{ width: SHEET_CARD_CSS, height: SHEET_CARD_CSS }}
        className={failed ? "invisible" : undefined}
      />
      {failed ? (
        <p className="absolute inset-0 flex items-center justify-center px-2 text-center text-xs text-red-500">
          Could not render QR code
        </p>
      ) : null}
    </div>
  );
}

function SheetGrid({ chunks, startIndex, total, crc, dpr }: SheetGridProps) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${SHEET_COLUMNS}, ${SHEET_CARD_CSS}px)`,
        gap: SHEET_GAP,
      }}
    >
      {chunks.map((chunk, offset) => {
        const index = startIndex + offset;
        return (
          <SheetCard
            key={index}
            content={encodeSegment(chunk, index, total, crc)}
            index={index}
            total={total}
            dpr={dpr}
          />
        );
      })}
    </div>
  );
}

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);
  const [appState, setAppState] = useState<AppState>("idle");
  const [statusNote, setStatusNote] = useState("");
  const [renderError, setRenderError] = useState("");
  const [page, setPage] = useState(0);
  const [captureMode, setCaptureMode] = useState(false);

  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const processingRef = useRef(false);
  const pendingRef = useRef(new Map<number, PendingTransfer>());
  const idleTimerRef = useRef<number | null>(null);

  const dpr = useDevicePixelRatio();
  const plan = useMemo(() => createQRPlan(text), [text]);
  const isSheet = plan.kind === "sheet";

  const pageCount = isSheet ? Math.ceil(plan.chunks.length / SHEET_PAGE_SIZE) : 0;
  const safePage = pageCount === 0 ? 0 : Math.min(page, pageCount - 1);
  const pageStart = safePage * SHEET_PAGE_SIZE;
  const pageChunks = isSheet
    ? plan.chunks.slice(pageStart, pageStart + SHEET_PAGE_SIZE)
    : [];
  const qrReady = plan.kind === "single" && renderError === "";

  useEffect(() => {
    void initQRDecoder().catch((error) => {
      console.error("[decode] zxing preload failed; jsQR fallback will be used", error);
    });
  }, []);

  useEffect(() => {
    setPage(0);
  }, [plan]);

  useEffect(() => {
    if (!isSheet) setCaptureMode(false);
  }, [isSheet]);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    };
  }, []);

  // ── Transient status ───────────────────────────────────────────────────────

  const setTransientState = useCallback(
    (state: AppState, note: string, clearAfterMs?: number) => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
      setAppState(state);
      setStatusNote(note);
      if (clearAfterMs !== undefined) {
        idleTimerRef.current = window.setTimeout(() => {
          idleTimerRef.current = null;
          setAppState("idle");
          setStatusNote("");
        }, clearAfterMs);
      }
    },
    []
  );

  // ── Single-QR rendering ────────────────────────────────────────────────────

  useEffect(() => {
    const canvas = qrCanvasRef.current;
    if (!canvas) return;

    if (plan.kind === "single") {
      const rendered = renderQRToCanvas(canvas, plan.content, {
        cssSize: SINGLE_QR_CSS,
        paddingCss: SINGLE_QR_PADDING,
        dpr,
      });
      setRenderError(rendered ? "" : "Content exceeds QR code capacity");
    } else {
      clearQRCanvas(canvas, { cssSize: SINGLE_QR_CSS, dpr });
      setRenderError(plan.kind === "error" ? plan.message : "");
    }
  }, [plan, dpr]);

  // ── Decoded results → text / segment accumulator ──────────────────────────

  const handleDecoded = useCallback(
    (results: DecodedQR[]) => {
      const segments: ParsedSegment[] = [];
      const plain: DecodedQR[] = [];

      for (const result of results) {
        const segment = parseSegment(result.bytes);
        if (segment) segments.push(segment);
        else plain.push(result);
      }

      log("[processImage] decoded results", {
        total: results.length,
        segments: segments.length,
        plain: plain.length,
      });

      if (segments.length > 0) {
        const pending = pendingRef.current;
        let inconsistent = false;

        for (const segment of segments) {
          let entry = pending.get(segment.crc);
          if (!entry) {
            if (pending.size >= MAX_PENDING_TRANSFERS) {
              let oldest: PendingTransfer | null = null;
              for (const candidate of pending.values()) {
                if (!oldest || candidate.updatedAt < oldest.updatedAt) oldest = candidate;
              }
              if (oldest) pending.delete(oldest.crc);
            }
            entry = {
              crc: segment.crc,
              total: segment.total,
              parts: new Map(),
              updatedAt: Date.now(),
            };
            pending.set(segment.crc, entry);
          }

          if (entry.total !== segment.total) {
            pending.delete(segment.crc);
            inconsistent = true;
            break;
          }

          const existing = entry.parts.get(segment.index);
          if (existing) {
            if (
              existing.length !== segment.data.length ||
              existing.some((byte, index) => byte !== segment.data[index])
            ) {
              pending.delete(entry.crc);
              inconsistent = true;
              break;
            }
          } else {
            entry.parts.set(segment.index, segment.data);
          }
          entry.updatedAt = Date.now();
        }

        if (inconsistent) {
          setTransientState(
            "crc-error",
            "Segment set is inconsistent — paste the complete set again.",
            4000
          );
          logError("[processImage] inconsistent segment set");
          return;
        }

        for (const entry of pending.values()) {
          if (entry.parts.size !== entry.total) continue;

          const parsed = [...entry.parts.entries()].map(([index, data]) => ({
            crc: entry.crc,
            index,
            total: entry.total,
            data,
          }));
          const result = reassembleSegments(parsed);
          pending.delete(entry.crc);

          if (result.ok) {
            setCaptureMode(false);
            setText(result.text);
            setTransientState(
              "restored",
              `Restored ${result.total} segments (${result.bytes.length.toLocaleString("en-US")} bytes)`,
              4000
            );
            log("[processImage] restored segments", {
              segments: result.total,
              bytes: result.bytes.length,
            });
          } else {
            const message =
              result.reason === "crc" || result.reason === "encoding"
                ? "Segment checksum mismatch — paste the complete set again."
                : "Segment set is inconsistent — paste the complete set again.";
            setTransientState("crc-error", message, 4000);
            logError("[processImage] segment reassembly failed", result.reason);
          }
          return;
        }

        const summary = latestSummary(pending);
        if (summary) setTransientState("partial", partialMessage(summary));
        return;
      }

      // No segments. Preserve the original single-QR behaviour.
      if (plain.length === 0) {
        setTransientState("not-found", "", 2500);
        return;
      }

      const ordered = plain.length === 1 ? plain : sortByPosition(plain);
      const chosen = ordered[0];
      const decoded = decodePayload(chosen.bytes);
      if (decoded !== chosen.text) {
        log("[processImage] payload is not UTF-8, decoded via GB18030 fallback");
      }
      log("[processImage] decoded text length", decoded.length);

      if (decoded === "") {
        setTransientState("decode-error", "", 2500);
        return;
      }

      pendingRef.current.clear();
      setText(decoded);

      if (plain.length > 1) {
        setTransientState(
          "multiple",
          `Found ${plain.length} QR codes; showing the first one.`,
          2500
        );
      } else {
        setTransientState("idle", "");
      }
    },
    [setTransientState]
  );

  // ── Image → QR codes ──────────────────────────────────────────────────────

  const processImage = useCallback(
    (file: File) => {
      log("[processImage] start", {
        name: file.name,
        type: file.type,
        size: file.size,
      });
      setCaptureMode(false);
      setTransientState("processing", "");

      const url = URL.createObjectURL(file);
      const img = new Image();
      let revoked = false;
      const revoke = () => {
        if (revoked) return;
        revoked = true;
        URL.revokeObjectURL(url);
      };

      // A late onload after the load timeout (or after onerror) must not start
      // decoding with a guard that has already been released.
      let settled = false;
      const claim = () => {
        if (settled) return false;
        settled = true;
        return true;
      };

      const releaseGuard = () => {
        processingRef.current = false;
      };

      const guardTimeout = window.setTimeout(() => {
        if (!claim()) return;
        logError("[processImage] timed out loading image, releasing guard");
        revoke();
        releaseGuard();
        setTransientState("error", "", 2500);
      }, 5000);

      img.onload = () => {
        if (!claim()) return;
        window.clearTimeout(guardTimeout);
        const naturalWidth = img.naturalWidth;
        const naturalHeight = img.naturalHeight;
        log("[processImage] image loaded", { naturalWidth, naturalHeight });

        void (async () => {
          try {
            const fitted = fitImageDimensions(naturalWidth, naturalHeight);
            if (fitted.scaled) {
              log("[processImage] scaled down to", {
                w: fitted.width,
                h: fitted.height,
              });
            }

            const offscreen = document.createElement("canvas");
            offscreen.width = fitted.width;
            offscreen.height = fitted.height;
            const ctx = offscreen.getContext("2d")!;
            ctx.drawImage(img, 0, 0, fitted.width, fitted.height);
            revoke();

            const imageData = ctx.getImageData(0, 0, fitted.width, fitted.height);
            log("[processImage] decoding", {
              w: fitted.width,
              h: fitted.height,
            });

            const results = await decodeQRCodes(imageData);
            handleDecoded(results);
          } catch (error) {
            logError("[processImage] decode failed", error);
            setTransientState("error", "", 2500);
          } finally {
            revoke();
            releaseGuard();
          }
        })();
      };

      img.onerror = (e) => {
        if (!claim()) return;
        window.clearTimeout(guardTimeout);
        logError("[processImage] image load error", e);
        revoke();
        setTransientState("error", "", 2500);
        releaseGuard();
      };

      img.src = url;
    },
    [handleDecoded, setTransientState]
  );

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
      window.setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.error("Clipboard write failed:", e);
    }
  };

  // "Compress" removes every whitespace character: spaces, tabs, newlines,
  // full-width/ideographic spaces, NBSP, etc. JavaScript's \s covers Unicode
  // space separators but not zero-width joiners, so emoji sequences survive.
  const handleCompressWhitespace = () => {
    if (!/\s/.test(text)) return;
    setText(text.replace(/\s+/g, ""));
    pendingRef.current.clear();
    setTransientState("idle", "");
  };

  const handleTextChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value);
    pendingRef.current.clear();
    setTransientState("idle", "");
  };

  const goToPreviousPage = () => setPage(Math.max(0, safePage - 1));
  const goToNextPage = () => setPage(Math.min(pageCount - 1, safePage + 1));

  // ── Status presentation ───────────────────────────────────────────────────

  const pasteKey = isMac ? "⌘V" : "Ctrl+V";

  const staticStatusText: Partial<Record<AppState, string>> = {
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
    partial: "text-zinc-500",
    restored: "text-emerald-600",
    "crc-error": "text-red-500",
    multiple: "text-orange-500",
  };

  const statusText = statusNote || staticStatusText[appState] || "";

  const editor = (
    <div className="relative">
      <textarea
        value={text}
        onChange={handleTextChange}
        placeholder="Enter text to generate a QR code"
        className="resize-none p-3 pr-10 text-sm text-zinc-900 placeholder-zinc-400 outline-none focus:border-zinc-400 transition-colors"
        style={{
          width: 800,
          height: 160,
          border: "1px solid #e4e4e7",
          borderRadius: 6,
        }}
      />
      <div className="absolute top-2 right-2 flex flex-col items-center gap-1">
        <button
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy"}
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <button
          onClick={handleCompressWhitespace}
          title="Compress whitespace"
          className="p-1.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100 transition-colors"
        >
          <Shrink size={16} />
        </button>
      </div>
    </div>
  );

  const statusLine = (
    <p
      className={`text-xs min-h-4 max-w-[860px] text-center transition-colors ${
        statusColor[appState] ?? "text-transparent"
      }`}
    >
      {statusText}
    </p>
  );

  // ── Capture mode ──────────────────────────────────────────────────────────
  // Hiding the editor/status leaves enough vertical room for a clean 4×3
  // page screenshot at the app's minimum window size.

  if (captureMode && plan.kind === "sheet") {
    return (
      <div className="fixed inset-0 z-50 flex flex-col gap-2 bg-white p-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
          <span>
            {plan.chunks.length} QR codes · Page {safePage + 1} / {pageCount} · Codes{" "}
            {pageStart + 1}–{pageStart + pageChunks.length} of {plan.chunks.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={goToPreviousPage}
              disabled={safePage === 0}
              aria-label="Previous page"
              className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={goToNextPage}
              disabled={safePage >= pageCount - 1}
              aria-label="Next page"
              className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30"
            >
              <ChevronRight size={16} />
            </button>
            <button
              onClick={() => setCaptureMode(false)}
              className="ml-2 flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-100"
            >
              <Minimize2 size={14} />
              Exit capture mode
            </button>
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center overflow-auto">
          <SheetGrid
            chunks={pageChunks}
            startIndex={pageStart}
            total={plan.chunks.length}
            crc={plan.crc}
            dpr={dpr}
          />
        </div>
      </div>
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center gap-4 p-6">
      {editor}

      {statusLine}

      {plan.kind === "sheet" ? (
        <div className="flex flex-col items-center gap-3">
          <div className="flex flex-wrap items-center justify-center gap-3 text-xs text-zinc-500">
            <span>
              {plan.chunks.length} QR codes ·{" "}
              {plan.totalBytes.toLocaleString("en-US")} bytes ·{" "}
              {SEGMENT_DATA_BYTES.toLocaleString("en-US")} bytes max each
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={goToPreviousPage}
                disabled={safePage === 0}
                aria-label="Previous page"
                className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30"
              >
                <ChevronLeft size={14} />
              </button>
              <span>
                Page {safePage + 1} / {pageCount} · Codes {pageStart + 1}–
                {pageStart + pageChunks.length} of {plan.chunks.length}
              </span>
              <button
                onClick={goToNextPage}
                disabled={safePage >= pageCount - 1}
                aria-label="Next page"
                className="rounded p-1 hover:bg-zinc-100 disabled:opacity-30"
              >
                <ChevronRight size={14} />
              </button>
            </div>
            <button
              onClick={() => setCaptureMode(true)}
              className="flex items-center gap-1 rounded px-2 py-1 hover:bg-zinc-100"
            >
              <Maximize2 size={14} />
              Capture mode
            </button>
          </div>
          <SheetGrid
            chunks={pageChunks}
            startIndex={pageStart}
            total={plan.chunks.length}
            crc={plan.crc}
            dpr={dpr}
          />
        </div>
      ) : (
        <div
          className="relative flex items-center justify-center"
          style={{
            width: SINGLE_QR_CSS,
            height: SINGLE_QR_CSS,
            border: "1px dashed #d4d4d8",
            borderRadius: 6,
            boxSizing: "border-box",
          }}
        >
          {/* Mounted unconditionally in single mode: unmounting it on error
              would leave qrCanvasRef null, so renderQR could never clear the
              error once the text shrinks again. */}
          <canvas
            ref={qrCanvasRef}
            width={SINGLE_QR_CSS}
            height={SINGLE_QR_CSS}
            style={{ width: SINGLE_QR_CSS, height: SINGLE_QR_CSS }}
            className={qrReady ? undefined : "invisible"}
          />
          {renderError ? (
            <p className="absolute inset-0 flex items-center justify-center text-red-500 text-sm text-center px-4">
              {renderError}
            </p>
          ) : !qrReady && plan.kind === "empty" ? (
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
      )}
    </div>
  );
}
