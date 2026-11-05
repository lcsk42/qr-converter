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

Packaging: `npm run build:mac` produces a universal macOS `.dmg` (requires both apple-* rustup targets); `npm run build:win` a Windows x64 installer. CI (`.github/workflows/build.yml`) runs on `v*` tags or manual dispatch and creates a **draft** GitHub release via `tauri-apps/tauri-action`.

### Tests

`vitest.config.ts` (`environment: jsdom`) drives `src/**/*.test.ts(x)`; Rust tests live in `#[cfg(test)] mod tests` in `lib.rs`.

| File | Covers |
|------|--------|
| `src/decodePayload.test.ts` | UTF-8 → GB18030 fallback, empty/garbage payloads |
| `src/App.qr.test.tsx` | text → QR, capacity overflow and recovery, empty/whitespace |
| `src/App.paste.test.tsx` | paste → decode, statuses, guard/refcount, copy button |
| `src/App.mac.test.tsx` / `src/App.win.test.tsx` | which paste paths each platform registers |

Two things make the component tests able to run in jsdom without faking the QR pipeline itself:

- `src/test/setup.ts` gives `HTMLCanvasElement.getContext` a real `@napi-rs/canvas` backing, so drawn pixels can be read back and fed to `jsQR`. Tests therefore do a genuine round trip (draw → `getImageData` → decode) rather than asserting on `fillRect` call counts. It also mocks `@tauri-apps/api/core`'s `invoke`, and provides `installPastePipeline()` — processImage's *offscreen* canvas synthesises the pasted image's pixels through it.
- `src/platform.ts` exists only so `isMac` can be pinned with `vi.mock("./platform")`; the mac/win test files would otherwise be unreachable on one host OS or the other.

`src/test/gbk.ts` derives GBK byte sequences by inverting Node's own GB18030 `TextDecoder` instead of hard-coding a hex table (hand-written values were wrong the first time). Use it rather than pasting hex when adding fixtures.

Unit tests style: prefer asserting user-visible behaviour (`textarea.value`, rendered status text, decodability) over internal state.

## Architecture

Tauri 2 desktop app: React 18 + TypeScript + Vite + Tailwind frontend, Rust backend.

| Layer | Path |
|-------|------|
| Frontend (all logic in one component) | `src/App.tsx` |
| Backend (all Tauri commands) | `src-tauri/src/lib.rs` |
| `main.rs` is just `app_lib::run()` | `src-tauri/src/main.rs` |
| Tauri config / capabilities | `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json` |

Window is fixed to a 1024×768 minimum; UI is a single textarea, a status line, and a 420×420 QR canvas.

### Two features

1. **Text → QR (pure frontend).** `renderQR` in `App.tsx` uses `qrcode-generator` (error correction level `M`, auto version) and draws modules onto the canvas manually: module size = `floor(388 / moduleCount)`, centered within a 388 px inner area, +16 px padding → 420×420 canvas. Re-renders on every `text` change. Content too large for a QR → `qrError` string instead of a canvas.
2. **Image → text (paste).** A pasted image goes to `processImage`, which decodes it into an offscreen canvas (downscaled so the longest side ≤ 2000 px), then `jsQR`. A result is written into the same `text` state, so the generated QR immediately updates. Failures set `appState` to `not-found`/`error`, auto-reset to `idle` after 2.5 s.

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
