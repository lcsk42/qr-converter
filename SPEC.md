# QR Converter — Complete Implementation Specification

> 拿到此文件即可从零重建整个项目，无需参考其他资料。

---

## 1. 项目概述

**QR Converter** 是一个桌面端工具，提供两个核心功能：

1. **文本 → QR 码生成**：在输入框中输入任意文本，实时渲染为二维码图像。
2. **截图 → QR 码识别**：点击截图按钮后，全屏展示带十字光标的选区覆盖层，用户拖拽框选目标区域，自动识别其中的二维码并将内容回填到输入框。

---

## 2. 技术栈

| 层 | 技术 | 版本 |
|---|---|---|
| 桌面框架 | Tauri | 2.x |
| 前端框架 | React | 18.3 |
| 语言 | TypeScript | 5.x |
| 构建工具 | Vite | 5.x |
| 样式 | Tailwind CSS | 3.x |
| QR 生成 | qrcode-generator | ^1.4.4 |
| QR 识别 | jsQR | ^1.4.0 |
| 图标库 | lucide-react | ^0.400.0 |
| 后端语言 | Rust | stable |
| 截图（Rust） | screenshots | 0.8 |
| Base64（Rust） | base64 | 0.22 |
| 图像解码（Rust）| image | 0.25（仅 png feature）|

---

## 3. 目录结构

```
qr-converter/
├── src/                        # 前端 React 源码
│   ├── main.tsx                # React 入口
│   ├── App.tsx                 # 唯一页面组件（全部业务逻辑）
│   └── index.css               # Tailwind 指令 + 全局样式
├── src-tauri/                  # Rust/Tauri 后端
│   ├── src/
│   │   ├── main.rs             # 二进制入口（不含逻辑）
│   │   └── lib.rs              # 全部 Tauri 命令
│   ├── icons/                  # 各平台图标（由 tauri icon 命令生成）
│   │   └── source.png          # 1024×1024 图标源文件（手动生成）
│   ├── capabilities/
│   │   └── default.json        # Tauri 2 权限声明
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── Info.plist              # macOS 隐私描述（合并入 bundle）
├── scripts/
│   └── gen_icon.py             # 图标生成脚本（Pillow，可选）
├── .github/
│   └── workflows/
│       └── build.yml           # CI：macOS universal + Windows x64
├── index.html                  # Vite HTML 入口
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

---

## 4. 完整源文件

### 4.1 `index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/vite.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>QR Converter</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

### 4.2 `src/main.tsx`

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### 4.3 `src/index.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background-color: #ffffff;
  color: #09090b;
}
```

### 4.4 `src/App.tsx`

这是唯一的业务逻辑文件，包含全部前端功能。

```tsx
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import jsQR from "jsqr";
import qrcode from "qrcode-generator";
import { Copy, Check } from "lucide-react";

type AppState = "idle" | "capturing" | "selecting" | "not-found" | "error" | "permission_denied";

interface ScreenshotData {
  url: string;
  img: HTMLImageElement;
  naturalWidth: number;
  naturalHeight: number;
}

export default function App() {
  const [text, setText] = useState("");
  const [qrReady, setQrReady] = useState(false);
  const [qrError, setQrError] = useState("");
  const [copied, setCopied] = useState(false);
  const [appState, setAppState] = useState<AppState>("idle");
  const [screenshotData, setScreenshotData] = useState<ScreenshotData | null>(null);

  const qrCanvasRef = useRef<HTMLCanvasElement>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null);

  const isDrawingRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const currentPosRef = useRef({ x: 0, y: 0 });

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

  // ── Selection overlay drawing ───────────────────────────────────────────────

  const drawOverlay = useCallback(() => {
    const canvas = overlayCanvasRef.current;
    if (!canvas || !screenshotData) return;
    const ctx = canvas.getContext("2d")!;

    const w = canvas.width;
    const h = canvas.height;

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(screenshotData.img, 0, 0, w, h);

    if (isDrawingRef.current) {
      const sx = Math.min(startPosRef.current.x, currentPosRef.current.x);
      const sy = Math.min(startPosRef.current.y, currentPosRef.current.y);
      const sw = Math.abs(currentPosRef.current.x - startPosRef.current.x);
      const sh = Math.abs(currentPosRef.current.y - startPosRef.current.y);

      // Dark overlay around selection (4 rects)
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, w, sy);
      ctx.fillRect(0, sy + sh, w, h - sy - sh);
      ctx.fillRect(0, sy, sx, sh);
      ctx.fillRect(sx + sw, sy, w - sx - sw, sh);

      // Selection border
      ctx.strokeStyle = "#1d9bf0";
      ctx.lineWidth = 2;
      ctx.strokeRect(sx, sy, sw, sh);

      // Corner handles
      const handleSize = 8;
      ctx.fillStyle = "#1d9bf0";
      const corners = [
        [sx, sy], [sx + sw - handleSize, sy],
        [sx, sy + sh - handleSize], [sx + sw - handleSize, sy + sh - handleSize],
      ];
      for (const [cx, cy] of corners) {
        ctx.fillRect(cx, cy, handleSize, handleSize);
      }

      // Size hint
      const hintText = `${Math.round(sw)} × ${Math.round(sh)}`;
      const hintW = hintText.length * 7 + 12;
      const hintH = 20;
      const hintX = sx;
      const hintY = sy - hintH - 4 < 0 ? sy + sh + 4 : sy - hintH - 4;
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.beginPath();
      ctx.roundRect(hintX, hintY, hintW, hintH, 3);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "12px monospace";
      ctx.fillText(hintText, hintX + 6, hintY + 14);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.45)";
      ctx.fillRect(0, 0, w, h);
    }
  }, [screenshotData]);

  // Resize canvas when entering selection mode (handles fullscreen transition)
  useEffect(() => {
    if (appState !== "selecting") return;

    const updateSize = () => {
      const canvas = overlayCanvasRef.current;
      if (canvas) {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
        drawOverlay();
      }
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [appState, drawOverlay]);

  // Escape key to cancel selection
  useEffect(() => {
    if (appState !== "selecting") return;

    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        isDrawingRef.current = false;
        const data = screenshotData;
        setScreenshotData(null);
        setAppState("idle");
        await getCurrentWindow().setFullscreen(false);
        if (data) URL.revokeObjectURL(data.url);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [appState, screenshotData]);

  // ── Overlay mouse handlers ──────────────────────────────────────────────────

  const handleOverlayMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = overlayCanvasRef.current!.getBoundingClientRect();
    isDrawingRef.current = true;
    startPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    currentPosRef.current = { ...startPosRef.current };
    drawOverlay();
  };

  const handleOverlayMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    const rect = overlayCanvasRef.current!.getBoundingClientRect();
    currentPosRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    drawOverlay();
  };

  const handleOverlayMouseUp = async () => {
    if (!isDrawingRef.current || !screenshotData) return;
    isDrawingRef.current = false;

    const canvas = overlayCanvasRef.current!;
    const sx = Math.min(startPosRef.current.x, currentPosRef.current.x);
    const sy = Math.min(startPosRef.current.y, currentPosRef.current.y);
    const sw = Math.abs(currentPosRef.current.x - startPosRef.current.x);
    const sh = Math.abs(currentPosRef.current.y - startPosRef.current.y);

    if (sw < 5 || sh < 5) {
      drawOverlay();
      return;
    }

    const scaleX = screenshotData.naturalWidth / canvas.width;
    const scaleY = screenshotData.naturalHeight / canvas.height;
    const cropX = Math.round(sx * scaleX);
    const cropY = Math.round(sy * scaleY);
    const cropW = Math.round(sw * scaleX);
    const cropH = Math.round(sh * scaleY);

    const { img, url } = screenshotData;

    setScreenshotData(null);
    setAppState("idle");
    await getCurrentWindow().setFullscreen(false);
    URL.revokeObjectURL(url);

    const offscreen = document.createElement("canvas");
    offscreen.width = cropW;
    offscreen.height = cropH;
    const ctx = offscreen.getContext("2d")!;
    ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);

    const imageData = ctx.getImageData(0, 0, cropW, cropH);
    const result = jsQR(imageData.data, cropW, cropH);

    if (result) {
      setText(result.data);
    } else {
      setAppState("not-found");
      setTimeout(() => setAppState("idle"), 2500);
    }
  };

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

  // ── Screenshot capture ─────────────────────────────────────────────────────

  const handleCaptureScreenshot = async () => {
    setAppState("capturing");
    try {
      const base64: string = await invoke("capture_screenshot");

      const binaryStr = atob(base64);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: "image/png" });
      const url = URL.createObjectURL(blob);

      const img = new Image();
      img.onload = async () => {
        setScreenshotData({
          url,
          img,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
        });
        await getCurrentWindow().setFullscreen(true);
        setAppState("selecting");
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        setAppState("error");
        setTimeout(() => setAppState("idle"), 2500);
      };
      img.src = url;
    } catch (e: unknown) {
      console.error("Capture failed:", e);
      const msg = String(e);
      if (msg.includes("permission_denied")) {
        setAppState("permission_denied");
      } else {
        setAppState("error");
        setTimeout(() => setAppState("idle"), 2500);
      }
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const captureLabel: Record<AppState, string> = {
    idle: "Capture QR Code",
    capturing: "Capturing...",
    selecting: "Select area...",
    "not-found": "No QR Code Found",
    error: "Capture Failed",
    permission_denied: "Screen Recording Denied",
  };

  return (
    <>
      {/* Full-screen selection overlay */}
      {appState === "selecting" && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999 }}>
          <canvas
            ref={overlayCanvasRef}
            style={{ display: "block", cursor: "crosshair", width: "100%", height: "100%" }}
            onMouseDown={handleOverlayMouseDown}
            onMouseMove={handleOverlayMouseMove}
            onMouseUp={handleOverlayMouseUp}
          />
          <div
            style={{
              position: "absolute",
              bottom: 28,
              left: "50%",
              transform: "translateX(-50%)",
              background: "rgba(0,0,0,0.72)",
              color: "#fff",
              padding: "6px 18px",
              borderRadius: 6,
              fontSize: 13,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            Drag to select the QR code area · ESC to cancel
          </div>
        </div>
      )}

      {/* Main UI */}
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

        {/* Capture button */}
        <button
          onClick={appState === "permission_denied" ? () => setAppState("idle") : handleCaptureScreenshot}
          disabled={appState === "capturing" || appState === "selecting"}
          className="border border-zinc-200 rounded-md bg-white hover:bg-zinc-50 text-sm font-medium text-zinc-900 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          style={{ width: 180, height: 40 }}
        >
          {captureLabel[appState]}
        </button>

        {/* Permission denied banner */}
        {appState === "permission_denied" && (
          <div
            className="flex flex-col items-center gap-2 text-center"
            style={{
              width: 420,
              background: "#fff7ed",
              border: "1px solid #fed7aa",
              borderRadius: 8,
              padding: "12px 16px",
            }}
          >
            <p className="text-sm text-orange-700 font-medium">
              Screen Recording permission is required.
            </p>
            <p className="text-xs text-orange-600">
              Grant access in System Settings, then try again.
              You may need to restart the app after granting permission.
            </p>
            <button
              onClick={async () => {
                await invoke("open_privacy_settings");
              }}
              className="mt-1 text-xs font-medium text-orange-700 underline hover:text-orange-900 transition-colors"
            >
              Open Privacy &amp; Security Settings →
            </button>
          </div>
        )}

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
              <p className="text-zinc-400 text-sm text-center">QR code will appear here</p>
            </>
          )}
        </div>
      </div>
    </>
  );
}
```

### 4.5 `src-tauri/src/main.rs`

```rust
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    app_lib::run();
}
```

### 4.6 `src-tauri/src/lib.rs`

```rust
use base64::{engine::general_purpose, Engine as _};
use screenshots::Screen;
use tauri::WebviewWindow;

#[cfg(target_os = "macos")]
mod screen_permission {
    pub fn open_privacy_settings() {
        let _ = std::process::Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .spawn();
    }
}

/// Returns true when >90% of sampled pixels are near-black (r,g,b < 16).
/// macOS returns a solid-black frame when Screen Recording is denied.
fn looks_like_black_frame(png_bytes: &[u8]) -> bool {
    let cursor = std::io::Cursor::new(png_bytes);
    let Ok(img) = image::load(cursor, image::ImageFormat::Png) else {
        return false;
    };
    let rgb = img.to_rgb8();
    let total: usize = (rgb.width() * rgb.height()) as usize;
    if total == 0 {
        return false;
    }
    let step = 64usize;
    let mut dark = 0usize;
    let mut checked = 0usize;
    for pixel in rgb.pixels().step_by(step) {
        if pixel[0] < 16 && pixel[1] < 16 && pixel[2] < 16 {
            dark += 1;
        }
        checked += 1;
    }
    checked > 0 && dark * 10 > checked * 9
}

/// Hides the app window, captures the primary display as a base64 PNG,
/// restores the window, then returns the encoded string.
/// Returns Err("permission_denied") if the captured frame is entirely black
/// (macOS silently returns black when Screen Recording access is denied).
/// NOTE: Do NOT use CGPreflightScreenCaptureAccess() as a gate — it returns
/// false for ad-hoc/unsigned builds even when the user has granted permission.
#[tauri::command]
fn capture_screenshot(window: WebviewWindow) -> Result<String, String> {
    window.hide().map_err(|e| e.to_string())?;
    std::thread::sleep(std::time::Duration::from_millis(300));

    let result = (|| -> Result<String, String> {
        let screens = Screen::all().map_err(|e| e.to_string())?;
        let screen = screens
            .first()
            .ok_or_else(|| "No display found".to_string())?;

        let image = screen.capture().map_err(|e| e.to_string())?;

        let temp_path = std::env::temp_dir().join("qr-converter-capture.png");
        image.save(&temp_path).map_err(|e| e.to_string())?;

        let bytes = std::fs::read(&temp_path).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&temp_path);

        if looks_like_black_frame(&bytes) {
            return Err("permission_denied".to_string());
        }

        Ok(general_purpose::STANDARD.encode(&bytes))
    })();

    let _ = window.show();
    result
}

/// Opens macOS System Settings → Privacy & Security → Screen Recording.
/// No-op on non-macOS platforms.
#[tauri::command]
fn open_privacy_settings() {
    #[cfg(target_os = "macos")]
    screen_permission::open_privacy_settings();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            capture_screenshot,
            open_privacy_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

### 4.7 `src-tauri/Cargo.toml`

```toml
[package]
name = "qr-converter"
version = "0.1.0"
description = "QR Code Converter"
authors = []
edition = "2021"

[lib]
name = "app_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
screenshots = "0.8"
base64 = "0.22"
image = { version = "0.25", default-features = false, features = ["png"] }
```

### 4.8 `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "QR Converter",
  "version": "0.1.0",
  "identifier": "com.lcsk42.qr-converter",
  "build": {
    "frontendDist": "../dist",
    "devUrl": "http://localhost:1420",
    "beforeDevCommand": "npm run dev",
    "beforeBuildCommand": "npm run build"
  },
  "app": {
    "withGlobalTauri": false,
    "windows": [
      {
        "title": "QR Converter",
        "width": 1024,
        "height": 768,
        "minWidth": 1024,
        "minHeight": 768,
        "resizable": true,
        "fullscreen": false
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "macOS": {
      "infoPlist": "Info.plist"
    }
  }
}
```

### 4.9 `src-tauri/capabilities/default.json`

```json
{
  "identifier": "default",
  "description": "Default capability for the main window",
  "windows": ["main"],
  "permissions": [
    "core:default",
    "core:window:allow-set-fullscreen"
  ]
}
```

### 4.10 `src-tauri/Info.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSScreenCaptureUsageDescription</key>
  <string>QR Converter needs screen capture access to detect QR codes from your screen.</string>
</dict>
</plist>
```

### 4.11 `package.json`

```json
{
  "name": "qr-converter",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "tauri": "tauri",
    "build:mac": "rustup target add aarch64-apple-darwin x86_64-apple-darwin && npm run tauri build -- --target universal-apple-darwin",
    "build:win": "npm run tauri build -- --target x86_64-pc-windows-msvc"
  },
  "dependencies": {
    "@tauri-apps/api": "^2.0.0",
    "jsqr": "^1.4.0",
    "lucide-react": "^0.400.0",
    "qrcode-generator": "^1.4.4",
    "react": "^18.3.0",
    "react-dom": "^18.3.0",
    "clsx": "^2.1.0",
    "tailwind-merge": "^2.3.0"
  },
  "devDependencies": {
    "@tauri-apps/cli": "^2.0.0",
    "@types/react": "^18.3.0",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "autoprefixer": "^10.4.19",
    "postcss": "^8.4.38",
    "tailwindcss": "^3.4.4",
    "typescript": "^5.4.5",
    "vite": "^5.3.1"
  }
}
```

### 4.12 `vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
```

### 4.13 `tailwind.config.js`

```js
/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

### 4.14 `tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "useDefineForClassFields": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
```

### 4.15 `.github/workflows/build.yml`

```yaml
name: Build

on:
  workflow_dispatch:
  push:
    tags:
      - "v*"

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: macos-latest
            args: --target universal-apple-darwin
            artifact_name: macos
          - os: windows-latest
            args: --target x86_64-pc-windows-msvc
            artifact_name: windows

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Add macOS universal targets
        if: matrix.os == 'macos-latest'
        run: rustup target add aarch64-apple-darwin x86_64-apple-darwin

      - name: Install frontend dependencies
        run: npm ci

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ${{ github.ref_name }}
          releaseName: QR Converter ${{ github.ref_name }}
          releaseBody: |
            ## Downloads
            - **macOS** (universal · Apple Silicon + Intel): `.dmg`
            - **Windows** (x64): `.msi` or `.exe` installer
          releaseDraft: true
          prerelease: false
          args: ${{ matrix.args }}
```

---

## 5. 核心功能逻辑说明

### 5.1 QR 码生成

- 触发：`text` state 变化时通过 `useEffect` 自动调用 `renderQR`
- 库：`qrcode-generator`，纠错等级 `"M"`，类型编号 `0`（自动）
- 渲染到 420×420 的 canvas，内容区 388×388（各留 16px padding）
- 每个 module 的像素大小 = `Math.floor(388 / moduleCount)`
- 偏移量居中计算：`Math.floor((388 - moduleCount * cellSize) / 2) + 16`
- 内容为空时清空 canvas 并隐藏
- 内容超出容量时显示错误文字

### 5.2 截图识别流程

```
点击按钮
  │
  ▼
invoke("capture_screenshot")          ← Rust：隐藏窗口 → 300ms → 截图 → 显示窗口
  │                                      返回 base64 PNG 字符串
  ▼
base64 → Blob → ObjectURL → Image
  │
  ▼
setFullscreen(true)                   ← Tauri Window API
  │
  ▼
appState = "selecting"
  │  显示全屏覆盖层（canvas + 暗色遮罩）
  ▼
用户拖拽选区 ──── mousedown/move/up 事件
  │
  ▼
计算裁剪坐标（CSS px → 截图原始 px，乘以 scaleX/scaleY）
  │
  ▼
setFullscreen(false)
  │
  ▼
offscreen canvas 裁剪图像
  │
  ▼
jsQR(imageData, width, height)
  │
  ├── 找到 → setText(result.data)
  └── 未找到 → appState = "not-found"（2.5s 后恢复 idle）
```

### 5.3 选区覆盖层渲染

- canvas 设为 `position: fixed; inset: 0`，监听 `resize` 事件动态更新 `canvas.width/height`（处理全屏切换动画完成的时机）
- 使用 **4 个暗色矩形**包围选区（非 composite 操作），避免渲染顺序问题
- 蓝色边框 `#1d9bf0` + 四角 8px 方形手柄
- 选区左上角（或右下角）显示尺寸提示（`W × H` px）
- 选区 < 5px 时忽略，不触发识别
- ESC 键取消，恢复窗口并清理 ObjectURL

### 5.4 AppState 状态机

```
idle
 ├─→ capturing（点击按钮）
 │     ├─→ selecting（截图成功）
 │     │     └─→ idle（框选完成 / ESC）
 │     ├─→ not-found（识别失败，2.5s → idle）
 │     ├─→ error（截图异常，2.5s → idle）
 │     └─→ permission_denied（macOS 权限拒绝，点击按钮 → idle）
 └─→ （直接在 idle 状态输入文本，实时生成 QR）
```

### 5.5 macOS 权限处理

- Rust 侧：不使用 `CGPreflightScreenCaptureAccess()` 作为前置检查（对 ad-hoc 签名的应用不可靠）
- 改为截图后检测黑帧：采样每 64 个像素，若 >90% 像素的 RGB 均 < 16，判定为权限拒绝，返回 `Err("permission_denied")`
- 前端捕获此错误后切换到 `permission_denied` 状态，显示橙色提示 + "Open Privacy & Security Settings →" 按钮
- 点击该按钮调用 `open_privacy_settings` Tauri 命令，通过 `open` 打开系统设置

### 5.6 复制功能

- 使用 `navigator.clipboard.writeText`
- 复制成功后图标由 `Copy` 变为 `Check`，1500ms 后恢复

---

## 6. 图标

图标由 `scripts/gen_icon.py`（需要 Python 3 + Pillow）生成 1024×1024 PNG，设计为：

- 深海军蓝背景 `#0f172a`，macOS 风格圆角（radius 220）
- 三个 QR Finder Pattern（7×7 模块，白色边框 + 深色内框 + 蓝色 `#3b82f6` 中心点）
- 计时点（Timing pattern）连接左上角
- 右下角 5×5 数据点阵

生成后运行以下命令派生所有平台所需尺寸：

```bash
npm run tauri icon ./src-tauri/icons/source.png
```

---

## 7. 构建与运行

### 环境依赖

| 工具 | 要求 |
|---|---|
| Node.js | ≥ 18 |
| Rust | stable（通过 rustup 安装）|
| Tauri CLI | 随 devDependencies 安装 |
| macOS 构建 | Xcode Command Line Tools |
| Windows 构建 | MSVC Build Tools |

### 命令

```bash
# 安装依赖
npm install

# 开发模式（热重载）
npm run tauri dev

# 生产构建（当前平台）
npm run tauri build

# macOS Universal Binary（Apple Silicon + Intel，仅在 macOS 执行）
npm run build:mac
# 产物：src-tauri/target/universal-apple-darwin/release/bundle/macos/QR Converter.app
#       src-tauri/target/universal-apple-darwin/release/bundle/dmg/QR Converter_0.1.0_universal.dmg

# Windows x64（仅在 Windows 执行）
npm run build:win
# 产物：src-tauri/target/x86_64-pc-windows-msvc/release/bundle/msi/
#       src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/

# 仅检查 Rust 编译
cd src-tauri && cargo check
```

### CI 自动构建

推送 `v*` 格式的 tag（如 `git tag v1.0.0 && git push --tags`）后，GitHub Actions 自动在 macOS 和 Windows runner 上并行构建，产出 Draft Release。

---

## 8. 已知限制

| 问题 | 原因 | 现状 |
|---|---|---|
| macOS 每次重新安装后需重新授权 Screen Recording | TCC 以代码签名 identity 识别应用，ad-hoc 签名的新二进制被视为不同应用 | 可通过 Apple Developer ID 签名彻底解决 |
| Windows 需要 WebView2 | Tauri 在 Windows 上依赖系统 WebView2 | Windows 10/11 已预装，无需手动安装 |
| 截图分辨率固定为主屏幕 | `Screen::all().first()` 只取第一块屏幕 | 多屏场景无法选择副屏 |
