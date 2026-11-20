# QR Converter

English | [简体中文](README.zh-CN.md)

[![Build](https://github.com/lcsk42/qr-converter/actions/workflows/build.yml/badge.svg)](https://github.com/lcsk42/qr-converter/actions/workflows/build.yml)

A small Tauri 2 desktop app that converts text to QR codes and QR screenshots back to text.

A single QR code holds at most **2,331 UTF-8 bytes** (Version 40, ECC M). When the text is larger, QR Converter splits it into an ordered, checksummed set of QR codes and lays them out as a paginated sheet. Screenshot the pages, paste them back in any order, and the original text is reconstructed exactly.

---

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Multi-QR transfer](#multi-qr-transfer)
- [Protocol](#protocol)
- [Limits](#limits)
- [Development](#development)
- [Testing](#testing)
- [Packaging and release](#packaging-and-release)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## Features

- **Text → QR** — live single-QR rendering (`qrcode-generator`, ECC M, auto version, up to Version 40).
- **Automatic multi-QR segmentation** — content over 2,331 bytes becomes a paginated 4×3 sheet (12 codes per page), with a full-window **Capture mode** for clean page screenshots.
- **Screenshot → text** — [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) decodes **every** QR code in a pasted screenshot in one pass (jsQR is kept as a single-code fallback).
- **Order-independent reassembly** — each segment carries its index and total, so paste pages in any order; duplicate/overlapping screenshots are ignored. A CRC32 checks the complete transfer.
- **Progress reporting** — while receiving, the status line shows `Received 3 of 7 segments — missing 4, 6, 7` and never overwrites the editor until the set is complete.
- **High-DPI aware rendering** — canvas backing stores follow `devicePixelRatio`, keeping 1–2 px modules crisp at 125%/150%/200% scaling.
- **Native-resolution decoding** — screenshots are processed up to a 24 MP budget instead of being blindly downscaled.
- **GBK/GB18030 support** — non-UTF-8 QR payloads fall back to GB18030, common in older Chinese/Windows tooling.
- **Editor utilities** — copy the full text, or “compress” it by removing all whitespace (spaces, tabs, newlines, full-width spaces, NBSP, …).
- **Offline and small Windows installers** — an online NSIS package plus an offline package with the WebView2 runtime embedded.
- **Universal macOS build** — one `.dmg` for Apple Silicon and Intel.

---

## Install

Download the latest artifacts from [GitHub Releases](https://github.com/lcsk42/qr-converter/releases).

### macOS

- Asset: `QR.Converter_<version>_universal.dmg` (Apple Silicon + Intel, macOS 11+).
- The build is currently **not code-signed or notarized**. On first launch macOS may block it; open **System Settings → Privacy & Security** and choose **Open Anyway** for the app. Only bypass Gatekeeper for builds you trust.
- If macOS reports the app is damaged, verify the download first; for local builds you can rebuild from source.

### Windows (x64, Windows 10 1809 / LTSC or later)

| Asset | WebView2 | Size | Install mode | Network |
|---|---|---|---|---|
| `…windows-x64-online-setup.exe` | Not embedded | Small | Per-user | Required only if WebView2 is missing/old |
| `…windows-x64-offline-setup.exe` | Embedded (x64 offline installer) | ~300 MB | Per-machine (admin) | Not required |

- The **online** installer uses Microsoft's WebView2 bootstrapper: if WebView2 is missing or older than `109.0.1518.140`, it downloads and installs it.
- The **offline** installer embeds Microsoft's x64 WebView2 offline installer (≈294 MB as of 2026) and installs it silently only when missing/outdated. This is the package for air-gapped or unreliable-network machines.
- Only the NSIS `.exe` is produced; there is no `.msi`.
- Windows builds are not code-signed; SmartScreen may ask for **More info → Run anyway**.

---

## Usage

### Single QR

1. Type or paste text into the editor.
2. At up to 2,331 UTF-8 bytes, one 420×420 QR code is rendered below the editor.
3. Hover the editor's top-right buttons:
   - **Copy** copies the entire text.
   - **Compress whitespace** removes all `\s` whitespace from the editor: spaces, tabs, newlines, full-width/ideographic spaces, NBSP, and similar characters. Zero-width joiners are preserved, so emoji sequences survive.
4. A screenshot of the QR can be pasted back into the app to recover the text.

### Multi-QR

When the text exceeds 2,331 bytes, the QR area becomes a paginated sheet:

- 4 columns × 3 rows = **12 codes per page**
- Each card is 210×210 CSS px and contains one segment
- The toolbar shows the number of codes, total bytes, the per-code data limit, the page number, and the code range
- **Capture mode** hides the editor/status and presents one clean page for a screenshot

Typical workflow:

1. Enter/paste the text; the work is split automatically.
2. Click **Capture mode**.
3. Screenshot the current page (`⌘⇧4` on macOS, `Win+Shift+S` on Windows; capture the app window).
4. Click `›` for the next page and repeat until every page is captured.
5. In the receiving app window, paste each screenshot (`⌘V` / `Ctrl+V`).
6. Watch the status line for progress and missing segments. Paste order does not matter, and duplicates are harmless.
7. When all segments have arrived, the textarea is filled with the original text and the status shows `Restored N segments`.

Do **not** edit the textarea while receiving: a manual edit clears the pending segment buffer. Re-paste all pages if that happens.

### Pasting images

The app reads image data from the clipboard image, not a file path.

- macOS: copy the image (e.g. Preview → ⌘A → ⌘C) and press ⌘V.
- Windows: copy the image from Snipping Tool/Photos and press Ctrl+V; the Windows path also uses `navigator.clipboard.read()` via Ctrl+V for WebView2 reliability.
- Screenshots must stay lossless and unscaled. JPEG recompression, resizing, or cropping through card edges can make dense QR modules unreadable.

### Single/multi decoding

- If the pasted image contains any segment-formatted codes, they are accumulated; unrelated plain QR codes in the same image are ignored.
- If there are no segments and exactly one plain QR, its text is loaded (as before).
- If there are multiple plain QR codes, the first in reading order (top-to-bottom, left-to-right) is used and the status reports it.
- A QR that was too large in an older version now automatically becomes a multi-QR sheet instead of an error. The hard error only appears above 589,815 bytes.

---

## Multi-QR transfer

```text
Text > 2,331 bytes
        │
        ▼
  Split at Unicode code points
  (≤2,313 data bytes per segment)
        │
        ▼
  18-byte header + data per QR
        │
        ▼
  4×3 page sheet → Capture mode → screenshots
        │
        ▼
  Paste screenshots in any order
        │
        ▼
  zxing-wasm decodes all codes
        │
        ▼
  Accumulate by CRC32 transfer id
  (index/total, deduplicate, report missing)
        │
        ▼
  Reassemble by index → verify CRC32 → UTF-8 → textarea
```

Recommended practical size: **≤64 segments** (≈145 KiB, 6 pages). The hard protocol limit is 255 segments.

---

## Protocol

Each segmented QR starts with a fixed **18-byte ASCII header**:

| Offset | Size | Field |
|---|---|---|
| 0..3 | 4 | `QRS1` — magic and protocol version |
| 4..11 | 8 | CRC32 of the complete UTF-8 content, 8 uppercase hex digits |
| 12..14 | 3 | Segment index, decimal `000`–`254` |
| 15..17 | 3 | Segment total, decimal `002`–`255` |
| 18.. | n | Segment data (a slice of the original UTF-8 text) |

- Per-QR capacity: **2,331 B** (Version 40, ECC M, Byte mode) → **2,313 data bytes** after the header.
- Maximum transfer: **255 × 2,313 = 589,815 bytes ≈ 576 KiB** (about 196,000 Han characters at 3 bytes each).
- The CRC32 is both the transfer id and the integrity check. Segments from different generations cannot be silently mixed.
- Splitting happens at Unicode code-point boundaries, so Chinese characters and emoji are never cut in half. Lone surrogates are normalised to U+FFFD because qrcode-generator and `TextEncoder` otherwise disagree on their encoding.
- Ordering comes from the embedded `index`, not from the screenshot layout or paste order. Even a shuffled or partial set restores correctly once complete.
- Single-QR texts have no header; the plain payload is used directly, preserving compatibility with all other QR tools.

---

## Limits

| Item | Value |
|---|---|
| Single QR capacity | 2,331 UTF-8 bytes (V40-M) |
| Data per segmented QR | 2,313 bytes |
| Segments per transfer | 255 max |
| Content per transfer | 589,815 bytes ≈ 576 KiB |
| Codes per page | 12 (4×3, 210 px cards) |
| Pages for 255 segments | 22 |
| Recommended practical cap | 64 segments ≈ 145 KiB (6 pages) |
| Decode pixel budget | 24 MP |

Notes:

- The offline Windows installer is large because Microsoft's official x64 WebView2 offline installer is ≈294 MB. There is no smaller official offline WebView2 runtime.
- macOS builds are universal, but currently unsigned; public distribution should add Developer ID signing and notarization.
- Windows builds are unsigned; public distribution should add an Authenticode certificate.

---

## Development

### Requirements

- Node.js 20+ and npm
- Rust stable
- Tauri 2 prerequisites:
  - macOS: Xcode Command Line Tools
  - Windows: Visual Studio Build Tools (C++ workload) and WebView2 (the installers handle the runtime)
  - Linux: WebKitGTK/GTK development packages (see the Tauri prerequisites page)
- `rustup` targets for universal macOS builds: `aarch64-apple-darwin` and `x86_64-apple-darwin`

### Setup

```bash
npm install
npm run tauri dev      # desktop app (Vite on :1420 + Tauri window)
```

Frontend-only development:

```bash
npm run dev            # browser preview; Tauri IPC calls (write_log) fail silently
```

### Commands

| Command | Purpose |
|---|---|
| `npm run tauri dev` | Run the desktop app |
| `npm run dev` | Frontend only in a browser |
| `npm run build` | `tsc` + Vite production build |
| `npx tsc --noEmit` | Type-check the frontend |
| `cd src-tauri && cargo check` | Check the Rust backend |
| `npm test` | Vitest (jsdom), 99 tests |
| `npm run test:watch` | Vitest watch mode |
| `npm run test:rust` | `cargo test`, 7 tests |
| `npm run build:mac` | Universal macOS `.dmg` |
| `npm run build:win` | Windows x64 **online** NSIS `.exe` |
| `npm run build:win:offline` | Windows x64 **offline** NSIS `.exe` (WebView2 embedded) |

There is no linter or formatter configured.

### Project structure

| Path | Role |
|---|---|
| `src/App.tsx` | UI, paste pipeline, segment accumulator, statuses |
| `src/segments.ts` | Envelope, CRC32, UTF-8 splitting, reassembly, limits |
| `src/decode.ts` | zxing-wasm multi-code decoder, jsQR fallback, GB18030 payload decode, image budget |
| `src/qrRender.ts` | DPR-aware QR drawing, single/sheet sizes, clearing |
| `src/platform.ts` | `isMac` seam for platform tests |
| `src/test/` | Canvas/paste test harness and GBK fixture helpers |
| `src-tauri/src/lib.rs` | Tauri commands (`write_log`) and startup logging |
| `src-tauri/tauri.conf.json` | Window, bundle, online Windows installer config |
| `src-tauri/tauri.offline.conf.json` | Windows offline override (`offlineInstaller`, per-machine) |
| `.github/workflows/build.yml` | CI: test + macOS universal + Windows online/offline |
| `CLAUDE.md` | Repo-specific notes for Claude Code |

### Architecture

#### Frontend

- `createQRPlan(text)` in `segments.ts` decides between `empty`, `single`, `sheet`, and `error`.
- Single QR: 420×420 canvas, 16 px padding, module cell = `floor(inner / moduleCount)`.
- Sheet: 12 cards per page, 210×210 CSS px, 8 px padding.
- Rendering is DPR-aware: backing size = `round(cssSize × devicePixelRatio)` and modules use integer device-pixel cells. The canvas element keeps its CSS size, so layout does not change when DPR changes.
- `Capture mode` is a fixed, full-window page view so a page screenshot contains all 12 cards without editor chrome.

#### Decoding

`decodeQRCodes(imageData)`:

1. Lazily loads zxing-wasm (bundled locally through Vite's `?url`; fetched and injected as `wasmBinary`, so no CDN and no MIME/streaming surprise).
2. Calls `readBarcodes(imageData, { formats: ["QRCode"], tryHarder: true, tryRotate: true })`.
3. Returns every result's **raw `bytes`** plus its position. Raw bytes are important: the app then decodes UTF-8 first and falls back to GB18030.
4. If the WASM module cannot load, falls back to a single-code jsQR decode.

The pasted image is fitted to a 24 MP budget (not a fixed 2,000 px longest side): a dense card can have 1-device-pixel modules, and downscaling destroys them.

#### Segment accumulator

- Pending transfers are keyed by CRC32, capped at three concurrent sets.
- Incoming segments are validated (same total, matching duplicate bytes), deduplicated by index, and kept in memory only.
- When `parts.size === total`, the app sorts by index, concatenates, verifies CRC32, decodes strict UTF-8, and writes the result to the textarea.
- Partial sets update the status only; the textarea is never overwritten.
- A manual editor change clears pending sets; a plain QR result also clears them.

#### Paste handling

- **macOS:** only the `paste` event is registered. Reading the clipboard on keydown races the native paste and swallows the first ⌘V.
- **Windows:** a `keydown` Ctrl+V handler reads `navigator.clipboard.read()` (WebView2 often omits image items from `clipboardData`), with the `paste` event as a fallback.
- `handlePaste` calls `preventDefault()` for image pastes even when it skips processing, so the native paste never runs alongside the app's pipeline.
- A shared `processingRef` guard prevents double processing; it is released in a `finally`, on image error, and after a 5 s image-load timeout.

#### Logging

`log()` / `logError()` write to the browser console and call the Rust `write_log` command, which appends to `qr-converter.log` next to the executable (falling back to the temp directory). Logging never breaks the UI.

---

## Testing

```bash
npm test               # 99 frontend tests (9 files)
npm run test:rust      # 7 backend tests
npx tsc --noEmit
cd src-tauri && cargo check
```

The component tests are real round trips, not mocks:

- `src/test/setup.ts` backs `HTMLCanvasElement.getContext("2d")` with `@napi-rs/canvas`, so tests draw actual pixels and read them back.
- zxing-wasm is configured with an injected `wasmBinary` (Vite cannot fetch the bundled wasm in jsdom).
- `installPastePipeline()` makes the image pipeline's offscreen canvas synthesise a test fixture's pixels.
- `src/App.sheet.test.tsx` generates pages, composites the rendered cards into a screenshot, pastes the pages **out of order**, repeats a page, and asserts the reconstructed text.
- `src/App.mac.test.tsx` / `src/App.win.test.tsx` pin `isMac` so both paste paths are tested on any host OS.

Manual checks worth doing before a release:

- Clean Windows 10 1809/LTSC x64 VM without WebView2, offline: offline installer should install WebView2 and launch.
- Online Windows installer with a missing/old WebView2.
- Universal macOS DMG on Apple Silicon and Intel.
- Real screenshots at 100%, 125%, 150%, and 200% display scaling.
- Partial screenshots, shuffled paste order, duplicated pages, and a deliberately corrupted segment.

---

## Packaging and release

CI (`.github/workflows/build.yml`) runs on `v*` tags or manual dispatch and creates a **draft** GitHub release. The build matrix produces three artifacts:

| Platform | Build | Asset |
|---|---|---|
| macOS universal | `--target universal-apple-darwin` | `QR.Converter_<version>_universal.dmg` |
| Windows x64 online | `--bundles nsis` | `QR.Converter_<version>_windows-x64-online-setup.exe` |
| Windows x64 offline | `--bundles nsis --config src-tauri/tauri.offline.conf.json` | `QR.Converter_<version>_windows-x64-offline-setup.exe` |

- `releaseAssetNamePattern` (tauri-action v1) gives the two Windows installers distinct names.
- The offline override sets `webviewInstallMode = offlineInstaller`, `installMode = perMachine`, and `minimumWebview2Version = 109.0.1518.140`.
- The base config keeps the small online installer on `downloadBootstrapper` and the default per-user install mode.
- There is no `.msi` output.

Version bumps: update `package.json`, `src-tauri/Cargo.toml`, and `bundle.version` in `src-tauri/tauri.conf.json`, run `cargo check` to refresh `Cargo.lock`, then tag `vX.Y.Z`.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| macOS: “cannot be opened” / unidentified developer | Unsigned build. Allow it in **System Settings → Privacy & Security → Open Anyway**, or build from source. |
| Windows: SmartScreen warning | Unsigned build: **More info → Run anyway**. |
| Windows: app does not start after install | WebView2 missing. Use the offline installer, or install WebView2 Runtime. |
| `No QR code found in pasted image` | Crop to the app window, use a lossless screenshot, and do not resize/compress it. |
| Segments are missing | The status lists 1-based missing indices. A page covers codes `(page-1)×12+1` through `page×12`; re-screenshot that page. |
| `Segment checksum mismatch` | Re-paste the complete set; do not mix screenshots from different generations. |
| Progress disappears | Editing the textarea clears pending segments. Re-paste all pages. |
| Content is too large | Hard limit is 589,815 bytes (255 segments); recommend ≤64 segments. |
| Old Windows cannot install WebView2 online | Use the offline installer; it carries the x64 runtime. |
| Dense QR fails to decode | Keep native screenshot resolution; capture the app window rather than the whole desktop. |

---

## Security notes

- CRC32 detects accidental corruption and accidental mixing; it is **not** a cryptographic signature. Do not treat it as authentication.
- The app decodes text only. It does not execute QR content or fetch URLs.
- Network access is only involved in the Windows **online** installer's WebView2 bootstrapper. The app itself and the zxing wasm asset are local.
- The app writes a local log file next to the executable. Avoid logging sensitive content (the app does not log payloads).
- Public distribution should add macOS Developer ID signing/notarization and a Windows Authenticode certificate to remove the OS warnings.
