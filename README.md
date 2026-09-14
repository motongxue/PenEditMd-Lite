# 笔削 PenEditMd-Lite（精简版）

**本地优先的 Markdown 写作 · 转换 · 预览 · 导出 轻量工作台。**

PenEditMd-Lite 是 [PenEditMd](https://github.com/motongxue/PenEditMd) 的精简派生版，基于 Electron + 微软 [markitdown](https://github.com/microsoft/markitdown)。它把 PDF / Word / Excel / PPT / 图片 / 音视频 / 网页 / 电子书 等 30+ 种格式**一键转换为 Markdown**，并内置双模式编辑、实时预览、文档树、图片内联与折叠、多格式导出。

> 与原版相比，本精简版**去掉了 AI 排版、桌面便签、主题/组件生态与公众号草稿推送**，只保留「转换 → 编辑 → 预览 → 导出」这条核心写作链路，更加轻量、启动更快、依赖更少。

---

## 功能特性

**转换**
- 拖拽 / 选择 / 双击关联文件，自动识别并转换为 Markdown（经本地 Python 后端，无需联网）
- 支持 PDF、DOCX/DOC、PPTX/PPT、XLSX/XLS、HTML、CSV、JSON、XML、EPUB、MSG、ZIP、TXT/MD、图片（JPG/PNG…）、音频、RTF、ODT 等约 30 种格式
- 图片自动内联为占位符管理，避免外部引用丢失

**编辑**
- 富文本（WYSIWYG）与源码双模式，可随时切换
- 实时预览：Markdown → HTML，支持 KaTeX 公式、Mermaid 图表、代码高亮、自动目录
- 明暗主题切换（记忆偏好）、分屏 / 专注模式、查找替换、撤销重做
- 选中文本浮动样式条 + 右键菜单，快速套用样式

**图片处理（增强）**
- 从 Typora 等编辑器导入的 `.md`，其中**本地绝对路径图片**（`C:\...\xx.png`）会自动读取并内联显示
- 单文档内嵌图片超过阈值（约 1.5MB）时自动折叠为占位符，编辑区不再卡顿；预览/导出时正常还原
- 导出 Markdown 采用 **archive 策略**：把图片抽取到 `<目录>/assets/`，`.md` 改用相对路径引用，在 Typora / VS Code / Obsidian 中都能直接打开，不会再提示「文件过大」

**文档组织**
- **文档树**：挂载工作文件夹，直接打开 / 转换其中的文件，支持新建 / 重命名 / 删除（主进程做路径越界校验）
- **会话列表右键**：对文件可「打开文件所在位置」「重命名」，方便在系统文件管理器里定位与整理

**导出**
- Markdown (.md)、HTML (.html，内联样式+图片+字体)、PDF、PNG 长图、Word (.docx)、EPUB
- 复制当前 Markdown / 排版 HTML 到剪贴板，可粘到其它编辑器或公众号后台

---

## 与原版 PenEditMd 的差异

本精简版**移除了**以下原版能力（代码与菜单均已删除）：

| 已移除 | 说明 |
|--------|------|
| AI 排版 / AI 设置 | 不再内置 LLM 润色与公众号内联样式排版 |
| 桌面便签 | 去掉独立置顶浮窗与开机自启 |
| 主题 / 组件生态 | 不再内置多套设计语言与组件插入 |
| 样式定制 | 去掉实时样式定制面板 |
| 公众号草稿箱推送 | 仅保留「复制 HTML 到剪贴板」，删除草稿箱凭证配置与推送 |

保留并持续打磨的是：转换引擎、双模式编辑、实时预览、图片内联/折叠、文档树、会话右键、明暗主题、多格式导出。

---

## 架构

```
┌──────────────────────────────────────────────┐
│ Electron 主进程  main.js                       │
│  · 拉起/管理 Python 子进程，轮询 /health        │
│  · 原生菜单、单实例锁、窗口管理                  │
│  · 全部 IPC：文件/剪贴板/导出/文档树/会话        │
└──────────┬───────────────────────┬───────────┘
           │ window.api (preload)  │  HTTP localhost:8765
           ▼                       ▼
┌──────────────────────┐   ┌──────────────────────────────────┐
│ 渲染进程 (Vite 构建)   │   │ Python 后端 (FastAPI+markitdown)    │
│ renderer/src/*.js     │   │ python-server/server.py            │
│ 编辑/预览/文档树/导出/ │   │ 打包: PyInstaller → markitdown-    │
│ 图片/主题             │   │ server(.exe) (extraResources)      │
└──────────────────────┘   └──────────────────────────────────┘
```

| 层 | 技术 | 说明 |
|----|------|------|
| UI 壳 | Electron 31 | 跨平台窗口、文件对话框、子进程管理 |
| 桥接 | preload.js | `contextBridge` 安全暴露能力，开启 `contextIsolation` |
| 渲染 | Vite 5 + 原生模块 | `marked` / `DOMPurify` / `KaTeX` / `Mermaid` 本地打包，无 CDN |
| 后端 | Python + FastAPI | 封装 markitdown 引擎（含图片内联、路径防护等增强） |
| 打包 | PyInstaller + electron-builder | 后端打单文件，前端打 NSIS 安装包 |

---

## 目录结构

```
markDownApp/
├── main.js                     # Electron 主进程
├── preload.js                  # 上下文桥接
├── package.json                # 依赖与打包配置
├── python-server/
│   ├── server.py               # FastAPI 转换服务
│   ├── requirements.txt        # Python 依赖
│   └── build.py                # PyInstaller 打包脚本
├── renderer/
│   ├── index.html              # 渲染层 HTML 外壳
│   └── src/                    # 业务模块（main / editor / richtext /
│                               #   preview / docTree / imageStore /
│                               #   exporter / officeExport / settings …）
├── build/
│   └── installer.nsh           # NSIS 自定义脚本（强杀残留进程释放文件锁）
├── scripts/
│   └── setup-python.js         # 开发态 venv 一键初始化
├── assets/                     # 应用图标等资源
├── LICENSE                     # 本项目 AGPL-3.0
├── THIRD-PARTY-LICENSES.md     # 第三方许可证明细
└── README.md
```

> 注：构建产物在 `dist/renderer/`，安装包在 `dist-electron/`。

---

## 快速开始（开发模式）

要求：Node.js ≥ 18，Python ≥ 3.10。

```bash
# 1. 安装前端依赖
npm install

# 2. 初始化 Python 环境（创建 venv 并安装 markitdown，已固化阿里云镜像）
npm run setup:python

# 3. 启动应用（自动拉起 Python 后端，端口 8765）
npm start
```

也可单独启动前端开发服务器（不拉 Electron）：

```bash
npm run dev
```

---

## 打包发布

### 1. 打包 Python 后端（单文件可执行）

```bash
npm run build:python
```

产物在 `python-server/dist/markitdown-server(.exe)`，由 electron-builder 的 `extraResources` 拷进应用资源目录，运行时由 `main.js` 拉起。

### 2. 打包桌面安装包

```bash
npm run build
```

输出在 `dist-electron/`：
- Windows：`PenEditMd Setup 0.1.0.exe`（NSIS）
- macOS：`*.dmg`
- Linux：`*.AppImage`

### 3. 推荐完整构建（CI）

```bash
npm install
npm run build:python      # 先产出生存后端可执行
npm run build             # 再打安装包
```

---

## 转换后端 API

Python 后端通过**本地 HTTP（默认端口 8765，可用环境变量 `MARKITDOWN_PORT` 覆盖）**通信：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/health` | 健康检查，返回 `{status:"ok"}` |
| GET | `/formats` | 返回支持的文件扩展名列表 |
| POST | `/convert` | multipart 上传文件，返回 `{filename, markdown}` |
| POST | `/convert_path` | JSON `{path}` 本地绝对路径，返回 `{path, markdown}` |

返回示例：

```json
{ "filename": "report.pdf", "markdown": "# 标题\n\n正文..." }
```

---

## 国内镜像与依赖安装

国内网络下安装依赖需配置镜像，以下地址**已实测可用**：

| 用途 | 地址 | 状态 |
|------|------|------|
| Electron 二进制 | `https://npmmirror.com/mirrors/electron/` | ✅ 可用 |
| PyPI（pip） | `https://mirrors.aliyun.com/pypi/simple/` | ✅ 可用 |
| npm 包 | 默认 `registry.npmjs.org` | ✅ 直连可用 |

已固化进项目（无需手动设）：
- `.npmrc` 写入 `electron_mirror`，`npm install` 自动走镜像
- `scripts/setup-python.js` 写死 pip 阿里云镜像

⚠️ 以下写法实测无效，切勿使用：`registry.npmmirror.com/mirrors/electron/`（404）、`pypi.npmmirror.com/simple`（DNS 失败）、`registry.npmmirror.com/mirrors/pypi/simple/`（404）。

典型故障：
- `Electron failed to install correctly`：二进制没下全，检查 `.npmrc` 的 `electron_mirror`；删 `node_modules` 重装。
- npm 缺包：首次 `npm install` 被打断导致 `node_modules` 损坏，`rmdir /s /q node_modules && del package-lock.json` 后重装。

---

## 许可证

本项目以 **GNU Affero General Public License v3 (AGPL-3.0)** 整体发布（根 `LICENSE`）。

- 核心转换引擎 **Microsoft markitdown**：MIT（© Microsoft Corporation）
- 前端 / 运行时依赖（marked、DOMPurify、KaTeX、Mermaid、highlight.js、Turndown、Electron、Chromium、Python 等）许可证见 `THIRD-PARTY-LICENSES.md`

> 依据 AGPL-3.0：任何人获取到本软件的二进制（含安装包、在线服务），均有权获得其对应源代码。完整源码见公开仓库 https://github.com/motongxue/PenEditMd-Lite 。

PenEditMd-Lite 为 PenEditMd 的派生作品，沿用其 AGPL-3.0 许可；版权声明见 `LICENSE` 文件头部。
