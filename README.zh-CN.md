# QR Converter

[English](README.md) | 简体中文

[![Build](https://github.com/lcsk42/qr-converter/actions/workflows/build.yml/badge.svg)](https://github.com/lcsk42/qr-converter/actions/workflows/build.yml)

一个基于 Tauri 2 的轻量桌面应用：把文本转成二维码，也能把二维码截图还原成文本。

单个二维码最多容纳 **2,331 个 UTF-8 字节**（Version 40，纠错级别 M）。文本超过这个长度时，应用会把它切分成一组带顺序和校验的二维码，并分页展示。逐页截图后，按任意顺序粘贴回来即可完整还原原文。

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [使用](#使用)
- [多二维码传输流程](#多二维码传输流程)
- [协议](#协议)
- [上限](#上限)
- [开发](#开发)
- [测试](#测试)
- [打包与发布](#打包与发布)
- [常见问题](#常见问题)
- [安全说明](#安全说明)

---

## 功能

- **文本 → 二维码** — 实时生成单码（`qrcode-generator`，纠错 M，自动版本，最高 Version 40）。
- **自动多码分段** — 超过 2,331 字节后自动切成 4×3、每页 12 个二维码的分页网格，并提供 **Capture mode（截屏模式）** 方便整页截图。
- **截图 → 文本** — 使用 [zxing-wasm](https://github.com/Sec-ant/zxing-wasm) 一次识别截图中的 **所有** 二维码；jsQR 仅作为单码兜底。
- **顺序无关的还原** — 每段都带有序号和总数，页面可以任意顺序粘贴；重复、重叠的截图会自动去重；整组数据用 CRC32 校验。
- **进度提示** — 接收过程中状态栏显示 `Received 3 of 7 segments — missing 4, 6, 7`，未收齐时不会覆盖文本框。
- **高 DPI 感知渲染** — 画布后备分辨率跟随 `devicePixelRatio`，在 125%/150%/200% 缩放下仍保持 1–2 像素模块清晰。
- **原生分辨率解码** — 截图按 24 MP 像素预算处理，不再盲目缩放到 2000 px。
- **支持 GBK/GB18030** — 二维码载荷不是 UTF-8 时会回退到 GB18030，兼容旧版中文/Windows 工具生成的码。
- **编辑辅助** — 一键复制全文；一键“压缩空白”，删除空格、Tab、换行、全角空格、NBSP 等所有空白字符。
- **Windows 双安装包** — 小体积在线包 + 内嵌 WebView2 的离线包。
- **macOS 通用包** — 一个 `.dmg` 同时支持 Apple Silicon 和 Intel。

---

## 安装

从 [GitHub Releases](https://github.com/lcsk42/qr-converter/releases) 下载最新产物。

### macOS

- 文件：`QR.Converter_<版本>_universal.dmg`（Apple Silicon + Intel，macOS 11+）。
- 当前构建 **未做代码签名和公证**。首次打开可能被 macOS 拦截；请到 **系统设置 → 隐私与安全性** 中为该应用选择 **仍要打开**。只对信任的构建做此操作。
- 如果系统提示应用“已损坏”，请先确认下载完整；本地构建可直接从源码重新打包。

### Windows（x64，Windows 10 1809 / LTSC 及以上）

| 产物 | WebView2 | 体积 | 安装方式 | 网络 |
|---|---|---|---|---|
| `…windows-x64-online-setup.exe` | 不内嵌 | 小 | 当前用户 | 仅在 WebView2 缺失/过旧时需要 |
| `…windows-x64-offline-setup.exe` | 内嵌 x64 离线安装器 | 约 300 MB | 全机器安装（管理员） | 不需要 |

- **在线版**使用微软 WebView2 bootstrapper：WebView2 缺失或低于 `109.0.1518.140` 时联网下载并安装。
- **离线版**内嵌微软官方 x64 WebView2 离线安装器（2026 年约 294 MB），仅在缺失/过旧时静默安装，适合内网、断网或网络不稳定的机器。
- Windows 只生成 NSIS `.exe`，不生成 `.msi`。
- Windows 构建未做代码签名，SmartScreen 可能提示；选择 **更多信息 → 仍要运行** 即可。

---

## 使用

### 单码

1. 在输入框中输入或粘贴文本。
2. 文本不超过 2,331 个 UTF-8 字节时，下方显示一个 420×420 二维码。
3. 输入框右上角有两个按钮（竖排）：
   - **Copy**：复制全文。
   - **Compress whitespace**：删除所有空白字符，包括普通空格、Tab、换行、全角空格、NBSP 等；零宽连接符（ZWJ）会保留，因此 emoji 组合不会被破坏。
4. 把二维码截图粘贴回应用，即可恢复文本。

### 多码

文本超过 2,331 字节时，二维码区域会变成分页网格：

- 4 列 × 3 行，**每页 12 个二维码**
- 每个卡片 210×210 CSS px，对应一个分段
- 工具栏显示二维码数量、总字节数、每段数据上限、页码和段号范围
- **Capture mode** 会隐藏输入框和状态栏，只显示当前页，方便整页截图

典型流程：

1. 输入/粘贴文本，应用自动拆分。
2. 点击 **Capture mode**。
3. 截取当前页（macOS `⌘⇧4`，Windows `Win+Shift+S`；建议只截应用窗口）。
4. 点 `›` 翻到下一页，重复截图，直到所有页截完。
5. 在接收端窗口逐张粘贴截图（macOS `⌘V`，Windows `Ctrl+V`）。
6. 观察状态栏的接收进度和缺失段号；粘贴顺序不限，重复截图无害。
7. 收齐后，输入框自动填入原文，状态显示 `Restored N segments`。

接收过程中 **不要编辑输入框**：手动编辑会清空已接收的分段缓存，需要重新粘贴所有页。

### 粘贴图片

应用读取的是剪贴板中的 **图像数据**，不是文件路径。

- macOS：在预览中打开图片，`⌘A`、`⌘C`，然后回到应用 `⌘V`。
- Windows：从截图工具/照片复制图片，`Ctrl+V`；Windows 还会通过 `navigator.clipboard.read()` 读取，以兼容 WebView2。
- 截图必须保持无损、不要缩放。JPEG 二次压缩、缩放或裁掉卡片边缘都可能导致高密度二维码无法识别。

### 单码/多码解码规则

- 截图中只要包含分段格式的码，就会按分段累积；同一张图里的普通二维码会被忽略。
- 没有分段码且只有一个普通二维码时，直接载入其文本。
- 有多个普通二维码时，按阅读顺序（从上到下、从左到右）取第一个，并在状态栏提示。
- 旧版本中“内容过大”的单码现在会自动变成多码网格；只有超过 589,815 字节才会报错。

---

## 多二维码传输流程

```text
文本 > 2,331 字节
        │
        ▼
  按 Unicode 码点切分
  （每段数据 ≤2,313 字节）
        │
        ▼
  每个二维码 = 18 字节头 + 数据
        │
        ▼
  4×3 分页网格 → Capture mode → 截图
        │
        ▼
  任意顺序粘贴截图
        │
        ▼
  zxing-wasm 一次识别所有二维码
        │
        ▼
  按 CRC32 传输 ID 累积
  （序号/总数、去重、报告缺失）
        │
        ▼
  按序号拼接 → CRC32 校验 → UTF-8 → 文本框
```

建议实际使用不超过 **64 段**（约 145 KiB，6 页）。协议硬上限是 255 段。

---

## 协议

每个分段二维码以固定的 **18 字节 ASCII 头** 开头：

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0..3 | 4 | `QRS1` — 魔数与协议版本 |
| 4..11 | 8 | 完整 UTF-8 内容的 CRC32，8 位大写十六进制 |
| 12..14 | 3 | 段序号，十进制 `000`–`254` |
| 15..17 | 3 | 总段数，十进制 `002`–`255` |
| 18.. | n | 段数据（原文 UTF-8 字节切片） |

- 单码容量：**2,331 B**（Version 40，纠错 M，Byte 模式）→ 去掉头后每段 **2,313 字节**。
- 单次传输上限：**255 × 2,313 = 589,815 字节 ≈ 576 KiB**（约 19.6 万个 3 字节汉字）。
- CRC32 同时作为传输 ID 和完整性校验；不同批次的段不会被静默混在一起。
- 切分严格按 Unicode 码点边界进行，不会截断中文或 emoji。孤立代理项会规范化为 U+FFFD，保证 qrcode-generator 与 `TextEncoder` 的编码一致。
- 还原顺序来自段内的 `index`，与截图布局、粘贴顺序无关；乱序、缺段后补齐都能正确还原。
- 不超过 2,331 字节的文本仍使用普通单码，不添加头，保持与其他二维码工具的兼容性。

---

## 上限

| 项目 | 数值 |
|---|---|
| 单码容量 | 2,331 个 UTF-8 字节（V40-M） |
| 每个分段二维码的数据量 | 2,313 字节 |
| 单次传输最多段数 | 255 |
| 单次传输最大内容 | 589,815 字节 ≈ 576 KiB |
| 每页二维码数 | 12（4×3，210 px 卡片） |
| 255 段需要 | 22 页 |
| 建议实际上限 | 64 段 ≈ 145 KiB（6 页） |
| 解码像素预算 | 24 MP |

说明：

- Windows 离线包体积大，是因为微软官方 x64 WebView2 离线安装器本身约 294 MB。官方没有更小的离线 WebView2。
- macOS 产物是通用包，但当前未签名；正式分发建议补 Developer ID 签名和公证。
- Windows 产物未签名；正式分发建议补 Authenticode 证书。

---

## 开发

### 环境要求

- Node.js 20+ 与 npm
- Rust stable
- Tauri 2 对应的系统依赖：
  - macOS：Xcode Command Line Tools
  - Windows：Visual Studio Build Tools（C++ 工作负载）与 WebView2
  - Linux：WebKitGTK/GTK 开发包（参考 Tauri 官方 prerequisites）
- 构建 macOS 通用包需要 `aarch64-apple-darwin` 和 `x86_64-apple-darwin` 两个 rustup target

### 初始化

```bash
npm install
npm run tauri dev      # 桌面应用（Vite :1420 + Tauri 窗口）
```

只开发前端：

```bash
npm run dev            # 浏览器预览；Tauri IPC（write_log）会静默失败
```

### 常用命令

| 命令 | 用途 |
|---|---|
| `npm run tauri dev` | 启动桌面应用 |
| `npm run dev` | 浏览器中只跑前端 |
| `npm run build` | `tsc` + Vite 生产构建 |
| `npx tsc --noEmit` | 前端类型检查 |
| `cd src-tauri && cargo check` | 检查 Rust 后端 |
| `npm test` | Vitest（jsdom），99 项测试 |
| `npm run test:watch` | Vitest watch 模式 |
| `npm run test:rust` | `cargo test`，7 项测试 |
| `npm run build:mac` | macOS 通用 `.dmg` |
| `npm run build:win` | Windows x64 **在线** NSIS `.exe` |
| `npm run build:win:offline` | Windows x64 **离线** NSIS `.exe`（内嵌 WebView2） |

项目未配置 linter/formatter。

### 项目结构

| 路径 | 作用 |
|---|---|
| `src/App.tsx` | UI、粘贴管线、分段累积、状态 |
| `src/segments.ts` | 分段信封、CRC32、UTF-8 切分、重组、上限 |
| `src/decode.ts` | zxing-wasm 多码解码、jsQR 兜底、GB18030 载荷解码、像素预算 |
| `src/qrRender.ts` | DPR 感知的二维码绘制、单码/卡片尺寸、清空 |
| `src/platform.ts` | 供测试固定 `isMac` 的接缝 |
| `src/test/` | Canvas/粘贴测试基建与 GBK fixture 辅助 |
| `src-tauri/src/lib.rs` | Tauri 命令（`write_log`）与启动日志 |
| `src-tauri/tauri.conf.json` | 窗口、打包、Windows 在线安装配置 |
| `src-tauri/tauri.offline.conf.json` | Windows 离线安装覆盖配置（`offlineInstaller`、全机器安装） |
| `.github/workflows/build.yml` | CI：测试 + macOS 通用 + Windows 在线/离线 |
| `CLAUDE.md` | 面向 Claude Code 的仓库说明 |

### 架构

#### 前端

- `segments.ts` 中的 `createQRPlan(text)` 决定 `empty` / `single` / `sheet` / `error` 四种状态。
- 单码：420×420 画布，16 px 内边距，模块尺寸 `floor(inner / moduleCount)`。
- 分码：每页 12 个卡片，210×210 CSS px，8 px 内边距。
- 渲染是 DPR 感知的：后备尺寸 = `round(cssSize × devicePixelRatio)`，模块使用整数设备像素。画布的 CSS 尺寸不变，因此系统缩放变化不会影响布局。
- **Capture mode** 是固定全窗口的页面视图，一页 12 个卡片，截图里不会混入编辑区。

#### 解码

`decodeQRCodes(imageData)`：

1. 懒加载 zxing-wasm（通过 Vite `?url` 本地打包；显式 `fetch` 后以 `wasmBinary` 注入，不依赖 CDN，也不依赖 wasm MIME/流式编译）。
2. 调用 `readBarcodes(imageData, { formats: ["QRCode"], tryHarder: true, tryRotate: true })`。
3. 返回每个结果的 **原始 `bytes`** 和位置。原始字节很重要：应用先严格按 UTF-8 解码，失败再回退 GB18030。
4. 如果 WASM 加载失败，退回 jsQR 的单码解码。

粘贴的图片按 24 MP 像素预算处理（不是固定 2000 px 最长边）：高密度卡片可能只有 1 个设备像素/模块，缩放会直接破坏识别。

#### 分段累积

- 待接收数据按 CRC32 分组，最多同时保留三组。
- 入站分段会校验总数、比较重复序号的数据，并按序号去重；只存在内存中。
- 当 `parts.size === total` 时，按序号拼接、校验 CRC32、严格 UTF-8 解码，然后写入文本框。
- 未收齐只更新状态栏，不覆盖文本框。
- 手动编辑文本框会清空待接收数据；普通二维码结果也会清空。

#### 粘贴处理

- **macOS**：只注册 `paste` 事件。keydown 时读取剪贴板会和原生粘贴竞争，导致第一次 ⌘V 被吞掉。
- **Windows**：注册 Ctrl+V 的 `keydown` 处理器，读取 `navigator.clipboard.read()`（WebView2 的 `clipboardData` 经常缺少图片项），同时保留 `paste` 事件兜底。
- `handlePaste` 对图片粘贴调用 `preventDefault()`，即使跳过处理也不会让原生粘贴并行执行。
- `processingRef` 防止重复处理；在 `finally`、图片错误和 5 秒加载超时后释放。

#### 日志

`log()` / `logError()` 同时写浏览器控制台和 Rust 的 `write_log` 命令，日志追加到可执行文件旁边的 `qr-converter.log`（不可写时回退到临时目录）。日志失败不会影响 UI。

---

## 测试

```bash
npm test               # 前端 99 项测试（9 个文件）
npm run test:rust      # 后端 7 项测试
npx tsc --noEmit
cd src-tauri && cargo check
```

组件测试是真实的像素往返，不是 mock：

- `src/test/setup.ts` 用 `@napi-rs/canvas` 为 `HTMLCanvasElement.getContext("2d")` 提供真实画布，测试会真正绘制像素并读回。
- zxing-wasm 在测试中通过 `wasmBinary` 注入（jsdom 无法 fetch Vite 打包的 wasm）。
- `installPastePipeline()` 让图片管线的离屏画布模拟粘贴图片的像素。
- `src/App.sheet.test.tsx` 会生成分页、把卡片像素合成为截图、**乱序**粘贴两页、重复粘贴一页，并断言原文被完整还原。
- `src/App.mac.test.tsx` / `App.win.test.tsx` 固定 `isMac`，因此在任何宿主机上都能测试两条粘贴路径。

发布前建议手动验证：

- 干净的 Windows 10 1809/LTSC x64 虚拟机（无 WebView2、断网）：离线包应安装 WebView2 并启动应用。
- 在线包在 WebView2 缺失/过旧时的联网安装。
- macOS 通用 DMG 在 Apple Silicon 和 Intel 上的启动。
- 100%、125%、150%、200% 显示缩放下的真实截图。
- 部分页面截图、乱序粘贴、重复页面、故意损坏一个分段。

---

## 打包与发布

CI（`.github/workflows/build.yml`）在 `v*` 标签或手动触发时运行，并创建 **草稿** GitHub Release。矩阵产出三个文件：

| 平台 | 构建参数 | 资产 |
|---|---|---|
| macOS 通用 | `--target universal-apple-darwin` | `QR.Converter_<版本>_universal.dmg` |
| Windows x64 在线 | `--bundles nsis` | `QR.Converter_<版本>_windows-x64-online-setup.exe` |
| Windows x64 离线 | `--bundles nsis --config src-tauri/tauri.offline.conf.json` | `QR.Converter_<版本>_windows-x64-offline-setup.exe` |

- `releaseAssetNamePattern`（tauri-action v1）用于区分两个 Windows 安装包。
- 离线 override 设置 `webviewInstallMode = offlineInstaller`、`installMode = perMachine`、`minimumWebview2Version = 109.0.1518.140`。
- 基础配置保持小体积在线包：`downloadBootstrapper`，默认当前用户安装。
- 不生成 `.msi`。

版本升级：修改 `package.json`、`src-tauri/Cargo.toml` 以及 `src-tauri/tauri.conf.json` 的 `bundle.version`，运行 `cargo check` 更新 `Cargo.lock`，然后打 `vX.Y.Z` 标签。

---

## 常见问题

| 现象 | 处理 |
|---|---|
| macOS 提示“无法打开”/未识别开发者 | 未签名构建。到 **系统设置 → 隐私与安全性 → 仍要打开**；或从源码重新构建。 |
| Windows SmartScreen 警告 | 未签名构建：**更多信息 → 仍要运行**。 |
| Windows 安装后应用无法启动 | WebView2 缺失。使用离线安装包，或安装 WebView2 Runtime。 |
| `No QR code found in pasted image` | 截取应用窗口，使用无损截图，不要缩放/二次压缩。 |
| 提示缺少某些段 | 状态栏会列出 1-based 缺失序号。第 p 页覆盖 `(p-1)×12+1` 到 `p×12` 段，重新截取对应页即可。 |
| `Segment checksum mismatch` | 重新粘贴完整的一组截图，不要混入其他批次的段。 |
| 接收进度消失 | 手动编辑输入框会清空待接收分段。重新粘贴所有页。 |
| 内容过大 | 硬上限 589,815 字节（255 段）；建议不超过 64 段。 |
| 老 Windows 在线安装 WebView2 失败 | 改用离线安装包，已内置 x64 运行时。 |
| 高密度二维码识别失败 | 保持截图原始分辨率，尽量截取应用窗口而不是整个桌面。 |

---

## 安全说明

- CRC32 只能发现意外损坏或混段，**不是** 密码学签名，不能当作身份认证。
- 应用只解码文本，不执行二维码内容，也不会访问二维码中的 URL。
- 网络只用于 Windows **在线** 安装包的 WebView2 bootstrapper；应用本身和 zxing wasm 资源都在本地。
- 应用会在可执行文件旁写本地日志；不会把二维码内容写入日志。
- 正式公开发布建议补 macOS Developer ID 签名/公证和 Windows Authenticode 证书，以消除系统警告。
