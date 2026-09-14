/**
 * 笔削 PenEditMd - Electron 主进程
 *
 * 职责：
 *  1. 拉起 Python 转换后端（开发态用系统 python，打包态用内置可执行文件）
 *  2. 监听后端健康端口，就绪后再创建窗口
 *  3. 暴露安全的 IPC 接口（文件对话框、打开外部文件等）
 *  4. 应用退出时优雅关闭 Python 子进程
 */

const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execFileSync } = require("child_process");
const net = require("net");
const http = require("http");

const PORT = process.env.MARKITDOWN_PORT || "8765";
const BASE_URL = `http://127.0.0.1:${PORT}`;

let mainWindow = null;
let pyProcess = null;

// 单实例锁：保证「双击文件用本应用打开」时把路径交给已运行的实例，而不是再开一个进程
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}
let isQuitting = false;
// 关闭确认：渲染进程回复「保存/不保存」后才真正放行 close；「取消」则不关
let closeConfirmed = false;
let closeAskPending = false;
// 用户在「未保存」提示里选了「保存」，且本次意图是退出应用（而非仅关窗口）
let pendingQuitAfterSave = false;
let tray = null;
let trayHintShown = false;

// 判断是否为打包态
const isPackaged = !!(app && app.isPackaged);

/**
 * 定位 Python 后端可执行文件。
 * 开发态：python-server/server.py + 系统 python 解释器
 * 打包态：resources/markitdown-server/markitdown-server(.exe)
 */
function resolvePythonCmd() {
  if (isPackaged) {
    const exe = process.platform === "win32" ? "markitdown-server.exe" : "markitdown-server";
    return { command: path.join(process.resourcesPath, "markitdown-server", exe), args: [] };
  }
  // 开发态：优先使用仓库内的 venv，回退到 PATH 中的 python
  // main.js 位于项目根目录，python-server 是其直接子目录
  const venvPy = process.platform === "win32"
    ? path.join(__dirname, "python-server", ".venv", "Scripts", "python.exe")
    : path.join(__dirname, "python-server", ".venv", "bin", "python");
  const command = require("fs").existsSync(venvPy)
    ? venvPy
    : (process.platform === "win32" ? "python" : "python3");
  return { command, args: [path.join(__dirname, "python-server", "server.py")] };
}

// 后端是否已启动（防止重复拉起 Python 后端）
let backendStarted = false;

function startPythonBackend() {
  if (backendStarted) return; // 守卫：避免重复拉起后端
  backendStarted = true;
  const { command, args } = resolvePythonCmd();
  console.log(`[main] start backend: ${command} ${args.join(" ")}`);
  pyProcess = spawn(command, args, {
    env: { ...process.env, MARKITDOWN_PORT: PORT },
    windowsHide: true,
  });
  pyProcess.stdout.on("data", (d) => console.log(`[py] ${d.toString().trim()}`));
  pyProcess.stderr.on("data", (d) => console.error(`[py-err] ${d.toString().trim()}`));
  pyProcess.on("exit", (code) => {
    if (!isQuitting) console.warn(`[main] 后端进程退出，code=${code}`);
  });
}

/**
 * 彻底杀掉 Python 后端进程（含其全部子进程）。
 * Windows 上 child.kill() 只能杀直接子进程，而 PyInstaller 单文件 exe 会再拉起一个
 * 真正的 python 子进程；必须用 taskkill /T 杀整棵树，否则后端会残留并锁住
 * resources/markitdown-server/，导致卸载/重装时文件被占用、进程变僵尸（需重启才能清）。
 */
function killBackendTree() {
  if (!pyProcess) return;
  const pid = pyProcess.pid;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else if (pid) {
      process.kill(-pid, "SIGKILL"); // 进程组
    }
  } catch (_) {
    /* 进程可能已退出 */
  }
  try {
    pyProcess.kill("SIGKILL");
  } catch (_) {}
  pyProcess = null;
}

/* ---------------- 应用偏好（userData/prefs.json） ----------------
 * 目前只存「点关闭按钮时的行为」：ask（每次询问，默认）/ tray（最小化到托盘）/ quit（直接退出）。
 * 单独一个文件而不是塞进 session.json：偏好与会话内容生命周期不同，避免互相污染。 */
let prefs = { closeAction: "ask" };
function prefsFile() {
  return path.join(app.getPath("userData"), "prefs.json");
}
function loadPrefs() {
  try {
    const raw = fs.readFileSync(prefsFile(), "utf-8");
    const o = raw ? JSON.parse(raw) : null;
    if (o && typeof o === "object") prefs = { closeAction: "ask", ...o };
  } catch (_) {
    /* 首次运行没有文件，用默认值 */
  }
  if (!["ask", "tray", "quit"].includes(prefs.closeAction)) prefs.closeAction = "ask";
}
function savePrefs() {
  try {
    fs.writeFileSync(prefsFile(), JSON.stringify(prefs), "utf-8");
  } catch (_) {}
}

/* ---------------- 系统托盘 ----------------
 * 关闭窗口时选择「最小化到托盘」，窗口只 hide 不销毁（会话/未保存内容都还在内存），
 * 点托盘图标即恢复。托盘按需创建，用户从不选托盘就永远不会多这个图标。 */
function trayIconPath() {
  // 打包态图标走 extraResources（asar 内的图片给 Tray 读有兼容性风险，直接放 resources 最稳）
  return isPackaged
    ? path.join(process.resourcesPath, "icon.ico")
    : path.join(__dirname, "assets", "icon.ico");
}

function showMainFromTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (!backendStarted) startPythonBackend();
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function ensureTray() {
  if (tray && !tray.isDestroyed()) return tray;
  const { Tray, Menu, nativeImage } = require("electron");
  let img = nativeImage.createFromPath(trayIconPath());
  if (img.isEmpty()) img = nativeImage.createEmpty(); // 图标缺失也要保证托盘可用
  tray = new Tray(img);
  tray.setToolTip("笔削 PenEditMd（点击显示主窗口）");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "显示主窗口", click: () => showMainFromTray() },
      { type: "separator" },
      {
        label: "退出应用",
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on("click", () => showMainFromTray());
  tray.on("double-click", () => showMainFromTray());
  return tray;
}

/** 把主窗口收进托盘（不销毁窗口，编辑内容保持原样） */
function minimizeToTray() {
  ensureTray();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
  if (!trayHintShown) {
    trayHintShown = true;
    try {
      tray.displayBalloon({
        title: "笔削 PenEditMd 已最小化到托盘",
        content: "应用仍在后台运行，点托盘图标可重新打开；右键托盘图标可退出。",
      });
    } catch (_) {
      /* 部分系统不支持气泡提示，忽略 */
    }
  }
}

/** 真正退出应用（先杀后端进程树由 before-quit 统一处理） */
function proceedQuit() {
  isQuitting = true;
  app.quit();
}

/** 退出前的未保存检查：脏 → 弹「保存/不保存/取消」；干净 → 直接退出 */
function quitWithDirtyCheck() {
  const wc = mainWindow && mainWindow.webContents;
  if (!wc || wc.isDestroyed() || wc.isLoading()) {
    proceedQuit();
    return;
  }
  closeAskPending = true;
  wc.executeJavaScript("window.__getDirtyState ? window.__getDirtyState() : false")
    .then((dirty) => {
      closeAskPending = false;
      if (!dirty) return proceedQuit();
      const btn = dialog.showMessageBoxSync(mainWindow, {
        type: "warning",
        title: "笔削 PenEditMd",
        message: "当前文档有未保存的修改，是否保存？",
        buttons: ["保存", "不保存", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      });
      if (btn === 0) {
        // 保存：渲染进程存完回执 replyClose 后再退出
        pendingQuitAfterSave = true;
        closeAskPending = true;
        wc.send("app:saveAndClose");
      } else if (btn === 1) {
        proceedQuit();
      }
      // btn === 2（取消）：留在应用里
    })
    .catch(() => {
      // 渲染进程异常（页面崩溃）：无法确认，直接退出避免卡死
      closeAskPending = false;
      proceedQuit();
    });
}

/** 轮询后端 /health，直到就绪或超时 */
function waitForBackend(timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(`${BASE_URL}/health`, (res) => {
        if (res.statusCode === 200) return resolve(true);
        retry();
      });
      req.on("error", retry);
      req.setTimeout(1000, () => req.destroy());
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("后端服务启动超时"));
      }
      setTimeout(tick, 500);
    };
    tick();
  });
}

function createWindow() {
  // 使用系统原生标题栏（工具栏上方那一行，用户明确要求保留）。
  // Windows 原生标题栏颜色由系统控制：这里用 nativeTheme.themeSource='light'
  // 强制标题栏为系统浅色（≈#f3f3f3，与用户要求的 f0f3f9 视觉一致）。
  // 注意：应用内明暗主题由 html.light class 手动控制，不受 prefers-color-scheme 影响，
  // 因此强制浅色标题栏不会破坏编辑器的深色主题。
  const winOpts = {
    width: 1100,
    height: 760,
    minWidth: 800,
    minHeight: 600,
    title: "笔削 PenEditMd",
    backgroundColor: "#f0f3f9", // 窗口底色（标题栏下方），用户指定
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // 关闭 Electron 进程级拼写检查服务：它会在每次 IME 组词更新时跑拼写扫描，
      // 与输入法抢主线程导致中文组词卡顿（HTML 的 spellcheck=false 属性关不掉这个服务）。
      spellcheck: false,
    },
  };
  mainWindow = new BrowserWindow(winOpts);
  if (process.platform === "win32") {
    // 浅色原生标题栏（接近用户要的 f0f3f9）；系统深色模式下也强制浅色标题栏
    require("electron").nativeTheme.themeSource = "light";
  }

  mainWindow.loadFile(path.join(__dirname, "dist", "renderer", "index.html"));

  // 开发态不再自动弹出 DevTools，避免遮挡主窗口；需要调试时按 F12 手动开关
  // if (!isPackaged) mainWindow.webContents.openDevTools({ mode: "detach" });

  // 关闭拦截：点标题栏 ✕ 时先问「最小化到托盘 / 退出应用」（可勾选记住选择），
  // 选「退出应用」才进未保存检查。用原生对话框而不是渲染进程弹窗的原因：
  // 渲染进程 JS 若未就绪/报错，消息发出没人收，会表现为"点关闭没反应"。
  mainWindow.on("close", (e) => {
    if (closeConfirmed || isQuitting) return; // 已确认过 → 放行
    e.preventDefault();
    if (closeAskPending) return; // 上一次询问还没回，避免重复弹窗

    // 记住过选择：不再询问
    if (prefs.closeAction === "tray") {
      minimizeToTray();
      return;
    }
    if (prefs.closeAction === "quit") {
      quitWithDirtyCheck();
      return;
    }

    closeAskPending = true;
    dialog
      .showMessageBox(mainWindow, {
        type: "question",
        title: "笔削 PenEditMd",
        message: "关闭窗口后要怎么做？",
        detail:
          "最小化到托盘：应用继续在后台运行，点托盘图标可重新打开，编辑内容保持不变。\n" +
          "退出应用：完全退出（有未保存内容会先提示保存）。",
        buttons: ["最小化到托盘", "退出应用", "取消"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        checkboxLabel: "记住我的选择",
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        closeAskPending = false;
        if (response === 2) return; // 取消：窗口保持打开
        if (checkboxChecked) {
          prefs.closeAction = response === 0 ? "tray" : "quit";
          savePrefs();
          buildAppMenu(); // 菜单里的单选项跟着变
        }
        if (response === 0) {
          minimizeToTray();
        } else {
          quitWithDirtyCheck();
        }
      })
      .catch(() => {
        // 对话框异常：兜底按退出处理，避免窗口关不掉
        closeAskPending = false;
        quitWithDirtyCheck();
      });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- IPC：关闭窗口确认（渲染进程弹完「保存/不保存/取消」后回执） ----
ipcMain.handle("app:replyClose", (event, choice) => {
  closeAskPending = false;
  if (choice === "cancel") {
    pendingQuitAfterSave = false;
    return; // 用户取消 → 不关窗口
  }
  // save / nosave：渲染进程已自行处理保存或丢弃，现在放行
  if (pendingQuitAfterSave) {
    pendingQuitAfterSave = false;
    proceedQuit(); // 本次意图是退出应用
    return;
  }
  closeConfirmed = true;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
});

// ---- IPC：把文本直接写入指定路径（手动保存「写回原文件」用，不再弹对话框） ----
ipcMain.handle("fs:writeText", (event, { path: filePath, content }) => {
  if (!filePath || typeof content !== "string") return false;
  try {
    fs.writeFileSync(filePath, content, "utf-8");
    return true;
  } catch (_) {
    return false;
  }
});

// ---- IPC：AI 调试日志（排查 AI 排版空白问题时用）----
// 渲染进程在 AI 排版关键节点调用，主进程把带时间戳的日志追加到
// <userData>/ai-debug.log，便于事后读文件定位真实问题。
function debugAiLog(msg, file) {
  try {
    const name = file || "ai-debug.log";
    const logPath = path.join(app.getPath("userData"), name);
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
  } catch (_) {}
}
ipcMain.handle("debug:log", (event, arg) => {
  if (arg && typeof arg === "object" && "msg" in arg) debugAiLog(arg.msg, arg.file);
  else debugAiLog(arg); // 兼容旧调用（单字符串 → 写 ai-debug.log）
  return true;
});

// ---- IPC：保存时把 base64 图片归档到 <md目录>/assets/ 下（L2 图片资源管理） ----
// 一次调用写入多张图片；目录由保存对话框所选路径决定，属于用户授权范围。
ipcMain.handle("fs:archiveAssets", async (event, { dir, files }) => {
  try {
    const assetsDir = path.join(dir, "assets");
    fs.mkdirSync(assetsDir, { recursive: true });
    let ok = 0;
    for (const f of files || []) {
      const name = String(f.name || "").replace(/[\\/:*?"<>|]/g, "_");
      if (!name) continue;
      const m = /^data:(image|audio|video)\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(f.dataUrl || "");
      if (m) {
        fs.writeFileSync(path.join(assetsDir, name), Buffer.from(m[3], "base64"));
        ok++;
      } else if (typeof f.base64 === "string") {
        fs.writeFileSync(path.join(assetsDir, name), Buffer.from(f.base64, "base64"));
        ok++;
      }
    }
    return ok;
  } catch (_) {
    return 0;
  }
});

// ---- IPC：读取用户选择的媒体文件为 base64 data URI（音频/视频组件上传用） ----
ipcMain.handle("fs:readMedia", async (event, filePath) => {
  try {
    if (!filePath || typeof filePath !== "string") return null;
    const buf = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
    const mimeMap = {
      mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", aac: "audio/aac", flac: "audio/flac",
      mp4: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska",
    };
    const mime = mimeMap[ext] || `application/octet-stream`;
    const base64 = buf.toString("base64");
    return { base64, mime, dataUri: `data:${mime};base64,${base64}`, name: path.basename(filePath) };
  } catch (_) {
    return null;
  }
});

// ---- IPC：文件对话框 ----
ipcMain.handle("dialog:openFile", async (event, extensions) => {
  const filters = extensions && extensions.length
    ? [{ name: "支持的文件", extensions: extensions.map((e) => e.replace(/^\./, "")) }, { name: "全部", extensions: ["*"] }]
    : [{ name: "全部", extensions: ["*"] }];
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters,
  });
  if (result.canceled) return [];
  return result.filePaths;
});

// ---- IPC：暴露后端基础地址 ----
ipcMain.handle("backend:baseUrl", () => BASE_URL);

// ---- IPC：打开导出的文件所在目录 ----
ipcMain.handle("shell:showItemInFolder", (event, p) => {
  const { shell } = require("electron");
  shell.showItemInFolder(p);
});

// ---- 原生窗口菜单栏（Windows/Linux 显示在标题栏下方） ----
// 用户要求把「设置（快捷键/图片策略）」等入口放进原生菜单栏。
// 菜单点击 → 发 "menu:action" 给渲染进程分发执行。
/** 改「点关闭按钮」的行为偏好（菜单单选项用），立即落盘 */
function setCloseAction(action) {
  prefs.closeAction = action;
  savePrefs();
}

function buildAppMenu() {
  const { Menu } = require("electron");
  const send = (action) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("menu:action", action);
    }
  };
  const template = [
    {
      label: "文件",
      submenu: [
        { label: "新建", accelerator: "CmdOrCtrl+N", click: () => send("newDoc") },
        { label: "保存", accelerator: "CmdOrCtrl+S", click: () => send("save") },
        { type: "separator" },
        { label: "退出", role: "quit" },
      ],
    },
    {
      label: "编辑",
      submenu: [
        { label: "撤销", accelerator: "CmdOrCtrl+Z", click: () => send("undo") },
        { label: "重做", accelerator: "CmdOrCtrl+Y", click: () => send("redo") },
        { type: "separator" },
        { label: "查找 / 替换", accelerator: "CmdOrCtrl+F", click: () => send("find") },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "分屏", click: () => send("modeSplit") },
        { label: "仅编辑", click: () => send("modeSource") },
        { label: "仅预览", click: () => send("modePreview") },
        { label: "富文本", click: () => send("richText") },
        { label: "源码", click: () => send("sourceMode") },
        { label: "专注模式", click: () => send("focusMode") },
        { type: "separator" },
        { label: "切换明暗主题", click: () => send("toggleTheme") },
      ],
    },
    {
      label: "设置",
      submenu: [
        { label: "通用设置", click: () => send("openSettings") },
        { type: "separator" },
        {
          label: "关闭窗口行为",
          submenu: [
            {
              label: "每次询问（最小化到托盘 / 退出）",
              type: "radio",
              checked: prefs.closeAction === "ask",
              click: () => setCloseAction("ask"),
            },
            {
              label: "最小化到托盘",
              type: "radio",
              checked: prefs.closeAction === "tray",
              click: () => setCloseAction("tray"),
            },
            {
              label: "直接退出应用",
              type: "radio",
              checked: prefs.closeAction === "quit",
              click: () => setCloseAction("quit"),
            },
          ],
        },
      ],
    },
    {
      label: "帮助",
      role: "help",
      submenu: [
        { label: "开发者工具", role: "toggleDevTools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC：剪贴板 ----
// 渲染进程里 navigator.clipboard / execCommand('paste') 受焦点与权限影响不稳定，
// 右键菜单的「粘贴 / 复制图片」统一走主进程的 Electron clipboard，行为可靠。
ipcMain.handle("clipboard:readText", () => {
  const { clipboard } = require("electron");
  return clipboard.readText();
});

ipcMain.handle("clipboard:writeText", (event, text) => {
  const { clipboard } = require("electron");
  clipboard.writeText(String(text ?? ""));
});

/** 读剪贴板图片，返回 PNG 的 data URI；剪贴板中无图片时返回 null */
ipcMain.handle("clipboard:readImage", () => {
  const { clipboard } = require("electron");
  const img = clipboard.readImage();
  if (!img || img.isEmpty()) return null;
  return img.toDataURL();
});

/** 把 data URI 图片写入剪贴板（右键「复制图片」用） */
ipcMain.handle("clipboard:writeImage", (event, dataUrl) => {
  const { clipboard, nativeImage } = require("electron");
  if (!dataUrl) return false;
  const img = nativeImage.createFromDataURL(dataUrl);
  if (img.isEmpty()) return false;
  clipboard.writeImage(img);
  return true;
});

/** 图片另存为：把 data URI 解码后写盘 */
ipcMain.handle("dialog:saveImage", async (event, { dataUrl, defaultName }) => {
  const m = /^data:image\/([a-zA-Z0-9.+-]+);base64,(.*)$/s.exec(dataUrl || "");
  if (!m) return null;
  const ext = m[1].toLowerCase() === "jpeg" ? "jpg" : m[1].toLowerCase();
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || `image.${ext}`,
    filters: [{ name: "图片", extensions: [ext] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, Buffer.from(m[2], "base64"));
  return result.filePath;
});

// ---- IPC：仅弹出“另存为”对话框返回路径（不写文件）——手动保存（Ctrl+S）选路径用 ----
ipcMain.handle("dialog:choosePath", async (event, { defaultName, ext }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || `document.${ext || "md"}`,
    filters: [{ name: (ext || "md").toUpperCase(), extensions: [ext || "md"] }],
  });
  if (result.canceled || !result.filePath) return null;
  return result.filePath;
});

// ---- IPC：导出——弹出“保存为”对话框并写入文件（MD / HTML 等文本格式） ----
ipcMain.handle("dialog:saveFile", async (event, { defaultName, content, ext }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || `document.${ext}`,
    filters: [{ name: (ext || "txt").toUpperCase(), extensions: [ext || "txt"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, content, "utf-8");
  return result.filePath;
});

// ---- IPC：导出 PDF——用隐藏窗口将 HTML 打印为 PDF 并保存 ----
ipcMain.handle("export:pdf", async (event, { html, defaultName }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "document.pdf",
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  // 把 HTML 写到临时文件，用 file:// 加载。Chromium 对 data: URL 导航长度有上限，
  // 整篇（含 20+ 张 base64 大图，可达数十 MB）会触发 ERR_INVALID_URL；
  // 改用临时文件 + file:// 可彻底避开该限制，且内嵌的 base64 图片在 file:// 页面下照常渲染。
  const tmpPath = path.join(os.tmpdir(), `markitdown-export-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, "utf-8");
  try {
    await win.loadURL("file://" + tmpPath);
    // 等待图片/字体渲染完成（内嵌 base64 图片较多时给足时间）；
    // 若有 Mermaid 图，等到所有 .mermaid 块都渲染出 svg（最多 10s）
    try {
      await win.webContents.executeJavaScript(`
        new Promise((res) => {
          const hasMermaid = !!document.querySelector('.mermaid');
          if (!hasMermaid) return res(true);
          const t = setInterval(() => {
            const need = document.querySelectorAll('.mermaid').length;
            const done = document.querySelectorAll('.mermaid svg, .mermaid-wrap svg').length;
            if (done >= need) { clearInterval(t); res(true); }
          }, 150);
          setTimeout(() => { clearInterval(t); res(true); }, 10000);
        })`);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 800));
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: "A4",
      // 用 marginType 而非自定义 margins：本 Electron 版本对自定义 margins 与 pageSize
      // 一起做严格校验，易触发 "margins must be less than or equal to pageSize"。
      // printableArea = 使用打印机默认可打印区（合理的小页边距），规避该校验。
      marginType: "printableArea",
    });
    fs.writeFileSync(result.filePath, pdf);
    return result.filePath;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* 忽略清理失败 */
    }
    win.destroy();
  }
});

// ---- IPC：导出 ZIP 容器（DOCX / EPUB）----
// DOCX 与 EPUB 都是「特定结构的 ZIP」。渲染进程负责生成各部件的 XML/HTML 文本
// （它有 DOM 和 Markdown 渲染管线），主进程只负责打包与落盘，职责清晰。
// entries: [{ name, data, base64?: bool, store?: bool }]
ipcMain.handle("export:zip", async (event, { defaultName, ext, entries }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || `document.${ext || "zip"}`,
    filters: [{ name: (ext || "zip").toUpperCase(), extensions: [ext || "zip"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const { createZip } = require("./zipWriter.js");
  const buf = createZip(
    (entries || []).map((e) => ({
      name: e.name,
      // base64 条目（图片等二进制）在这里解码，避免 IPC 传 Buffer 的序列化开销
      data: e.base64 ? Buffer.from(e.data, "base64") : e.data,
      store: !!e.store,
    })),
  );
  fs.writeFileSync(result.filePath, buf);
  return result.filePath;
});

// ---- IPC：导出 PNG 长图 ----
// 用隐藏窗口加载导出 HTML，再用 webContents.capturePage() 直接截取。
// - 第一版用 zoomFactor(2) + setContentSize 把隐藏窗口撑到整页高度再 capturePage()，
//   文档很高时（zoomFactor×高度 超过 Chromium GPU 纹理上限 ~16384px）截出损坏 PNG，
//   Windows 照片查看器打开报 0x80004005。
// - 第二版改 CDP Page.captureScreenshot(captureBeyondViewport)，但隐藏窗口不绘制，
//   拿到空 data 写出 0 字节文件，仍打不开。
// 本版回到 capturePage（隐藏窗口可用），并对「变焦 × 系统 DSF × 内容高度」封顶，
// 既保证能打开，又避免超高文档撑爆纹理上限；截图为空时主动抛错，绝不写 0KB。
ipcMain.handle("export:png", async (event, { html, defaultName, width }) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName || "document.png",
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const w = Math.max(360, Math.min(2000, Number(width) || 900));
  const win = new BrowserWindow({
    show: false,
    width: w,
    height: 600, // 临时高度，截图前会按内容高度 setContentSize
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  const tmpPath = path.join(os.tmpdir(), `markitdown-png-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, "utf-8");
  try {
    await win.loadURL("file://" + tmpPath);
    // 等 Mermaid / 图片就绪，逻辑与 PDF 导出一致
    try {
      await win.webContents.executeJavaScript(`
        new Promise((res) => {
          const hasMermaid = !!document.querySelector('.mermaid');
          if (!hasMermaid) return res(true);
          const t = setInterval(() => {
            const need = document.querySelectorAll('.mermaid').length;
            const done = document.querySelectorAll('.mermaid svg, .mermaid-wrap svg').length;
            if (done >= need) { clearInterval(t); res(true); }
          }, 150);
          setTimeout(() => { clearInterval(t); res(true); }, 10000);
        })`);
    } catch (_) {}
    await new Promise((r) => setTimeout(r, 400));
    // 量出 CSS 像素下的整页高度
    const measuredH = await win.webContents.executeJavaScript(
      `Math.ceil(Math.max(document.body.scrollHeight, document.documentElement.scrollHeight))`,
    );
    // 设备像素上限（Chromium GPU 纹理上限约 16384，留余量取 12000）。
    // capturePage 的纹理尺寸 = 内容宽高 × 变焦 × 系统 DSF，超过即损坏/空白。
    // 据此自动选变焦（优先 2× 更清晰），并把内容高度裁到安全上限。
    const SAFE = 12000;
    const dsf = (require("electron").screen.getPrimaryDisplay().scaleFactor) || 1;
    const mH = Number(measuredH) || 800;
    let zoom = 2;
    if (mH * 2 * dsf > SAFE) zoom = 1;
    const capH = Math.max(200, Math.min(Math.floor(SAFE / (zoom * dsf)), mH));
    win.webContents.setZoomFactor(zoom);
    win.setContentSize(w, capH);
    await new Promise((r) => setTimeout(r, 150)); // 等 resize 重排完成
    const img = await win.webContents.capturePage();
    if (!img || img.isEmpty()) throw new Error("页面截图为空，无法导出 PNG");
    const png = img.toPNG();
    if (!png || png.length === 0) throw new Error("PNG 数据为空，无法导出");
    fs.writeFileSync(result.filePath, png);
    return result.filePath;
  } finally {
    try {
      fs.unlinkSync(tmpPath);
    } catch (_) {
      /* 忽略清理失败 */
    }
    win.destroy();
  }
});

// ---- IPC：文档树（PRD #8）—— 工作文件夹浏览 / 读写 ----
// 安全约束：所有路径操作都必须位于用户选择的 root 之内，防止通过拼接 ../ 越界读写。
function resolveWithin(root, target) {
  if (!root || !target) return null;
  const r = path.resolve(String(root));
  const t = path.resolve(String(target));
  if (t === r) return t;
  if (t.startsWith(r + path.sep)) return t; // 位于 root 子树内
  return null; // 越界，拒绝
}

// 选择工作文件夹（文件夹选择对话框，返回绝对路径或 null）
ipcMain.handle("dialog:selectFolder", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths || !result.filePaths.length) return null;
  return result.filePaths[0];
});

// 列目录：返回 root 内的 dir 的直接子项（不含 .），文件夹在前、文件名次之，各自按名称排序。
// 每个条目：{ name, path, isDir, size, mtime }
ipcMain.handle("fs:listDir", (event, { root, dir }) => {
  const base = resolveWithin(root, dir);
  if (!base) return [];
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.name === "." || e.name === "..") continue;
    const full = path.join(base, e.name);
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
    } catch (_) {}
    out.push({ name: e.name, path: full, isDir: e.isDirectory(), size, mtime });
  }
  out.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1; // 文件夹优先
    return a.name.localeCompare(b.name, "zh-Hans-CN");
  });
  return out;
});

// 读取文本文件（UTF-8），越界或读取失败返回 null
ipcMain.handle("fs:readText", (event, { root, target }) => {
  const full = resolveWithin(root, target);
  if (!full) return null;
  try {
    return fs.readFileSync(full, "utf-8");
  } catch (_) {
    return null;
  }
});

// 读取任意绝对路径的文本文件（操作系统「打开方式/双击」场景：文件由用户显式选择，不走文档树沙箱）。
// 用于 .md/.markdown/.mdx/.txt 等原生文本格式——它们不应被 markitdown 后端二次转换（否则会被清空/报错）。
ipcMain.handle("fs:readTextAbs", (event, p) => {
  if (!p || typeof p !== "string") return { ok: false, error: "无效路径" };
  let ap;
  try {
    ap = path.resolve(p);
  } catch (_) {
    return { ok: false, error: "路径解析失败" };
  }
  const lower = ap.toLowerCase();
  const SENSITIVE = ["c:\\windows", "c:\\program files", "c:\\programdata", "/etc", "/proc", "/sys", "/boot", "/root"];
  if (SENSITIVE.some((d) => lower === d || lower.startsWith(d + path.sep))) {
    return { ok: false, error: "拒绝访问受限路径" };
  }
  try {
    return { ok: true, text: fs.readFileSync(ap, "utf-8") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 新建目录：在 root 内的 parent 下创建 folderName。返回新目录绝对路径或 null
ipcMain.handle("fs:mkdir", (event, { root, parent, folderName }) => {
  const base = resolveWithin(root, parent);
  if (!base) return null;
  const safe = String(folderName || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!safe) return null;
  const full = path.join(base, safe);
  if (resolveWithin(root, full) !== full) return null; // 二次校验
  try {
    fs.mkdirSync(full, { recursive: false });
    return full;
  } catch (_) {
    return null;
  }
});

// 新建空文件：在 root 内的 parent 下创建 fileName（已含扩展名）。返回绝对路径或 null
ipcMain.handle("fs:createFile", (event, { root, parent, fileName, content }) => {
  const base = resolveWithin(root, parent);
  if (!base) return null;
  const safe = String(fileName || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!safe) return null;
  const full = path.join(base, safe);
  if (resolveWithin(root, full) !== full) return null;
  try {
    fs.writeFileSync(full, content == null ? "" : String(content), "utf-8");
    return full;
  } catch (_) {
    return null;
  }
});

// 重命名（文件或目录）：newName 为同目录下的新名。返回新绝对路径或 null
ipcMain.handle("fs:rename", (event, { root, target, newName }) => {
  const full = resolveWithin(root, target);
  if (!full) return null;
  const safe = String(newName || "").replace(/[\\/:*?"<>|]/g, "_").trim();
  if (!safe) return null;
  const newFull = path.join(path.dirname(full), safe);
  if (resolveWithin(root, newFull) !== newFull) return null; // 防越界
  if (full === newFull) return newFull;
  try {
    fs.renameSync(full, newFull);
    return newFull;
  } catch (_) {
    return null;
  }
});

// 删除（文件或目录）。目录递归删除。返回是否成功
ipcMain.handle("fs:remove", (event, { root, target }) => {
  const full = resolveWithin(root, target);
  if (!full) return false;
  try {
    fs.rmSync(full, { recursive: true, force: true });
    return true;
  } catch (_) {
    return false;
  }
});

// 读取二进制文件为 base64（文档树点击图片时，渲染进程内联成 data URI 显示）。
// 同样受 root 越界保护。
ipcMain.handle("fs:readBinary", (event, { root, target }) => {
  const full = resolveWithin(root, target);
  if (!full) return null;
  try {
    const buf = fs.readFileSync(full);
    const ext = path.extname(full).toLowerCase().replace(/^\./, "");
    const mime = MIME_BY_EXT[ext] || "application/octet-stream";
    return { base64: buf.toString("base64"), mime, dataUri: `data:${mime};base64,${buf.toString("base64")}` };
  } catch (_) {
    return null;
  }
});

const MIME_BY_EXT = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  bmp: "image/bmp", webp: "image/webp", svg: "image/svg+xml",
  pdf: "application/pdf", txt: "text/plain", md: "text/markdown",
};

// ---- 会话自动保存/恢复（#7）----
// 把当前会话文档（含从文档树转换而来、尚未落盘的文件）持久化到 userData/session.json，
// 下次启动由渲染进程读取并恢复，避免「关窗后会话列表空空如也」。
function sessionFile() {
  return path.join(app.getPath("userData"), "session.json");
}
// 图片映射在主进程内存里缓存一份：首次保存从磁盘读一次，之后复用，避免每次保存都
// readFileSync 整个 session.json（见下方 #打字卡顿 规避）。图片变化时由渲染端带上新值刷新。
let _sessionImagesCache = null;
// 串行化写，避免并发 save 交错（渲染端防抖 800ms，频率很低，这里只是兜底）
let _sessionSaveChain = Promise.resolve();
ipcMain.handle("session:save", async (event, payload) => {
  try {
    // payload 为新版对象 { files, images }；兼容旧版纯文件数组
    const toSave = payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : { files: payload || [] };
    // 图片不随正文频繁保存：images 为 null 时复用内存缓存（必要时才从磁盘读一次）；
    // 不为 null 说明图片有变化，更新缓存。
    if (toSave.images == null) {
      if (_sessionImagesCache) {
        toSave.images = _sessionImagesCache;
      } else {
        try {
          const raw = fs.readFileSync(sessionFile(), "utf-8");
          const prev = raw ? JSON.parse(raw) : null;
          if (prev && prev.images) _sessionImagesCache = prev.images;
          if (_sessionImagesCache) toSave.images = _sessionImagesCache;
        } catch (_) { /* 旧文件不存在/损坏则不带图片 */ }
      }
    } else {
      _sessionImagesCache = toSave.images;
    }
    // 异步写，不阻塞主进程事件循环：原先 fs.writeFileSync 在杀软首次扫描 session.json
    // 时会同步卡住主进程数秒，导致文件对话框/复制等依赖主进程的 IPC 一起卡。
    const data = JSON.stringify(toSave);
    _sessionSaveChain = _sessionSaveChain.then(() =>
      fs.promises.writeFile(sessionFile(), data, "utf-8")
    );
    await _sessionSaveChain;
    return true;
  } catch (_) {
    return false;
  }
});
ipcMain.handle("session:load", () => {
  try {
    const raw = fs.readFileSync(sessionFile(), "utf-8");
    const v = raw ? JSON.parse(raw) : [];
    // 兼容旧版纯文件数组
    return Array.isArray(v) ? { files: v } : v;
  } catch (_) {
    return { files: [] };
  }
});

// ---- AI 对话（OpenAI 兼容 chat/completions）----
// 渲染进程把 { baseURL, apiKey, model, messages } 发来，主进程用 fetch 代发，
// 避开浏览器 CORS，且 Key 只在主进程内存/网络层，不进页面脚本上下文。
ipcMain.handle("ai:chat", async (event, payload) => {
  try {
    const { baseURL, apiKey, model, messages, temperature = 0.7, maxTokens = 2048, timeoutMs } =
      payload || {};
    if (!baseURL || !apiKey || !model)
      return { ok: false, error: "AI 未配置：请在设置中填写接口地址、密钥与模型" };
    if (!Array.isArray(messages) || !messages.length)
      return { ok: false, error: "消息为空" };
    const url = String(baseURL).replace(/\/+$/, "") + "/chat/completions";
    // 请求超时（毫秒）：优先用调用方显式传入（如 AI 排版给更长兜底），其次模型设置，
    // 最后兜底 60s。AI 排版带大 max_tokens + 整篇提示词，慢模型很容易超 60s，故需可配/可长。
    const waitMs = Math.max(5000, Number(timeoutMs) || 60000);
    // 已知走「推理(reasoning)」的模型：默认会把 token 预算耗在思考上，导致 content 为空。
    // 排版/润色这类任务不需要推理，关闭它让模型直接产出 content。按需在此清单扩展。
    const REASONING_MODELS = ["deepseek-v4", "deepseek-reasoner", "deepseek-r1"];
    const disableThinking = REASONING_MODELS.some((h) => String(model).includes(h));
    try { debugAiLog(`[req] model=${model} url=${url} messages=${messages.length} maxTokens=${maxTokens} temperature=${temperature} timeout=${waitMs}ms thinking=${disableThinking ? "disabled" : "default"}`); } catch (_) {}
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), waitMs);
    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          stream: false,
          // 已知推理模型关闭 thinking（见 REASONING_MODELS），其余模型不附加该参数，
          // 避免把不支持 thinking 的模型（如 deepseek-chat）误带参数导致接口报错。
          ...(disableThinking ? { thinking: { type: "disabled" } } : {}),
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!resp.ok) {
      let msg = "HTTP " + resp.status;
      try {
        const j = await resp.json();
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (_) {}
      try { debugAiLog(`[resp] HTTP ${resp.status} error=${msg}`); } catch (_) {}
      return { ok: false, error: msg };
    }
    const data = await resp.json();
    const choice = data && data.choices && data.choices[0];
    const msg = (choice && choice.message) || {};
    const text = msg.content || "";
    const reason = msg.reasoning_content || "";
    const fr = (choice && choice.finish_reason) || "";
    const role = msg.role || "";
    const usage = data && data.usage ? data.usage : null;
    try {
      debugAiLog(
        `[resp] ok text长度=${text.length} reasoning长度=${reason.length} role=${role} finish_reason=${fr}` +
          (usage ? ` completion_tokens=${usage.completion_tokens}` : "")
      );
    } catch (_) {}
    // 截断且一个字都没产出：多半是 max_tokens 不够，或模型名不对（如 DeepSeek 标准名应为 deepseek-chat）
    if (fr === "length" && !text.trim()) {
      return {
        ok: false,
        error: "模型输出因 max_tokens 耗尽被截断且未产出任何内容。请调大 max_tokens，或检查模型名（DeepSeek 标准模型名一般为 deepseek-chat / deepseek-reasoner）",
      };
    }
    // 截断但已有部分内容：仍返回，让上层拿到部分结果（AI 排版会提示不完整）
    if (fr === "length") {
      return { ok: true, text, truncated: true, usage };
    }
    return { ok: true, text, usage };
  } catch (e) {
    const aborted = e && (e.name === "AbortError" || /abort/i.test(e.message || ""));
    const msg = (e && e.message) || String(e);
    try { debugAiLog(`[resp] exception: ${msg}`); } catch (_) {}
    return {
      ok: false,
      error: aborted
        ? `请求超时或被中止（约 ${Math.round(waitMs / 1000)}s）：AI 排版/长文生成较慢，请到「设置 → AI 模型」把该模型的「请求超时(秒)」调大（建议 ≥300），或换更快的模型`
        : msg,
    };
  }
});

// ---- 微信公众号推送（草稿箱）----
// 渲染进程把 { 凭证, 标题, 作者, 正文 HTML, 封面 } 发来，主进程完成整条链路：
//   换 access_token → 正文本地图片上传微信 CDN → 封面上传永久素材 → 创建草稿。
// AppSecret 只在这里参与网络请求，不落日志。
const WX_API = "https://api.weixin.qq.com/cgi-bin";
// 常见 errcode 的人话解释（照抄公众号文档，省得用户自己查表）
const WX_ERR_HINTS = {
  "-1": "微信服务器繁忙，稍后重试",
  40001: "AppSecret 错误，或 access_token 已失效",
  40007: "media_id 无效",
  40013: "AppID 无效",
  40125: "AppSecret 无效",
  40164: "调用方 IP 不在公众号 IP 白名单内（公众号后台 → 设置与开发 → 基本配置 → IP 白名单）",
  45009: "接口调用频率超限",
  45166: "正文含公众号不支持的标签或格式",
  48001: "接口未授权：该公众号（如未认证的个人号）没有草稿箱/素材接口权限",
};
function wxErr(data, fallback) {
  if (!data) return fallback;
  const code = data.errcode;
  const hint = WX_ERR_HINTS[String(code)];
  const msg = data.errmsg || fallback;
  return `errcode=${code} ${msg}` + (hint ? `（${hint}）` : "");
}

async function wxGetJson(url) {
  const resp = await fetch(url, { method: "GET" });
  return await resp.json();
}

async function wxPostJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    // 中文不转义：微信正文里大量中文，ensure_ascii 式转义会让草稿正文出现乱码
    body: Buffer.from(JSON.stringify(body), "utf8"),
  });
  return await resp.json();
}

/** multipart 上传（uploadimg / add_material 共用；字段名固定 media） */
async function wxUpload(url, buf, filename, mime) {
  const fd = new FormData();
  fd.append("media", new Blob([buf], { type: mime }), filename);
  const resp = await fetch(url, { method: "POST", body: fd });
  return await resp.json();
}

async function wxToken(appid, appsecret) {
  const url = `${WX_API}/token?grant_type=client_credential&appid=${encodeURIComponent(
    appid
  )}&secret=${encodeURIComponent(appsecret)}`;
  const data = await wxGetJson(url);
  if (!data || !data.access_token) throw new Error("获取 access_token 失败：" + wxErr(data, "未知错误"));
  return data.access_token;
}

/** data:image/png;base64,xxx → { buf, mime, ext } */
function parseDataUrl(dataUrl) {
  const m = /^data:([^;,]+);base64,(.+)$/s.exec(String(dataUrl || ""));
  if (!m) return null;
  const mime = m[1];
  const ext = mime.includes("jpeg") || mime.includes("jpg") ? "jpg" : mime.includes("gif") ? "gif" : "png";
  return { buf: Buffer.from(m[2], "base64"), mime, ext };
}

/** 正文图片超 1MB 会被微信拒绝，用 Electron 自带解码能力转成 JPEG 压到限额内 */
function shrinkForWechat(buf, mime) {
  if (buf.length <= 1024 * 1024) return { buf, mime, ext: mime.includes("jpeg") ? "jpg" : "png" };
  try {
    const { nativeImage } = require("electron");
    const img = nativeImage.createFromBuffer(buf);
    if (!img.isEmpty()) {
      const jpg = img.toJPEG(88);
      if (jpg && jpg.length && jpg.length < buf.length) return { buf: jpg, mime: "image/jpeg", ext: "jpg" };
    }
  } catch (_) {}
  return { buf, mime, ext: mime.includes("jpeg") ? "jpg" : "png" };
}

/** 把正文里的本地图片（data: / 本机路径）换成微信 CDN 永久链接；http(s) 外链原样保留 */
async function wxReplaceContentImages(token, html, baseDir) {
  const re = /(<img\b[^>]*?\ssrc\s*=\s*")([^"]+)("[^>]*>)/gi;
  const matches = [...String(html).matchAll(re)];
  if (!matches.length) return { html, uploaded: 0, skipped: 0 };
  const uploadUrl = `${WX_API}/media/uploadimg?access_token=${token}`;
  let out = "";
  let last = 0;
  let uploaded = 0;
  let skipped = 0;
  for (const m of matches) {
    const [full, prefix, src, suffix] = m;
    out += html.slice(last, m.index);
    last = m.index + full.length;
    let replaced = full;
    try {
      let picked = null;
      if (/^data:image\//i.test(src)) {
        picked = parseDataUrl(src);
      } else if (!/^https?:\/\//i.test(src)) {
        // file:// 前缀、绝对路径、相对 baseDir 的路径都在这里落地
        let p = decodeURI(src.replace(/^file:\/\/\/?/i, ""));
        if (!path.isAbsolute(p) && baseDir) p = path.join(baseDir, p);
        if (fs.existsSync(p)) {
          const ext = path.extname(p).toLowerCase();
          const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".gif" ? "image/gif" : "image/png";
          picked = { buf: fs.readFileSync(p), mime, ext: ext.replace(".", "") || "png" };
        }
      }
      if (picked) {
        const fit = shrinkForWechat(picked.buf, picked.mime);
        const data = await wxUpload(uploadUrl, fit.buf, `img_${uploaded + 1}.${fit.ext}`, fit.mime);
        if (data && data.url) {
          replaced = prefix + data.url + suffix;
          uploaded++;
        } else {
          skipped++;
        }
      } else {
        skipped++;
      }
    } catch (_) {
      skipped++;
    }
    out += replaced;
  }
  out += html.slice(last);
  return { html: out, uploaded, skipped };
}

ipcMain.handle("wechat:test", async (event, { appid, appsecret } = {}) => {
  try {
    if (!appid || !appsecret) return { ok: false, error: "AppID / AppSecret 不能为空" };
    await wxToken(appid, appsecret);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle("wechat:push", async (event, payload = {}) => {
  try {
    const {
      appid,
      appsecret,
      title,
      author = "",
      digest = "",
      html,
      coverDataUrl,
      coverPath,
      baseDir,
    } = payload;
    if (!appid || !appsecret) return { ok: false, error: "尚未配置 AppID / AppSecret（设置 → 公众号推送）" };
    if (!title) return { ok: false, error: "标题不能为空" };
    if (!html) return { ok: false, error: "正文为空" };

    const token = await wxToken(appid, appsecret);

    // 1) 正文图片：本地图上传微信 CDN（不传外链）
    const rep = await wxReplaceContentImages(token, html, baseDir || "");

    // 2) 封面：优先用户选的本地图，其次渲染进程生成的占位封面
    let cover = null;
    if (coverPath && fs.existsSync(coverPath)) {
      const ext = path.extname(coverPath).toLowerCase();
      cover = {
        buf: fs.readFileSync(coverPath),
        mime: ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : "image/png",
        ext: ext.replace(".", "") || "png",
      };
    } else if (coverDataUrl) {
      cover = parseDataUrl(coverDataUrl);
    }
    if (!cover) return { ok: false, error: "缺少封面图，无法创建草稿" };
    const thumb = await wxUpload(
      `${WX_API}/material/add_material?access_token=${token}&type=image`,
      cover.buf,
      `cover.${cover.ext}`,
      cover.mime
    );
    if (!thumb || !thumb.media_id) return { ok: false, error: "上传封面失败：" + wxErr(thumb, "未知错误") };

    // 3) 建草稿
    const draft = await wxPostJson(`${WX_API}/draft/add?access_token=${token}`, {
      articles: [
        {
          title: String(title).slice(0, 64),
          author: String(author).slice(0, 8),
          digest: String(digest).slice(0, 120),
          content: rep.html,
          thumb_media_id: thumb.media_id,
          need_open_comment: 0,
          only_fans_can_comment: 0,
        },
      ],
    });
    if (!draft || !draft.media_id) return { ok: false, error: "创建草稿失败：" + wxErr(draft, "未知错误") };

    return { ok: true, mediaId: draft.media_id, uploaded: rep.uploaded, skipped: rep.skipped };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});


// ---- 文件关联：从命令行提取被「打开方式/双击」选中的文件路径 ----
// 只认我们注册过的扩展名，避免把 electron 自身参数或其它路径误当文件
function extractOpenPath(argv) {
  const exts = [".md", ".markdown", ".mdx", ".txt", ".doc", ".docx"];
  for (const a of argv || []) {
    if (!a || typeof a !== "string") continue;
    if (a.startsWith("-")) continue; // 跳过 --type=renderer 等 electron 内部参数
    try {
      const s = fs.statSync(a);
      if (s.isFile() && exts.includes(path.extname(a).toLowerCase())) return a;
    } catch (_e) {
      /* 路径不存在或非文件，跳过 */
    }
  }
  return null;
}

// 把要打开的文件路径交给渲染进程（页面未就绪则等加载完再发）
function sendOpenPath(p) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.show();
  mainWindow.focus();
  const send = () => mainWindow.webContents.send("app:openPath", p);
  if (mainWindow.webContents.isLoading()) {
    mainWindow.webContents.once("did-finish-load", () => setTimeout(send, 500));
  } else {
    send();
  }
}

// 第二个实例启动（如已运行时再双击文件）：把路径转给主实例，并聚焦窗口
app.on("second-instance", (_e, argv) => {
  const p = extractOpenPath(argv);
  if (p) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      startPythonBackend();
      createWindow();
    }
    sendOpenPath(p);
  } else if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

// ---- 生命周期 ----
// 注：曾试 app.disableHardwareAcceleration() 验证 GPU/IME 冲突——反而更糟（单帧 91s），
// 说明阻塞是 layout/paint 瓶颈、GPU 本在帮忙。已回退，保留硬件加速。
app.whenReady().then(async () => {
  loadPrefs(); // 载入偏好（关闭窗口行为等），须早于 buildAppMenu 以正确回显单选项
  buildAppMenu(); // 原生窗口菜单栏（文件/编辑/视图/设置/帮助）

  // 本次启动是否由「打开方式/双击文件」触发
  const openAtLaunch = extractOpenPath(process.argv);

  startPythonBackend();
  // 后端就绪与否都不阻塞：失败仅记录日志，不再弹阻塞式错误框
  // （避免开机自启时若后端启动失败卡在错误框、便签永不显示）
  waitForBackend()
    .then(() => console.log("[main] backend ready"))
    .catch((e) => console.error("[main] backend start failed:", e && e.message));

  createWindow();

  // 若本次启动是「用本应用打开某文件」（双击/打开方式），把路径交给渲染进程打开
  if (openAtLaunch) sendOpenPath(openAtLaunch);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  // 托盘图标必须显式销毁，否则 Windows 上会残留一个点不动的图标
  if (tray && !tray.isDestroyed()) {
    try {
      tray.destroy();
    } catch (_) {}
    tray = null;
  }
  killBackendTree();
});

app.on("quit", () => {
  // 双保险：任何退出路径都确保后端进程树被清掉
  killBackendTree();
});
