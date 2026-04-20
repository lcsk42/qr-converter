# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
npm install

# Start development (Tauri + Vite dev server concurrently)
npm run tauri dev

# Build for production
npm run tauri build

# Frontend-only dev (no Tauri window)
npm run dev

# Type-check frontend
npx tsc --noEmit
```

Rust compilation happens automatically when running `tauri dev` or `tauri build`. To check Rust only:
```bash
cd src-tauri && cargo check
```

## Architecture

This is a **Tauri 2.0** desktop app with a **React + TypeScript** frontend bundled by Vite.

### Project split

| Layer | Path | Role |
|-------|------|------|
| Frontend | `src/` | React UI, QR generation, jsQR decoding |
| Backend | `src-tauri/src/` | Rust command that captures the screen |
| Tauri config | `src-tauri/tauri.conf.json` | Window settings, bundle config |
| Capabilities | `src-tauri/capabilities/default.json` | Tauri 2 permission system |

### Frontend → Backend IPC

The only Tauri command is `capture_screenshot` (defined in `src-tauri/src/lib.rs`):
- Hides the app window, captures the primary display via the `screenshots` Rust crate, saves a temp PNG, reads it back, deletes the temp file, and returns the PNG as a base64 string.
- The frontend (`src/App.tsx`) decodes the base64, draws it onto an offscreen canvas, extracts `ImageData`, and passes it to **jsQR** for QR code detection.
- Called with `invoke("capture_screenshot")` from `@tauri-apps/api/core`.

### QR code generation

Done entirely in the frontend using **qrcode-generator** (canvas-based rendering in `App.tsx`). Text changes trigger real-time re-render via `useEffect`. The canvas is drawn at 300×300 px with modules fitting within a 268×268 inner area (16 px padding on each side).

### macOS screen capture permission

`src-tauri/Info.plist` adds `NSScreenCaptureUsageDescription` and is merged into the app bundle via `tauri.conf.json → bundle.macOS.infoPlist`. macOS will prompt the user for permission on first capture.

## Key dependencies

- `qrcode-generator` ^1.4.4 — QR generation (no canvas API dependency)
- `jsqr` ^1.4.0 — QR detection from `ImageData`
- `lucide-react` — icon set (Copy, Check icons used)
- `screenshots` (Rust, 0.8) — cross-platform screen capture
- `base64` (Rust, 0.22) — encodes captured PNG for IPC transfer
