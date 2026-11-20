# CLAUDE.md

This file provides guidance to CC (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install
npm run tauri dev      # run the desktop app (Vite dev server on :1420 + Tauri window)
npm run tauri build    # production build
npm run dev            # frontend only in a browser (Tauri IPC calls fail silently there)
npm run build          # tsc + vite build
npx tsc --noEmit       # type-check frontend only
cd src-tauri && cargo check   # check Rust only
npm test               # vitest, frontend (jsdom)
npm run test:watch     # vitest in watch mode
npm run test:rust      # cargo test, backend
```

No linter or formatter is configured.

Packaging: `npm run build:mac` keeps the original 0.2.0 macOS method — a **universal** (Apple Silicon + Intel) `.dmg` (requires both apple-* rustup targets). `npm run build:win` produces the **online** Windows x64 NSIS `.exe`: it does not embed WebView2, but uses the bootstrapper when WebView2 is missing or older than `109.0.1518.140` (internet required). `npm run build:win:offline` produces the **offline** NSIS `.exe` by merging `src-tauri/tauri.offline.conf.json`: it embeds Microsoft's x64 WebView2 offline installer (≈294 MB as of 2026, so the final installer is ≈300 MB) and installs it silently only when missing/outdated, with no network needed. The offline variant installs per-machine and therefore needs admin rights; the online variant keeps the default current-user mode. Target floor: Windows 10 1809/LTSC. CI (`.github/workflows/build.yml`) runs on `v*` tags or manual dispatch, builds macOS universal + Windows online + Windows offline with `tauri-action@v1`, names them via `releaseAssetNamePattern` (`…_universal.dmg`, `…windows-x64-online-setup.exe`, `…windows-x64-offline-setup.exe`), and creates a **draft** GitHub release. Do not switch the offline variant to `fixedRuntime` (≈180+ MB, manually updated) unless Windows 7/8.1 support is explicitly required.

### Tests

`vitest.config.ts` (`environment: jsdom`) drives `src/**/*.test.ts(x)`; Rust tests live in `#[cfg(test)] mod tests` in `lib.rs`.

| File | Covers |
|------|--------|
| `src/segments.test.ts` | 18-byte envelope, CRC32, UTF-8-safe splitting, 255-segment/max-content limits, out-of-order reassembly |
| `src/decode.test.ts` | zxing multi-code decoding, image pixel-budget helper |
| `src/qrRender.test.ts` | DPR 1/1.25/1.5/2 rendering, max-size V40 cards, clear/overflow |
| `src/decodePayload.test.ts` | UTF-8 → GB18030 fallback, empty/garbage payloads |
| `src/App.qr.test.tsx` | single ↔ segment-sheet boundary (2,331 B), segment headers, limit error, empty/whitespace |
| `src/App.sheet.test.tsx` | pagination + capture mode, out-of-order multi-page restore, CRC failure |
| `src/App.paste.test.tsx` | paste → decode (single, multi-code, GBK), statuses, guard/refcount, copy / compress-whitespace buttons |
| `src/App.mac.test.tsx` / `src/App.win.test.tsx` | which paste paths each platform registers |

Two things make the component tests able to run in jsdom without faking the QR pipeline itself:

- `src/test/setup.ts` gives `HTMLCanvasElement.getContext` a real `@napi-rs/canvas` backing, so drawn pixels can be read back and fed to zxing/jsQR. Tests therefore do a genuine round trip (draw → `getImageData` → decode) rather than asserting on `fillRect` call counts. It also mocks `@tauri-apps/api/core`'s `invoke`, injects the zxing wasm binary via `prepareZXingModule({ wasmBinary })`, and provides `installPastePipeline()` — processImage's *offscreen* canvas synthesises the pasted image's pixels through it.
- `src/platform.ts` exists only so `isMac` can be pinned with `vi.mock("./platform")`; the mac/win test files would otherwise be unreachable on one host OS or the other.

`src/test/gbk.ts` derives GBK byte sequences by inverting Node's own GB18030 `TextDecoder` instead of hard-coding a hex table (hand-written values were wrong the first time). Use it rather than pasting hex when adding fixtures.

Unit tests style: prefer asserting user-visible behaviour (`textarea.value`, rendered status text, decodability) over internal state.

## Architecture

Tauri 2 desktop app: React 18 + TypeScript + Vite + Tailwind frontend, Rust backend.

| Layer | Path |
|-------|------|
| App UI, paste pipeline, segment accumulator | `src/App.tsx` |
| Multi-QR envelope / split / CRC / reassembly | `src/segments.ts` |
| zxing-wasm multi-code decoder + jsQR fallback | `src/decode.ts` |
| DPR-aware QR drawing | `src/qrRender.ts` |
| Backend (all Tauri commands) | `src-tauri/src/lib.rs` |
| `main.rs` is just `app_lib::run()` | `src-tauri/src/main.rs` |
| Tauri config / capabilities | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |

Window is fixed to a 1024×768 minimum. The UI is a textarea, a status line, and either a 420×420 single-QR canvas or a paginated 4×3 sheet (12 cards of 210 px each; “Capture mode” hides the editor for clean page screenshots).

### Two features

1. **Text → QR (pure frontend).** `createQRPlan()` in `segments.ts` decides between the single-QR and multi-QR paths:
   - ≤ 2,331 UTF-8 bytes → one QR. `qrRender.ts` uses `qrcode-generator` (level `M`, auto version) and draws modules manually.
   - Larger → split into segments (see below). The sheet shows 4×3 cards per page and the embedded index defines the order; the UI offers pagination and a capture mode.
   - Rendering is DPR-aware: canvas backing = CSS size × `devicePixelRatio`, and modules use an integer device-pixel cell size. This keeps 1–2 px modules crisp under 125%/150% OS scaling. Do not replace it with a fixed 420 backing store.
   - Content over 589,815 bytes (255 segments) → an error. The single canvas stays mounted so the error can clear when the text shrinks.
2. **Image → text (paste).** `processImage` draws the pasted image into an offscreen canvas, then `decodeQRCodes()` (`decode.ts`) runs **zxing-wasm** and returns *all* QR codes in the image (jsQR only returns one). Images are capped at a 24 MP pixel budget, not the old 2,000 px longest side: a dense card has 1-device-pixel modules and downscaling destroys them. Results are written into `text` (single/plain path) or accumulated per transfer (segmented path). Failures set `appState` to `not-found`/`error`; statuses auto-reset after 2.5 s, restored/checksum statuses after 4 s.

### Multi-QR protocol (`src/segments.ts`)

Each segment starts with an 18-byte ASCII header, followed by a UTF-8 slice of the original text:

```
0..3    "QRS1"                                      magic + version
4..11   CRC32 of the complete UTF-8 content         transfer id + integrity check
12..14  segment index, 3 decimal digits (000..254)
15..17  segment total, 3 decimal digits (002..255)
18..    segment data
```

- Segment capacity = 2,331 − 18 = **2,313 data bytes**. A transfer is capped at **255 segments / 589,815 bytes** (~576 KiB, ~196k Chinese characters). The CRC doubles as the transfer id, so segments from different generations cannot be mixed silently.
- Splitting happens at Unicode code-point boundaries (`Array.from` + UTF-8 length), so Chinese/emoji are never cut in half. Lone surrogates are normalised with `toWellFormed()` because qrcode-generator's UTF-8 encoder handles them differently from `TextEncoder`.
- Reassembly ignores paste order and spatial layout: it sorts by `index`, verifies `total`, concatenates, checks CRC32, then decodes strict UTF-8. `App.tsx` keeps up to three pending transfers keyed by CRC; a partial paste updates the status and **does not** overwrite the textarea.
- Page layout is 12 cards (4×3, 210 px) per screenshot in the minimum window. 255 segments → 22 pages; 64 segments → 6 pages. The end-to-end test in `App.sheet.test.tsx` renders pages, composites the card pixels into a screenshot, and pastes pages out of order.

### Decoder / WASM notes

- `zxing-wasm@3.1.7`'s reader wasm (≈946 KB) is bundled locally through Vite's `?url` import; `decode.ts` overrides zxing's default jsDelivr CDN path with `prepareZXingModule({ locateFile })` and preloads it from an effect. If the wasm asset fails, `decodeQRCodes` falls back to jsQR (single-code only) rather than breaking the app.
- Vitest cannot fetch the bundled wasm, so `src/test/setup.ts` injects `wasmBinary` with `readFileSync` and `decode.ts` skips its production setup when `import.meta.env.MODE === "test"`. Keep both halves if you touch decoder init.
- `readBarcodes` returns raw `bytes`; always use those (not `text`) so the existing GB18030 fallback in `decodePayload` keeps working.

### Paste handling

`App.tsx` registers a `paste` listener (`ClipboardEvent.clipboardData`) on every platform, plus a global `keydown` listener (Ctrl+V → `navigator.clipboard.read()`) **on Windows only**:
- `navigator.clipboard.read()` is the reliable image path on **Windows/WebView2**, where `clipboardData` often omits image items; it needs the focus context the keydown event provides.
- On **macOS** the `paste` event is reliable on its own. Do not add the keydown path back there: reading the clipboard on keydown races the default paste action and the first ⌘V gets swallowed (this was the "press paste twice" bug).
- The shared `processingRef` guard prevents double processing; `processImage` clears it from `img.onload` (in a `finally`) / `img.onerror`, plus a 5 s load timeout, so a broken image blob can't wedge it at `true`. `handlePaste` calls `preventDefault()` for image pastes even when it skips processing, so the native paste never runs alongside ours. Non-image paste is left alone so text pastes through normally.

If you touch paste, test on both platforms.

### Logging

Frontend `log()` / `logError()` helpers in `App.tsx` write to the console **and** call the Rust `write_log` command, which appends to `qr-converter.log` next to the executable (falls back to the temp dir). The app also logs its startup banner and log path in `lib.rs` `setup`. `write_log` errors are swallowed so logging never breaks the UI. Tauri commands must be registered in `generate_handler!` in `lib.rs` and any core APIs used need matching permissions in `capabilities/default.json`.

### Stale documentation

- `CLAUDE.md`-era notes and `SPEC.md` describe a `capture_screenshot` Rust command, a full-screen selection overlay, and a `screenshots`/`base64`/`image` Rust stack. **None of that exists anymore** — the backend is only `write_log`, and capture was replaced by clipboard paste. `SPEC.md` is a build-from-scratch spec, not a description of the current code; trust the code when they disagree.
- `src-tauri/Info.plist` still declares `NSScreenCaptureUsageDescription` (merged into the macOS bundle via `tauri.conf.json → bundle.macOS.infoPlist`). It is harmless but no longer needed unless screen capture returns.

### Other assets

- `scripts/gen_icon.py` regenerates the 1024×1024 icon source with Pillow (`src-tauri/icons/` are generated from it); not part of the build.
