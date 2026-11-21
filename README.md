<p align="center">
  <img src="./assets/logo-style-b.png" alt="传彩笔 CAIBI Logo" width="160" />
</p>

<h1 align="center">传彩笔 CAIBI</h1>

<p align="center">
  <strong>Chrome Asset & Image Breakdown Inspector</strong> · 常驻游标的视觉逆向工程与资产编译扩展（MV3）
</p>

<p align="center">
  <a href="#中文文档">中文</a> | <a href="#english-documentation">English</a>
</p>

---

## 中文文档

**传彩笔 CAIBI**（**C**hrome **A**sset & **I**mage **B**reakdown **I**nspector）是一款常驻浏览器游标的视觉逆向工程与资产编译 Chrome MV3 扩展。

悬停任意网页图片并按 **Alt + 右键**（或 **Alt + Q**，亦可在设置中开启悬浮 `[+]` 徽章），光标旁即刻弹出瑞士黑白机能风 HUD；也可点击扩展图标打开工作台，上传本地图片、拖拽文件或输入图片 URL 进行分析。

### 核心功能

1. **0-token 本地物理分析**（纯 Canvas，无外部依赖）
   - **五色板提取**：基于 K-Means（`k=5×10` 迭代）提取精确 Hex 色值与面积占比，支持点击复制。
   - **画幅与构图参数**：计算最简整数宽高比与推荐 `--ar` 参数。
   - **明度直方图**：统计 Shadows / Midtones / Highlights 分布、σ 对比度与光调标签。
   - 触发后默认停留在**手动确认态**，不会自动消耗任何 API 额度。
2. **双 Agent 解耦视觉逆向编译**（OpenAI 兼容协议，流式输出）
   - **Agent 1**（视觉解构）：结合图像与 Canvas 预提取物理元数据，执行零预设穷举列键与空间坐标级填值，输出纯中文结构化 **JSON 提示词**（7 个核心键 + 按画面复杂度动态追加的细分键，完整抄录可见文字）。
   - **Agent 2**（无损压缩）：将 Agent 1 的结构化结果无损压缩为电报式**精简提示词**（固定画幅比例，一字不漏保留可见文字原文）。
   - 支持分阶段流式进度展示、随时取消、内联编辑提示词，以及复制或下载 **Obsidian Markdown** 笔记（含 YAML frontmatter）。
3. **可选生图与全局人物资产库**
   - 在设置中填写可选生图模型后，可在待确认态直接提取 **50/50 人物资产图**或**漫转真人资产图**，也可在工作区基于 JSON 提示词或精简提示词生图。
   - 支持统一选择当前原图、本地上传图或人物资产库图片作为垫图，自动兼容 `/images/edits`、`/chat/completions`（多模态 / SSE）与 `/images/generations` 端点回退。
4. **全局 IndexedDB 历史库**
   - 由后台 Service Worker 统一维护扩展域 IndexedDB（`vrc-history`，含 `records` 与 `assets` 对象库），跨站点共享记录。
   - 支持关键词与 12 色系筛选、一键恢复历史工作区、单条删除、批量导出 `.md` 与二次确认清空。

### 技术栈

- [WXT](https://wxt.dev) 0.19（Vite 底座，MV3）+ React 18 + TypeScript strict
- Tailwind CSS 3，经 `cssInjectionMode: 'ui'` 注入 **Shadow DOM**（`vrc-hud`），与宿主页面样式完全隔离
- `idb` 封装扩展域全局 IndexedDB（`vrc-history`）；`chrome.storage.local`（`vrc_settings`）存储 BYOK 本地设置
- CORS 代理：后台 Service Worker 以 `host_permissions: <all_urls>` 抓图，经 `OffscreenCanvas` 缩放至 ≤1024px 后返回 Data URL 与原始宽高；长耗时流式编译通过 `chrome.runtime.Port`（`vrc-compile`）与保活心跳稳定传输

### 开发与构建

```bash
npm install        # 安装依赖并自动执行 wxt prepare 生成类型
npm run dev        # 开发模式（自动打开浏览器 + HMR）
npm run build      # 生产构建 → .output/chrome-mv3/
npm run zip        # 打包 zip（商店发布用）
npm run typecheck  # tsc --noEmit 全量类型检查
npm run test:e2e   # 启动真实 Chrome 运行 Puppeteer 端到端验收测试
```

### 加载到 Chrome

1. 执行 `npm run build`，生成 `.output/chrome-mv3/` 目录；
2. 打开 `chrome://extensions`，开启右上角**开发者模式**；
3. 点击**加载已解压的扩展程序**，选择 `.output/chrome-mv3`；
4. 悬停图片按 **Alt + 右键** / **Alt + Q**，或右键图片选择**传彩笔 CAIBI · 视觉逆向解剖**，或点击工具栏图标打开工作台；
5. 打开**设置**，填入 OpenAI 兼容 **Base URL**、**API Key** 与必填的**视觉模型名**（支持点击**拉取模型**从 `/models` 自动获取），按需选配**生图模型**与触发方式。

### 目录结构

```
src/
├── assets/content.css          # Tailwind 入口与自定义滚动条样式
├── public/icon-{16,48,128}.png # 扩展图标
├── entrypoints/
│   ├── background.ts           # CORS 抓图代理、右键菜单、Port 流式编译、生图转发与 IndexedDB 读写
│   ├── content.tsx             # Shadow DOM HUD 挂载与生命周期清理
│   └── content/triggers.ts     # Alt+右键 / Alt+Q / 可选悬浮 [+] 徽章触发器
├── components/
│   ├── HudApp.tsx              # HUD 状态机、拖拽与视口钳制
│   ├── HudWorkspace.tsx        # 结果工作区（标签、资产提取、垫图栏、提示词编辑与 Markdown 导出）
│   ├── ImageGenPanel.tsx       # 生图面板（触发、放大预览、下载与存入资产库）
│   ├── PhysicsBar.tsx          # Hard Facts Bar（尺寸、宽高比、--ar、五色板、明度直方图）
│   ├── HistoryDrawer.tsx       # 历史抽屉（记录筛选、批量导出与资产库管理）
│   ├── SettingsModal.tsx       # OpenAI 兼容 BYOK 设置与模型拉取
│   └── ui.tsx                  # 公共基础组件
├── services/
│   ├── promptSpec.ts           # 双 Agent 解构与无损精简 System Prompt
│   ├── visionCompiler.ts       # OpenAI 兼容流式视觉编译、模型拉取与记录规范化
│   ├── imageGenerator.ts       # OpenAI 兼容生图多端点回退与响应解析
│   ├── db.ts                   # IndexedDB CRUD、色系分类与 Obsidian Markdown 导出
│   └── settings.ts             # chrome.storage.local 读写与配置归一化
└── utils/
    ├── imagePhysics.ts         # K-Means 色板、比例化简与明度直方图分析
    ├── base64.ts               # ArrayBuffer 转 Base64 与扩展名推断
    ├── clipboard.ts            # 剪贴板复制与回退
    └── types.ts                # 领域类型与默认设置
```

---

## English Documentation

**CAIBI** (**C**hrome **A**sset & **I**mage **B**reakdown **I**nspector) is a cursor-resident visual reverse-engineering and asset-compiling Chrome MV3 extension.

Hover over any web image and press **Alt + Right-Click** (or **Alt + Q**, with an optional floating `[+]` badge) to pop up a Swiss brutalist HUD next to your cursor. You can also click the toolbar icon to upload local images, drag-and-drop files, or analyze an image URL directly.

### Core Features

1. **0-Token Local Physics Analysis** (pure Canvas, zero external dependencies)
   - **5-Color Palette**: Extracts exact Hex values and area percentages via K-Means (`k=5×10` iterations) with one-click copy.
   - **Aspect Ratio**: Computes the simplified integer ratio and recommended `--ar` flag.
   - **Luminance Profile**: Measures Shadows / Midtones / Highlights distribution, contrast σ, and lighting key tag.
   - Always stops at a **manual confirmation state** so no LLM tokens are spent without explicit action.
2. **2-Agent Decoupled Vision Compilation** (OpenAI-compatible API, SSE streaming)
   - **Agent 1 (Diverge)**: Anchors on the image and Canvas physics metadata to exhaustively enumerate fine-grained visual keys and spatial coordinates in Chinese JSON (`7` core keys + dynamic sub-keys, including verbatim OCR of all visible text).
   - **Agent 2 (Converge)**: Compresses Agent 1's output into a lossless telegraphic `short_prompt` with fixed aspect ratio and verbatim text retention.
   - Supports staged streaming progress, cancellation, inline editing of JSON and short prompts, and **Obsidian Markdown** copy/download with YAML frontmatter.
3. **Optional Image Generation & Character Asset Library**
   - Configure an optional image generation model in Settings to extract **50/50 character sheets** or **anime-to-real character sheets** directly, or generate images from either prompt block.
   - Supports unified reference image selection (current source image, local upload, or saved character assets) with automatic fallback across `/images/edits`, `/chat/completions` (multimodal / SSE), and `/images/generations`.
4. **Global Extension-Origin IndexedDB History**
   - Maintained centrally by the background Service Worker (`vrc-history` with `records` and `assets` stores) across all websites.
   - Supports keyword and 12-color-family filtering, one-click workspace restoration, batch `.md` export, and two-step clear confirmation.

### Tech Stack

- [WXT](https://wxt.dev) 0.19 (Vite-based, MV3) + React 18 + TypeScript strict
- Tailwind CSS 3 injected into **Shadow DOM** (`vrc-hud`) via `cssInjectionMode: 'ui'` for full style isolation
- `idb` for extension-origin IndexedDB (`vrc-history`); `chrome.storage.local` (`vrc_settings`) for BYOK settings
- Background Service Worker CORS proxy (`host_permissions: <all_urls>` + `OffscreenCanvas` ≤1024px downscaling) and `chrome.runtime.Port` (`vrc-compile`) keepalive streaming

### Development & Build

```bash
npm install        # Install dependencies and run wxt prepare
npm run dev        # Start dev mode with HMR
npm run build      # Production build → .output/chrome-mv3/
npm run zip        # Package zip for Chrome Web Store
npm run typecheck  # Run tsc --noEmit
npm run test:e2e   # Run Puppeteer end-to-end acceptance suite in Chrome
```

### Load into Chrome

1. Run `npm run build` to generate `.output/chrome-mv3/`;
2. Open `chrome://extensions` and enable **Developer mode**;
3. Click **Load unpacked** and select `.output/chrome-mv3`;
4. Hover any image and press **Alt + Right-Click** / **Alt + Q**, use the context menu **传彩笔 CAIBI · 视觉逆向解剖**, or click the extension icon;
5. Open **Settings** and configure your OpenAI-compatible **Base URL**, **API Key**, and required **Vision Model** (or click **Fetch Models** via `/models`), plus optional **Image Gen** settings and trigger mode.

### Directory Structure

```
src/
├── assets/content.css          # Tailwind entry and custom scrollbar styles
├── public/icon-{16,48,128}.png # Extension icons
├── entrypoints/
│   ├── background.ts           # CORS image proxy, context menu, Port streaming, image gen relay & IndexedDB
│   ├── content.tsx             # Shadow DOM HUD mounting and lifecycle cleanup
│   └── content/triggers.ts     # Alt+RightClick / Alt+Q / optional floating [+] badge triggers
├── components/
│   ├── HudApp.tsx              # HUD state machine, dragging & viewport clamping
│   ├── HudWorkspace.tsx        # Workspace (tags, character extraction, shared ref bar, prompt editors & MD export)
│   ├── ImageGenPanel.tsx       # Collapsible image generation panel
│   ├── PhysicsBar.tsx          # Hard Facts Bar (dimensions, ratio, --ar, 5-color palette, luminance)
│   ├── HistoryDrawer.tsx       # History & character asset library drawer
│   ├── SettingsModal.tsx       # OpenAI-compatible BYOK settings & model picker
│   └── ui.tsx                  # Shared UI primitives
├── services/
│   ├── promptSpec.ts           # 2-agent diverge & lossless converge system prompts
│   ├── visionCompiler.ts       # OpenAI-compatible SSE compilation, model listing & normalization
│   ├── imageGenerator.ts       # OpenAI-compatible image gen multi-endpoint fallback & response parsing
│   ├── db.ts                   # IndexedDB CRUD, color family classifier & Obsidian Markdown exporter
│   └── settings.ts             # chrome.storage.local persistence & normalization
└── utils/
    ├── imagePhysics.ts         # K-Means palette, ratio simplification & luminance histogram
    ├── base64.ts               # ArrayBuffer-to-Base64 & extension inference
    ├── clipboard.ts            # Clipboard copy with fallback
    └── types.ts                # Domain types & default settings
```
