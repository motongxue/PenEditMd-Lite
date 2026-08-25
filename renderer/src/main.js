/**
 * main.js — 渲染进程主逻辑（双栏编辑器：富文本/源码 + 实时预览）
 *
 * 流程：拖拽/打开文件 → 后端 /convert(_path) 返回 Markdown
 *      → 写入当前编辑器（富文本或源码）
 *      → 右侧 preview 实时渲染
 *      → 编辑后复制/导出取 editor.getValue() 的纯净 .md
 */

import "../style.css";
import "../tmplComponents.css";
import { createEditor } from "./editor.js";
import { buildToolbar, setToolbarEnabled } from "./toolbar.js";
import { renderMarkdownInto, bindAnchorClick, reinitMermaid, renderRawHtml } from "./preview.js";
import { perfReset, perfStage } from "./perf.js";
import { expandMarkdown, getImageById, shrinkMarkdown, isDocImageLight, snapshotImages, restoreImages, replaceImage } from "./imageStore.js";
import { buildExportHtml } from "./exporter.js";
import { setStatusSink } from "./status.js";
import { bindEditorContextMenu } from "./editorMenu.js";
import { openLocalImageFile } from "./prompt.js";
import { showContextMenu } from "./contextmenu.js";
import { positionMenuUnder, closeAllMenus } from "./bodyMenu.js";
import { openSettingsModal, openAiSettingsModal, actionForEvent, loadImgStrategy, loadAiSettings, loadAiModels, getActiveModel, setAiActiveId, openWechatSettingsModal, openWechatPushModal, loadWechatCfg, isWechatReady } from "./settings.js";
import { buildDocxEntries, buildEpubEntries } from "./officeExport.js";
import { initDocTree } from "./docTree.js";
import { initStickyNotes } from "./stickyNotes.js";
import { themeVarsCss, themeTypographyCss } from "./themeCss.js";
import {
  THEMES,
  getTheme,
  COMPONENTS,
  CATEGORIES,
  DEFAULT_THEME,
  deriveTheme,
  buildToc,
  replaceTocBlocks,
} from "./templates.js";

/** HTML 转义，避免文件名里的特殊字符破坏组件 HTML 结构 */
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const state = {
  baseUrl: "http://127.0.0.1:8765",
  files: [], // { id, name, markdown, error }
  activeId: null,
  mode: "split", // split | source | preview
  editorType: "richtext", // richtext | source
  formats: [],
  activeThemeId: null,
  activeTheme: null, // 当前生效主题（可独立于模板切换，支持一键换色） // 当前公众号/头条排版模板（null=默认样式）
  publishMode: false, // 公众号排版模式：左栏展开主题+组件，并限制导出格式（#189）
  previewAi: false, // 分屏预览当前是否显示 AI 排版结果（替代弹出预览）
};

function getActiveTheme() {
  return null;
}
/**
 * 把主题注入编辑器预览与富文本编辑区（所见即所得）。
 * 可视化样式面板 / 一键换色 / 选主题都走这里 —— 改主题字段后重新注入即可实时刷新。
 */

// 超过该字符数的文档视为「超大文档」，自动降级到源码模式 + 更长防抖，避免编辑卡顿
const LARGE_DOC_CHARS = 500000;

// 启动时自动创建的空白文档名
const BLANK_DOC_NAME = "未命名.md";

let editor = null;
const els = {};

function $(id) {
  return document.getElementById(id);
}

function cacheEls() {
  els.dropzone = $("dropzone");
  els.result = $("result");
  els.files = $("files");
  els.fileCount = $("file-count");
  els.source = $("source-input");
  els.rich = $("rich-input");
  els.preview = $("preview");
  els.panes = $("panes");
  els.resizer = $("resizer");
  els.formatGroup = $("format-group");
  els.btnOpen = $("btn-open");
  els.btnOpen3 = $("btn-open-3");
  els.btnNew = $("btn-new");
  els.btnSave = $("btn-save");
  els.btnUndo = $("btn-undo");
  els.btnRedo = $("btn-redo");
  els.btnCopy = $("btn-copy");
  els.btnExport = $("btn-export");
  els.btnClear = $("btn-clear");
  els.btnToggle = $("btn-sidebar-toggle");
  els.btnTheme = $("btn-theme");
  els.btnFocus = $("btn-focus");
  els.btnRich = $("btn-rich");
  els.btnSource = $("btn-source");
  els.status = $("status");
  els.backendStatus = $("backend-status");
  els.charCount = $("char-count");
  els.overlay = $("overlay");
  els.overlayText = $("overlay-text");
  els.statusHint = $("status-hint");
  // 导出下拉菜单
  els.exportMenu = $("export-menu");
  // 发布下拉菜单（公众号 / 头条）
  els.btnPublish = $("btn-publish");
  els.publishMenu = $("publish-menu");
  els.pubModal = $("publish-modal");
  els.pubClose = $("publish-close");
  els.pubTabs = $("publish-tabs");
  els.pubWidths = $("publish-widths");
  els.pubSrcToggle = $("publish-src-toggle");
  els.pubFrame = $("publish-frame");
  els.pubSrc = $("publish-src");
  els.pubHint = $("publish-hint");
  els.pubCopy = $("publish-copy");
  els.pubCopySrc = $("publish-copy-src");
  els.pubSave = $("publish-save");
  // 公众号排版模式下拉（手动排版 / AI 排版）
  els.pubModeMenu = $("pub-mode-menu");
  els.btnAiLayout = $("btn-ai-layout");
  els.btnAiView = $("btn-ai-view");
  els.btnAiHistory = $("btn-ai-history");
  els.btnAiModel = $("btn-ai-model");
  els.pubAiToggle = $("publish-ai-toggle");
  // 查找 / 替换（入口：Ctrl+F 快捷键与右键菜单；工具栏不放按钮）
  els.findPanel = $("find-panel");
  els.findInput = $("find-input");
  els.replaceInput = $("replace-input");
  els.findRegex = $("find-regex");
  els.findCase = $("find-case");
  els.findWord = $("find-word");
  els.findPrev = $("find-prev");
  els.findNext = $("find-next");
  els.findReplace = $("find-replace");
  els.findReplaceAll = $("find-replace-all");
  els.findUndo = $("find-undo");
  els.findStatus = $("find-status");
  els.findClose = $("find-close");
}

async function init() {
  // 全局兜底：任何一步抛错都记录到状态栏，绝不静默中断（否则后续步骤不执行，
  // 表现为「没有未命名文档」「后端状态一直灰色」「主题不生效」等连锁症状）。
  window.addEventListener("error", (e) => {
    try {
      setStatus("脚本错误: " + (e.message || "unknown"));
      console.error(e.error || e.message);
    } catch (_) {}
  });
  window.addEventListener("unhandledrejection", (e) => {
    try {
      setStatus("异步错误: " + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
    } catch (_) {}
  });

  cacheEls();
  setStatusSink(setStatus); // 让 editor/richtext 等底层模块也能写状态栏

  try {
    createCurrentEditor();
    hist.lastMd = editor.getValue(); // 撤销栈的基线 = 打开时的内容
  } catch (e) {
    console.error("init: createCurrentEditor", e);
  }
  try {
    buildToolbar(els.formatGroup, editor);
  } catch (e) {
    console.error("init: buildToolbar", e);
  }
  try {
    bindEvents();
  } catch (e) {
    console.error("init: bindEvents", e);
  }
  try {
    bindCloseConfirm(); // 关闭窗口前确认未保存修改

    // #8：图片折叠提示条的「知道了」关闭按钮
    const tipClose = document.getElementById("img-fold-tip-close");
    if (tipClose) {
      tipClose.addEventListener("click", () => hideImageFoldTip());
    }
  } catch (e) {
    console.error("init: bindCloseConfirm", e);
  }
  try {
    bindMenuActions(); // 原生窗口菜单栏动作
  } catch (e) {
    console.error("init: bindMenuActions", e);
  }
  try {
    bindOpenPath(); // 系统「打开方式/双击文件」把路径交给本应用
  } catch (e) {
    console.error("init: bindOpenPath", e);
  }
  try {
    initDocTree({
      onOpenFile: openDiskFile,
      onOpenConverted: openConvertedFile,
      onPathRenamed: handleRenamedDoc,
      onPathDeleted: handleDeletedDoc,
      setStatus,
    });
  } catch (e) {
    console.error("init: initDocTree", e);
  }
  try {
    initStickyNotes({ setStatus });
  } catch (e) {
    console.error("init: initStickyNotes", e);
  }

  // 主题：默认浅色；仅当用户显式存过 "dark" 才用深色
  if (localStorage.getItem("theme") === "dark") {
    document.documentElement.classList.remove("light");
  } else {
    document.documentElement.classList.add("light");
  }

  // 恢复侧栏折叠状态（与主题一样持久化在 localStorage）
  if (localStorage.getItem("sidebar-collapsed") === "1") {
    els.result.classList.add("sidebar-collapsed");
    if (els.btnToggle) els.btnToggle.textContent = "›";
  }

  // 启动恢复：优先恢复上次会话里打开的全部文档（#7，包括从文档树转换而来、
  // 尚未落盘的文件），会话为空时才新建一篇空白文档。
  await restoreSession();

  // 后端只用于「导入文件转换」，不阻塞编辑：先让用户能写，再后台探测。
  // backendBaseUrl 只是返回写死的 8765；即使 preload/主进程 IPC 异常也不该让
  // 后端状态检测失效——用 try/catch 兜底，检测本身不依赖 window.api。
  try {
    state.baseUrl = (await window.api.backendBaseUrl()) || state.baseUrl;
  } catch (_) {
    /* 保持默认 http://127.0.0.1:8765 */
  }
  checkBackend();
  try { wireAlertModal(); } catch (e) { console.error("init: wireAlertModal", e); }
  try { bindPreviewAiBar(); } catch (e) { console.error("init: bindPreviewAiBar", e); }
  try { bindAiHistoryToolbar(); } catch (e) { console.error("init: bindAiHistoryToolbar", e); }
  try { bindPreviewImageInsert(); } catch (e) { console.error("init: bindPreviewImageInsert", e); }
  try { bindAiPreviewEditing(); } catch (e) { console.error("init: bindAiPreviewEditing", e); }
  updateCharCount();
}

/** 启动时恢复上次的空白草稿；没有就新建一篇 */
function restoreOrCreateBlank() {
  const draft = loadDraft(BLANK_DOC_NAME);
  newDoc(BLANK_DOC_NAME, draft || "", { silent: true });
  if (draft) setStatus("已恢复上次未保存的内容");
}

/* ============================================================
   会话自动保存 / 恢复（#7）
   ------------------------------------------------------------
   关窗不丢文档：把当前会话里「所有打开的文档」(含从文档树转换而来、
   还没 Ctrl+S 落盘的文件) 持续备份到主进程的 userData/session.json。
   下次启动由 restoreSession() 读回并加入会话列表，避免「关窗后再打开
   会话列表空空如也」。配合 #7 的脏检查，关窗时也能正确提示未保存。
   ============================================================ */
function sessionSnapshot() {
  return {
    files: (state.files || []).map((f) => ({
      name: f.name,
      markdown: f.markdown || "",
      path: f.path || null,
      error: f.error || null,
      dirty: !!f.dirty,
      savedMd: f.savedMd || (f.markdown || ""),
      theme: f.theme || null,
      themeId: f.themeId || null,
      aiLayoutHistory: f.aiLayoutHistory || [],
    })),
    images: snapshotImages(),
  };
}

let sessionSaveTimer = null;
function scheduleSessionSave() {
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    const snap = sessionSnapshot();
    const snapBytes = JSON.stringify(snap).length;
    const imgCount = snap.images && snap.images.images ? snap.images.images.length : 0;
    perfStage(`sessionSave → IPC(payload=${snapBytes}B, images=${imgCount}${snap.images ? "" : ",图片未变跳过"})`);
    try {
      window.api.sessionSave(snap);
    } catch (_) {}
    perfStage("sessionSave done");
  }, 800);
}

/** 启动恢复：有会话备份则全部加回会话列表；否则回退到空白草稿 */
async function restoreSession() {
  let snap = null;
  try {
    snap = (await window.api.sessionLoad()) || null;
  } catch (_) {
    snap = null;
  }
  // 兼容旧版 session.json（纯文件数组）
  let files = [];
  if (Array.isArray(snap)) {
    files = snap;
  } else if (snap && Array.isArray(snap.files)) {
    files = snap.files;
    // 恢复 @img:id:name 对应的 base64 映射，否则占位图点击会报“已丢失”
    restoreImages(snap.images);
  }
  if (!files.length) {
    restoreOrCreateBlank();
    return;
  }
  // 逐个加回（takeoverBlank=false，避免回收首个文档；空白页在列表里无内容时会被自然忽略）
  files.forEach((s) => {
    const md = s.markdown || "";
    const id = addResult(s.name || "未命名.md", md, s.error || null, false, true, s.path || null);
    const f = state.files.find((x) => x.id === id);
    if (f) {
      f.dirty = !!s.dirty;
      f.savedMd = s.savedMd || md;
      f.theme = s.theme || null;
      f.themeId = s.themeId || null;
      f.aiLayoutHistory = s.aiLayoutHistory || [];
    }
  });
  if (state.files.length) selectFile(state.files[0].id);
  setStatus("已恢复上次的 " + files.length + " 个会话文档");
}

/**
 * 新建一篇文档并切过去。
 * @param {string} name 文档名，重名会自动加序号
 * @param {string} content 初始内容
 */
function newDoc(name = BLANK_DOC_NAME, content = "", { silent = false, theme = null, themeId = null } = {}) {
  const finalName = uniqueName(name);
  // 手动新建不回收空白页，否则「点新建但文件数没变、只是改了个名」会很困惑。
  // 新建/空白文档 userNamed=false：允许按首行内容自动命名。
  const id = addResult(finalName, content, null, false, false, null, theme, themeId);
  selectFile(id); // 新建后总是切过去
  if (!silent) setStatus(`已新建 ${finalName}`);
  editor.focus();
  return id;
}

/** 同名文档自动加序号：未命名.md → 未命名 2.md。excludeId 用于改名时排除自己 */
function uniqueName(name, excludeId = null) {
  const taken = new Set(state.files.filter((f) => f.id !== excludeId).map((f) => f.name));
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 2; i < 9999; i++) {
    const candidate = `${base} ${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}${ext}`;
}

function createCurrentEditor() {
  editor = createEditor({
    type: state.editorType,
    ta: els.source,
    rich: els.rich,
    onChange: onEditorChange,
    onInput: () => { lastEditorInputAt = Date.now(); },
  });
  updateEditorTypeUI();
}

function switchEditorType(type) {
  if (type === state.editorType) return;
  const md = editor.getValue();
  state.editorType = type;
  createCurrentEditor();
  editor.setValue(md);
  editor.focus();
  resetFind(); // 编辑器换了，查找的匹配索引/文本映射全部作废
}

function updateEditorTypeUI() {
  const isRich = state.editorType === "richtext";
  els.source.classList.toggle("hidden", isRich);
  els.rich.classList.toggle("hidden", !isRich);
  els.btnRich.classList.toggle("active", isRich);
  els.btnSource.classList.toggle("active", !isRich);
}

/**
 * 探测 Python 后端。
 * 后端只影响「导入文件转换」，纯写作不依赖它，所以失败时不打断编辑。
 * - fetch 带 3s 超时（AbortController），避免请求挂起导致圆点一直灰。
 * - 失败立即标红（重试最多 5 次，成功自动转绿）；/formats 失败不影响连接状态。
 */
async function checkBackend(attempt = 1) {
  const markOk = () => {
    els.backendStatus.className = "dot green";
    els.backendStatus.title = "转换后端已连接";
    els.statusHint.textContent = "后端已连接 ✓";
  };
  const markFail = () => {
    els.backendStatus.className = "dot red";
    els.backendStatus.title = "转换后端未连接：无法导入 Word/PDF 等文件，但可以正常写作";
    els.statusHint.textContent = "后端未连接，请检查 Python 环境";
  };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch(`${state.baseUrl}/health`, { cache: "no-store", signal: ctrl.signal });
    clearTimeout(timer);
    const data = await res.json();
    if (data.status !== "ok") throw new Error("bad health");
    markOk();
    // /formats 失败只影响「打开文件」的扩展名过滤，不影响连接状态
    try {
      const f = await fetch(`${state.baseUrl}/formats`, { cache: "no-store" });
      state.formats = (await f.json()).extensions || [];
    } catch (_) {}
    setStatus("后端已连接 ✓");
    return true;
  } catch (_) {
    markFail();
    if (attempt < 5) {
      // 后端可能还在启动中：稍后重试，成功会转绿
      setTimeout(() => checkBackend(attempt + 1), 1200);
      return false;
    }
    setStatus("转换后端未连接：可正常写作，但暂时无法导入 Word / PDF 等文件");
    return false;
  }
}

/* ---------- 事件绑定 ---------- */
function bindEvents() {
  els.btnOpen.addEventListener("click", openFiles);
  els.btnOpen3.addEventListener("click", openFiles);
  els.btnNew.addEventListener("click", () => newDoc());
  els.btnSave.addEventListener("click", () => saveCurrentFile());
  els.btnUndo.addEventListener("click", undoHistory);
  els.btnRedo.addEventListener("click", redoHistory);
  els.btnCopy.addEventListener("click", copyMarkdown);
  // 注意：导出按钮只负责展开下拉菜单（见 bindExportMenu），具体导出在菜单项里触发，
  // 这里不要再直接绑 exportMarkdown，否则点击时会"既展开菜单又直接弹出 MD 另存对话框"。
  els.btnClear.addEventListener("click", clearAll);
  els.btnToggle.addEventListener("click", toggleSidebar);
  els.btnTheme.addEventListener("click", undefined);
  els.btnFocus.addEventListener("click", toggleFocus);
  els.btnRich.addEventListener("click", () => switchEditorType("richtext"));
  els.btnSource.addEventListener("click", () => switchEditorType("source"));

  // 文件名是只读标签（用户要求取消标题输入），自动命名由 maybeAutoName 驱动

  document.querySelectorAll(".tb-group.mode .seg").forEach((seg) => {
    seg.addEventListener("click", () => setMode(seg.dataset.mode));
  });

  // 全局拖拽：覆盖层平时隐藏，把文件拖进窗口时才浮现。
  // 这样编辑区一直可用，拖文件导入也仍然随时可做。
  bindGlobalDrop();

  // 主题按文档独立存储（见 sessionSnapshot / restoreSession），随 selectFile 载入，
  // 不再在此做全局恢复，避免「一篇选主题、所有文档都变」的旧问题（#8）。
  // 分隔条拖拽
  initResizer();
  // 分屏滚动联动
  attachScrollSync();
  // 预览中的图片占位块：点击单独展开该图（避免一次性解码全部 base64）
  bindPreviewExpand();
  // 导出下拉菜单 + 查找替换 + 专注模式增强
  bindExportMenu();
  bindPublishMenu();
  bindPublishModal();
  bindThemeUI();
  bindStyleModal();
  bindBlockFormatHint();
  bindFind();
  bindFocusDim();
  // 侧栏标签页切换（文档树 / 会话 / 便签）
  bindSidebarTabs();

  // 编辑区右键菜单（Typora 风格）。editor 实例在切换模式时会被重建，
  // 所以这里传 getter 而不是当前实例。
  bindEditorContextMenu({
    targets: [els.source, els.rich],
    getEditor: () => editor,
    onFind: () => openFind(true),
    onStatus: setStatus,
    onUndo: undoHistory,
    onRedo: redoHistory,
    onReplaceImage: (img) => replaceImageForEl(img, true),
    onZoomImage: (img) => openImageLightbox(resolveImageSrc(img)),
  });
  // 预览区图片右键菜单 + 放大灯箱（#190）
  bindPreviewContextMenu();
  bindImageLightbox();

  // Ctrl+N 新建文档已统一由「全局快捷键分发」处理（可自定义）
}

/**
 * 全局拖拽导入。
 * dragenter/dragleave 在子元素间移动时会频繁成对触发，用计数器判断是否真的离开了窗口。
 * 只有拖的是「文件」才显示覆盖层——在编辑器里拖动选中文字不该弹出导入提示。
 */
function bindGlobalDrop() {
  const dz = els.dropzone;
  let depth = 0;
  // 编辑区内部拖动（移动图片 / 文字）不应触发"导入转换"。
  // 这类拖动在 contenteditable 里会带上 Files 类型，单看 types 无法与 OS 拖入区分，
  // 所以这里用 dragstart/dragend 标记：只要拖拽是从编辑区内部发起的，就放行原生 DnD，
  // 不去 preventDefault、也不走 handleFileObjects（否则会"松手即转换"并在侧栏生成新文档）。
  let internalDrag = false;
  [els.rich, els.source, els.preview].forEach((t) => {
    if (!t) return;
    t.addEventListener("dragstart", () => {
      internalDrag = true;
    });
    t.addEventListener("dragend", () => {
      internalDrag = false;
    });
  });

  const isFileDrag = (e) =>
    !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files");

  const hide = () => {
    depth = 0;
    dz.classList.add("hidden");
    dz.classList.remove("dragover");
  };

  window.addEventListener("dragenter", (e) => {
    if (internalDrag) return; // 内部拖动：不显示导入覆盖层
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    dz.classList.remove("hidden");
    dz.classList.add("dragover");
  });

  window.addEventListener("dragover", (e) => {
    if (internalDrag) return; // 内部拖动：不拦截，编辑区原生移动图片才能生效
    if (!isFileDrag(e)) return;
    e.preventDefault(); // 不阻止的话浏览器会直接打开文件
    e.dataTransfer.dropEffect = "copy";
  });

  window.addEventListener("dragleave", (e) => {
    if (internalDrag) return;
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });

  window.addEventListener("drop", (e) => {
    if (internalDrag) return; // 内部拖动：交给编辑区原生处理，不转换
    e.preventDefault();
    hide();
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) handleFileObjects(files);
  });
}

/* 点击预览里的图片占位块 .img-ph，按 id 取回 base64 并就地替换为真实图片 */
function bindPreviewExpand() {
  els.preview.addEventListener("click", (e) => {
    const ph = e.target.closest(".img-ph");
    if (ph) {
      const id = ph.dataset.imgId;
      const dataUri = id ? getImageById(Number(id)) : null;
      if (!dataUri) {
        ph.textContent = "🖼️ 图片（已丢失，无法展开）";
        return;
      }
      const img = document.createElement("img");
      img.src = dataUri;
      img.alt = ph.textContent || "图片";
      img.loading = "lazy";
      img.className = "img-expanded";
      ph.replaceWith(img);
    }
  });
  bindAnchorClick(els.preview); // L2：内部链接 [文字](#标题) 平滑跳转
}

/* ---------- 图片右键：放大查看 / 替换 / 复制 / 删除（#190） ---------- */

/** 打开图片放大灯箱 */
function openImageLightbox(src) {
  const box = document.getElementById("img-lightbox");
  const img = document.getElementById("img-lightbox-img");
  if (!box || !img || !src) return;
  img.src = src;
  box.classList.remove("hidden");
}
function closeImageLightbox() {
  const box = document.getElementById("img-lightbox");
  if (!box) return;
  box.classList.add("hidden");
  const img = document.getElementById("img-lightbox-img");
  if (img) img.src = "";
}
function bindImageLightbox() {
  const box = document.getElementById("img-lightbox");
  if (!box) return;
  box.addEventListener("click", (e) => {
    if (e.target === box || e.target.closest("#img-lightbox-close")) closeImageLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !box.classList.contains("hidden")) closeImageLightbox();
  });
}

/** 从图片元素（img 或折叠占位块）解析出可放大的完整 src */
function resolveImageSrc(el) {
  if (!el) return null;
  if (el.tagName === "IMG") {
    const src = el.getAttribute("src") || "";
    if (src.startsWith("data:image/")) return src;
    if (el.dataset && el.dataset.imgId) return getImageById(Number(el.dataset.imgId));
  }
  if (el.dataset && el.dataset.imgId) return getImageById(Number(el.dataset.imgId));
  return null;
}

/** 预览区右键图片菜单（#190） */
function bindPreviewContextMenu() {
  if (!els.preview) return;
  els.preview.addEventListener("contextmenu", (e) => {
    const target = e.target.closest?.("img, .img-ph");
    if (!target) return; // 非图片不拦截，走默认菜单
    e.preventDefault();
    const src = resolveImageSrc(target);
    showContextMenu(buildImageContextItems(target, false, src), e.clientX, e.clientY);
  });
}

/** 组装「图片右键菜单」项（编辑区 / 预览区共用） */
function buildImageContextItems(el, isEditor, src) {
  const items = [];
  if (src) items.push({ label: "放大查看", action: () => openImageLightbox(src) });
  items.push({ label: "替换图片", action: () => replaceImageForEl(el, isEditor) });
  items.push({ sep: true });
  items.push({
    label: "复制图片",
    disabled: !src,
    action: async () => {
      if (!src) return;
      const ok = await window.api.clipboardWriteImage(src);
      setStatus(ok ? "图片已复制到剪贴板" : "复制失败");
    },
  });
  items.push({
    label: "图片另存为…",
    disabled: !src,
    action: async () => {
      if (!src) return;
      const name = (el.getAttribute("alt") || "image").replace(/[\\/:*?"<>|]/g, "_");
      const p = await window.api.saveImage(src, `${name}.png`);
      if (p) setStatus(`图片已保存：${p}`);
    },
  });
  items.push({ sep: true });
  items.push({ label: "删除图片", danger: true, action: () => deleteImageEl(el, isEditor) });
  return items;
}

/** 替换图片：选本地图 → 更新映射（@img 占位图）或改写 Markdown（内联图）（#190） */
async function replaceImageForEl(el, isEditor) {
  const picked = await pickImageFile();
  if (!picked) {
    setStatus("已取消替换图片");
    return;
  }
  const { dataUri } = picked;
  const id = el.dataset ? el.dataset.imgId : null;
  if (id) {
    // 占位图：只换映射，正文 Markdown 的 @img:id 不变，跨重渲染 / 会话恢复均生效
    replaceImage(id, dataUri);
    if (isEditor && el.tagName === "IMG") {
      el.src = dataUri;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    renderPreview();
    scheduleSessionSave();
    setStatus("已替换图片");
    return;
  }
  // 内联 base64 图（如组件封面图）：直接改写 Markdown 里的旧 base64
  const oldSrc = el.getAttribute ? el.getAttribute("src") : "";
  const md = currentMarkdown() || "";
  if (!oldSrc || !md.includes(oldSrc)) {
    setStatus("无法定位原图，替换失败");
    return;
  }
  const newMd = md.split(oldSrc).join(dataUri);
  const f = activeFile();
  if (f) f.markdown = newMd;
  renderActive();
  setStatus("已替换图片");
}

/** 删除图片（DOM + Markdown） */
function deleteImageEl(el, isEditor) {
  if (isEditor) {
    el.remove();
    el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const id = el.dataset ? el.dataset.imgId : null;
    const md = currentMarkdown() || "";
    let newMd = md;
    if (id) {
      newMd = md.replace(new RegExp(`!\\[[^\\]]*\\]\\(@img:${id}:[^)]*\\)`, "g"), "");
    } else {
      const src = el.getAttribute ? el.getAttribute("src") : "";
      if (src) newMd = md.split(src).join("");
    }
    const f = activeFile();
    if (f) f.markdown = newMd;
    renderActive();
  }
  setStatus("已删除图片");
}

/** 打开本地图片选择器，回传 { dataUri, name }；取消回传 null */
function pickImageFile() {
  return new Promise((resolve) => {
    openLocalImageFile((dataUrl) => {
      resolve(dataUrl ? { dataUri: dataUrl, name: "image" } : null);
    });
  });
}

/* ---------- 文件转换 ---------- */
async function openFiles() {
  const paths = await window.api.openFile(state.formats);
  if (!paths || !paths.length) return;
  await convertByPaths(paths);
}

// 原生文本格式：这些扩展名本身就是 Markdown / 纯文本，直接读原文即可，
// 绝不能丢给 markitdown 后端二次转换（会把内容清空或报错，表现为「转换中」后空白 + 标题变红）。
const NATIVE_TEXT_EXT = new Set([".md", ".markdown", ".mdx", ".txt"]);
function extOf(p) {
  const m = /\.[^.\\/]+$/.exec(p || "");
  return m ? m[0].toLowerCase() : "";
}

async function convertByPaths(paths) {
  showOverlay(`转换中 (0/${paths.length})`);
  let lastId = null;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    const name = p.split(/[\\/]/).pop();
    els.overlayText.textContent = `转换中 (${i + 1}/${paths.length})`;
    try {
      if (NATIVE_TEXT_EXT.has(extOf(p))) {
        // 原生文本：直接读原文载入（保留 filePath，可 Ctrl+S 写回原文件）
        const r = await window.api.readTextFileAbs(p);
        if (!r || !r.ok) {
          lastId = addResult(name, null, (r && r.error) || "读取失败");
        } else {
          lastId = addResult(name, r.text, null, true, true, p);
        }
        continue;
      }
      const res = await fetch(`${state.baseUrl}/convert_path`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
      const data = await res.json();
      lastId = addResult(name, data.markdown, data.error);
    } catch (err) {
      lastId = addResult(name, null, err.message);
    }
  }
  hideOverlay();
  // 导入后直接选中并展示导入的文档（即便当前已在编辑其它文档）
  if (lastId) selectFile(lastId);
  switchToResult();
}

async function handleFileObjects(fileList) {
  // Electron 拖入的 File 带 .path，优先走 /convert_path（后端能找到同目录图片）
  const paths = [...fileList].map((f) => f.path).filter(Boolean);
  if (paths.length === fileList.length && paths.length > 0) {
    return convertByPaths(paths);
  }
  showOverlay(`转换中 (0/${fileList.length})`);
  let lastId = null;
  for (let i = 0; i < fileList.length; i++) {
    const f = fileList[i];
    els.overlayText.textContent = `转换中 (${i + 1}/${fileList.length})`;
    const fd = new FormData();
    fd.append("file", f);
    try {
      const res = await fetch(`${state.baseUrl}/convert`, { method: "POST", body: fd });
      const data = await res.json();
      lastId = addResult(f.name, data.markdown, data.error);
    } catch (err) {
      lastId = addResult(f.name, null, err.message);
    }
  }
  hideOverlay();
  // 导入后直接选中并展示导入的文档（即便当前已在编辑其它文档）
  if (lastId) selectFile(lastId);
  switchToResult();
}

/* ---------- 文件列表 ---------- */
/**
 * @param {boolean} takeoverBlank 导入文件时若当前停在一篇一个字都没写的空白页，
 *   就顺手回收它，免得文件列表堆满「未命名.md」。手动点「新建」时不回收。
 */
/**
 * @param {boolean} takeoverBlank 导入文件时若当前停在一篇一个字都没写的空白页，
 *   就顺手回收它，免得文件列表堆满「未命名.md」。手动点「新建」时不回收。
 * @param {boolean} userNamed 文档名是否由用户确定（导入文件=true，空白/新建=false 允许首行自动命名）
 */
function addResult(name, markdown, error, takeoverBlank = true, userNamed = true, filePath = null, theme = null, themeId = null) {
  const takeover = takeoverBlank && isBlankUntouched() ? state.activeId : null;

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  // dirty：相对「上次保存」是否有未保存修改（Ctrl+S 才会清掉）。
  // 从磁盘打开的文档（filePath 非空）同样以当前内容作为已保存基线，dirty=false。
  state.files.push({
    id,
    name,
    markdown,
    error,
    userNamed,
    theme: theme || null, // 当前文档独立主题（颜色对象）；null=默认样式
    themeId: themeId || null, // 当前文档独立主题预设 id；null=未选预设
    dirty: false,
    savedMd: markdown || "",
    path: filePath || null,
  });

  if (takeover) {
    const victim = state.files.find((f) => f.id === takeover);
    if (victim) clearDraft(victim.name);
    state.files = state.files.filter((f) => f.id !== takeover);
    state.activeId = null;
  }

  renderList();
  // 没有当前文档、或刚顶掉了空白页时，切到新导入的这篇
  if (!state.activeId) selectFile(id);
  // #7：新增文档后防抖备份会话
  scheduleSessionSave();
  return id;
}

/**
 * 从文档树打开磁盘上的文件：读内容 → 加入会话（带真实路径）。
 * 同一路径已打开则直接切过去；否则新建会话文档，path 写入磁盘路径，
 * 这样后续 Ctrl+S 会静默写回原文件（saveCurrentFile 已支持 f.path）。
 */
/** 从 localStorage 的 docTreeRoots（多根数组）中，找出包含 filePath 的工作文件夹根路径 */
function docRootFor(filePath) {
  let roots = [];
  try {
    const raw = localStorage.getItem("docTreeRoots");
    const v = raw ? JSON.parse(raw) : [];
    if (Array.isArray(v)) roots = v.filter(Boolean);
  } catch (_) {}
  if (!roots.length) {
    // 兼容旧版单个 docTreeRoot 键
    try {
      const old = localStorage.getItem("docTreeRoot");
      if (old) roots = [old];
    } catch (_) {}
  }
  if (!roots.length) return null;
  if (!filePath) return null;
  let best = null;
  for (const r of roots) {
    if (filePath === r || filePath.startsWith(r + "/") || filePath.startsWith(r + "\\")) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best; // 未命中任何根则返回 null（让上层提示「未选择工作文件夹」）
}

async function openDiskFile(filePath) {
  const existing = state.files.find((f) => f.path === filePath);
  if (existing) {
    selectFile(existing.id);
    setStatus("已切换到 " + filePath);
    return;
  }
  let root = null;
  try {
    root = docRootFor(filePath);
  } catch (_) {
    root = null;
  }
  if (!root) {
    setStatus("未选择工作文件夹");
    return;
  }
  let md = null;
  try {
    md = await window.api.readTextFile(root, filePath);
  } catch (_) {
    md = null;
  }
  if (md == null) {
    setStatus("无法读取文件：" + filePath);
    return;
  }
  const name = filePath.split(/[\\/]/).pop();
  const id = addResult(name, md, null, true, true, filePath);
  // 显式选中并渲染：避免首开时 addResult 内部 takeover 逻辑未触发 select 导致编辑区空白
  selectFile(id);
  setStatus("已打开 " + filePath);
}

/**
 * 从文档树打开「可转换但不可直接编辑」的文件（png/word/excel/pdf 等）：
 * 走后端 /convert_path 转成 Markdown，再像普通导入一样加入会话并打开。
 * 不写入原文件路径（filePath=null），Ctrl+S 时弹「另存为」，避免把 md 写回 .docx/.png。
 */
async function openConvertedFile(filePath) {
  const existing = state.files.find((f) => f.path === filePath);
  if (existing) {
    selectFile(existing.id);
    switchToSessionTab();
    setStatus("已切换到 " + filePath);
    return;
  }
  let root = null;
  try {
    root = docRootFor(filePath);
  } catch (_) {
    root = null;
  }
  // 图片：markitdown 对单张图片的 OCR 不可靠，直接 base64 内联成 data URI，
  // 保证在编辑/预览区一定能看到图片内容（而非空白转换结果）。
  if (/\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(filePath)) {
    if (!root) {
      setStatus("未选择工作文件夹");
      return;
    }
    setStatus("正在加载图片 " + filePath + " …");
    try {
      const bin = await window.api.readBinary(root, filePath);
      if (bin && bin.dataUri) {
        const name = filePath.split(/[\\/]/).pop();
        const md =
          `![${name}](${bin.dataUri})\n\n` +
          `> 图片文件：${filePath}\n\n` +
          `_（图片已内联，编辑区可直接查看；Ctrl+S 会以“另存为”导出 Markdown）_`;
        const id = addResult(name, md, null, true, true, filePath);
        selectFile(id);
        switchToSessionTab();
        setStatus("已加载图片 " + filePath);
        return;
      }
    } catch (err) {
      setStatus("图片读取失败：" + (err?.message || err) + "，尝试后端转换…");
    }
  }
  setStatus("正在转换 " + filePath + " …");
  try {
    const res = await fetch(`${state.baseUrl}/convert_path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath }),
    });
    const data = await res.json();
    const name = filePath.split(/[\\/]/).pop();
    const id = addResult(name, data.markdown, data.error, true, true, filePath);
    selectFile(id);
    switchToSessionTab();
    setStatus("已转换并打开 " + filePath);
    // #8：转换后的文档若含图片，编辑器会把大图折叠成 @img 占位符。
    // 若图片总字节超阈值（与渲染时 isDocImageLight 同一判定），提示用户图片已折叠。
    try {
      if (data.markdown && data.markdown.indexOf("data:image/") !== -1) {
        const shrunk = shrinkMarkdown(data.markdown);
        if (!isDocImageLight(shrunk)) showImageFoldTip();
      }
    } catch (_) {}
  } catch (err) {
    setStatus("转换失败：" + (err?.message || err));
  }
}

/** 文档树里某文件被重命名：同步更新已打开且路径匹配的会话文档 */
function handleRenamedDoc(oldPath, newPath) {
  const f = state.files.find((x) => x.path === oldPath);
  if (f) {
    f.path = newPath;
    f.name = newPath.split(/[\\/]/).pop();
    renderList();
  }
}

/** 文档树里某文件/目录被删除：若已打开则一并移除会话文档 */
function handleDeletedDoc(path) {
  const f = state.files.find((x) => x.path === path);
  if (f) deleteFile(f.id);
}

/** 当前是否停在一篇「没动过的空白文档」上 */
function isBlankUntouched() {
  const f = activeFile();
  return !!f && f.name.startsWith("未命名") && !(f.markdown || "").trim();
}

function renderList() {
  els.files.innerHTML = "";
  state.files.forEach((f) => {
    const li = document.createElement("li");
    li.dataset.id = f.id;
    if (f.id === state.activeId) li.classList.add("active");
    if (f.error) li.classList.add("error");
    if (f.dirty) li.classList.add("dirty");
    const chars = f.error ? "✗" : `${(f.markdown || "").length}字`;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = f.name; // textContent 防 XSS
    name.title = f.name;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = chars;
    // 单文档删除按钮（顶部的"清空"只清全部，没法删单个）
    const del = document.createElement("button");
    del.className = "file-del";
    del.title = "删除此文档";
    del.textContent = "✕";
    del.addEventListener("click", (e) => {
      e.stopPropagation(); // 点删除不触发选中
      deleteFile(f.id);
    });
    li.append(name, badge, del);
    li.addEventListener("click", () => selectFile(f.id));
    els.files.appendChild(li);
  });
  els.fileCount.textContent = `${state.files.length} 个文件`;
}

function activeFile() {
  return state.files.find((x) => x.id === state.activeId);
}

function selectFile(id) {
  state.activeId = id;
  // 主题按文档独立：切到哪篇就套用哪篇自己的主题（null=默认样式），
  // 不再让一篇选了主题就影响会话列表里所有文档（#8）。
  const f = state.files.find((x) => x.id === id);
  if (f) {
    state.activeTheme = f.theme || null;
    state.activeThemeId = f.themeId || null;
  }
  hideImageFoldTip();
  hideExportTip();
  renderList();
  renderActive();
  // 切文档后，导出限制可能随「含组件/主题」变化（#189）
  refreshExportMenu();
  updateCharCount();
}

/** #8：大文档图片被折叠时，在编辑区顶部显示一次性提示；切到其它文档即隐藏 */
function showImageFoldTip() {
  const tip = document.getElementById("img-fold-tip");
  if (tip) tip.classList.remove("hidden");
}
function hideImageFoldTip() {
  const tip = document.getElementById("img-fold-tip");
  if (tip) tip.classList.add("hidden");
}

function renderActive() {
  const f = activeFile();
  if (!f) {
    setActionsEnabled(false);
    clearAiTokens();
    return;
  }

  if (f.error) {
    editor.setValue("");
    setActionsEnabled(false);
    clearAiTokens();
    renderPreview();
    return;
  }

  // 优先使用内存中的内容（可能含未保存修改），草稿仅作启动恢复兜底
  const draft = loadDraft(f.name);
  const content = f.markdown || draft || "";
  // 打开文档默认使用富文本（类 Word）模式；不再因文档过大自动降级到源码，
  // 用户若需要仍可在工具栏手动切到源码。当前已是富文本则跳过重建，避免闪烁。
  if (state.editorType !== "richtext") {
    state.editorType = "richtext";
    createCurrentEditor();
  }
  editor.setValue(content);
  // 换文件：历史栈按文档隔离，直接清空，避免撤销跨文档乱跳
  hist.undoStack = [];
  hist.redoStack = [];
  hist.lastMd = editor.getValue();
  hist.lastAt = 0;
  updateHistoryButtons();
  setActionsEnabled(true);
  clearAiTokens();
  resetFind(); // 换文件，查找状态清零
  clearFindUndo(); // 上一份文档的替换快照对新文档无意义
  updateAiHistoryBtn(); // 切文档：刷新历史按钮角标/显隐
  // 自动文档（用户未手动命名）按首行内容补全文件名
  if (!f.userNamed) maybeAutoName(content);
  renderPreview();
}

// ╔═════════════════════════════════════════════════════════════════════════╗
// ║ 中文 IME 组词卡顿 · 根因分析（改这里前务必先读）                          ║
// ╠═════════════════════════════════════════════════════════════════════════╣
// ║ 现象：中文组词过程中文字显示正常，但候选窗/整编辑器肉眼发卡；英文流畅。     ║
// ║                                                                           ║
// ║ 是否原生问题？—— 否。                                                     ║
// ║   · 原生 contenteditable / textarea 的文字输入、IME 组词引擎本身没问题。   ║
// ║   · 自测关闭本函数（[禁改动] 早退）即丝滑、英文始终流畅，可证原生编辑/IME 健康。║
// ║                                                                           ║
// ║ 是否后来加的功能导致？—— 是，且是主因。                                    ║
// ║   把 Markdown 编辑器做成桌面应用时，我们在每次按键的 onEditorChange 上同步   ║
// ║   挂了一堆「应用层派生功能」，每一项都会触发重排/重绘，与中文候选窗抢主线程：║
// ║     · 实时预览重渲染（markdown 解析 + DOM 重建）                          ║
// ║     · 侧栏文件徽标/脏标记、字数统计、首行自动命名文件名、复制按钮可用态     ║
// ║     · 撤销栈快照、会话自动备份（早期甚至搬运全部图片 base64）             ║
// ║   中文候选窗对 repaint 极敏感；词间停顿（选词 300~800ms）正好撞上这些 DOM  ║
// ║   写爆发 → 重绘打断 IME → 肉眼卡。它不表现为「长任务」（JS 全在 1ms 内）， ║
// ║   故用 Performance 火焰图看不出来，只能靠「禁改动对照」定罪。             ║
// ║                                                                           ║
// ║ 修法（治本，非治标）：                                                      ║
// ║   打字/组词活跃期（composing 或距上次输入 < UI_IDLE）只更新正文，跳过全部   ║
// ║   派生 DOM 写，改由 scheduleUiRefresh 在「停手 2.5s」后统一补刷一次；       ║
// ║   组词期 scheduleRender/renderPreview 直接跳过预览重渲染。                ║
// ║   ※ 关拼写检查、contain:layout、overflow-anchor 等只是缓解，非根因。       ║
// ╚═════════════════════════════════════════════════════════════════════════╝
// 中文 IME 组词 / 连续打字活跃期：距上次输入 < UI_IDLE(2500ms) 或正在组词。
// 这段时间内跳过所有「派生 DOM 写」（文件名、历史栈、列表徽标、字数、复制按钮、
// 会话备份、预览重渲染）——它们各自触发重排/重绘，中文候选窗对 repaint 极敏感，
// 会在词间停顿撞上下一次组词 → 肉眼卡顿，且不表现为长任务（JS<1ms）。
// 改为停手 2.5s 后由 scheduleUiRefresh 统一补刷一次。
const UI_IDLE = 2500;
let uiRefreshTimer = null;
let pendingUiMd = null;

function onEditorChange(md) {
  const f = activeFile();
  if (!f || f.error) return;
  // 基础状态更新（轻量，必须即时）：正文、dirty、版本号
  f.markdown = md;
  // 手动保存模型：编辑不自动落盘（既不写文件也不写草稿），只标记 dirty；
  // Ctrl+S 才保存。草稿仅在保存/关闭时写入，用于崩溃恢复。
  f.dirty = md !== f.savedMd;
  docVersion++; // 文档变了：查找缓存 / 富文本文本映射需要重建
  scheduleRender();
  // 打字 / 组词活跃期：延迟所有派生 UI 刷新，避免重绘打断 IME
  const typing = window.__peneditComposing || (lastEditorInputAt ? Date.now() - lastEditorInputAt < UI_IDLE : false);
  if (typing) {
    scheduleUiRefresh(md);
    return;
  }
  flushUiRefresh(md);
  perfStage("onEditorChange(md=" + (md || "").length + "字)");
}

// 停手 2.5s 后统一补刷派生 UI（字数/徽标/文件名/复制按钮/历史/会话备份/预览）
function scheduleUiRefresh(md) {
  pendingUiMd = md;
  if (uiRefreshTimer) return; // 已排程则不重置计时（首次按键起算，期间只续延）
  const run = () => {
    uiRefreshTimer = null;
    const stillTyping = window.__peneditComposing || (lastEditorInputAt ? Date.now() - lastEditorInputAt < UI_IDLE : false);
    if (stillTyping) { scheduleUiRefresh(pendingUiMd); return; } // 还在打，续延
    flushUiRefresh(pendingUiMd);
  };
  if (typeof requestIdleCallback === "function") uiRefreshTimer = requestIdleCallback(run, { timeout: UI_IDLE + 500 });
  else uiRefreshTimer = setTimeout(run, UI_IDLE);
}

// 真正执行派生 UI 刷新（非打字期调用，或停手后由 scheduleUiRefresh 补刷）
function flushUiRefresh(md) {
  const f = activeFile();
  if (!f || f.error) return;
  // 用户没手动命名时，随首行内容自动更新文件名
  maybeAutoName(md);
  // 撤销/重做历史栈（合并连续输入）
  recordHistory(md);
  // 轻量刷新当前文件在列表里的脏标记 / 字数徽标（不重建整个列表，避免打字卡顿）
  refreshListBadge(f);
  updateCharCount();
  // 文档可能刚插入/删除了组件（tmpl-keep），及时刷新「复制」按钮可用性（#200）
  updateCopyButton();
  // 编辑即退出 AI 排版预览，恢复实时 Markdown 预览（避免预览与正文不一致）
  if (state.previewAi) {
    scheduleRender(); // 下一帧按新正文重新渲染预览
  }
  // #7：内容变更后防抖备份会话，关窗后也能恢复
  scheduleSessionSave();
}

/** 只更新当前文件在左侧列表中的徽标与脏标记（onChange 高频调用，必须轻量） */
function refreshListBadge(f) {
  const li = els.files.querySelector(`li[data-id="${CSS.escape(f.id)}"]`);
  if (!li) return;
  li.classList.toggle("dirty", f.dirty);
  const badge = li.querySelector(".badge");
  if (badge) badge.textContent = f.error ? "✗" : `${(f.markdown || "").length}字`;
}

/* ============================================================
   撤销 / 重做（自建快照历史栈）
   ------------------------------------------------------------
   为什么不用 document.execCommand('undo')？
   contenteditable 的原生撤销栈只认 execCommand 操作；我们大量直接改 DOM
   （代码块/公式/表格的 insertNodeAtCaret、innerHTML 等），会把原生栈"弄脏"，
   导致 Ctrl+Z 没反应或乱跳。这里改成「以 Markdown 快照为单位」的栈，
   两种编辑模式统一、覆盖一切变更来源（含查找替换）。
   ------------------------------------------------------------ */
const hist = { undoStack: [], redoStack: [], lastMd: "", lastAt: 0, restoring: false };

/** 编辑器内容变化时记录历史。连续输入（<600ms）合并成一个撤销步骤。 */
function recordHistory(md) {
  if (hist.restoring) return; // 撤销/重做自身触发的恢复不记录
  if (md === hist.lastMd) return;
  const now = Date.now();
  if (now - hist.lastAt < 600 && hist.undoStack.length) {
    // 连续输入：不压栈，把"本次输入前"的状态留在栈顶，之后一步撤回到输入前
  } else {
    hist.undoStack.push(hist.lastMd);
    if (hist.undoStack.length > 200) hist.undoStack.shift(); // 上限 200，防大文档吃内存
    hist.redoStack = [];
  }
  hist.lastAt = now;
  hist.lastMd = md;
  updateHistoryButtons();
}

/** 编辑器内容被历史栈恢复后，手动刷新派生状态（setValue 不触发 onChange） */
function refreshAfterHistory(action) {
  const f = activeFile();
  if (!f || f.error) return;
  const md = editor.getValue();
  f.markdown = md;
  f.dirty = md !== f.savedMd;
  docVersion++;
  scheduleRender();
  refreshListBadge(f);
  updateCharCount();
  updateHistoryButtons();
  setStatus(action);
}

function undoHistory() {
  if (!hist.undoStack.length) {
    setStatus("没有可撤销的操作");
    return;
  }
  hist.redoStack.push(hist.lastMd);
  const prev = hist.undoStack.pop();
  hist.restoring = true;
  editor.setValue(prev);
  hist.lastMd = prev;
  hist.restoring = false;
  editor.focus();
  refreshAfterHistory("已撤销 (Ctrl+Z)");
}

function redoHistory() {
  if (!hist.redoStack.length) {
    setStatus("没有可重做的操作");
    return;
  }
  hist.undoStack.push(hist.lastMd);
  const next = hist.redoStack.pop();
  hist.restoring = true;
  editor.setValue(next);
  hist.lastMd = next;
  hist.restoring = false;
  editor.focus();
  refreshAfterHistory("已重做 (Ctrl+Y)");
}

/* ============================================================
   手动保存（Ctrl+S）—— 不再实时落盘
   ------------------------------------------------------------
   首次保存：弹「另存为」选择路径；之后 Ctrl+S 静默写回同一文件。
   保存时若文档含 base64 图片，自动提取归档到 <md目录>/assets/ 下，
   Markdown 引用改写为相对路径（PRD L2「图片资源管理」）。
   ------------------------------------------------------------ */

const BASE64_RESOURCE_RE = /(!\[[^\]]*\]\(data:image\/([a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+\))|(<(audio|video)\b[^>]*\bsrc="(data:(?:audio|video)\/([a-zA-Z0-9.+-]+);base64,[A-Za-z0-9+/=]+)")/gi;

/** 从 Markdown 中提取所有 base64 资源（图片 / 音频 / 视频），返回 [{ name, dataUrl }]（按出现顺序编号） */
function extractBase64Images(md) {
  const files = [];
  const counts = { img: 0, audio: 0, video: 0 };
  let m;
  while ((m = BASE64_RESOURCE_RE.exec(md))) {
    if (m[1]) {
      // 图片 ![alt](data:image/...)
      const ext = m[2].toLowerCase() === "jpeg" ? "jpg" : m[2].toLowerCase();
      counts.img++;
      files.push({ name: `img-${String(counts.img).padStart(2, "0")}.${ext}`, dataUrl: m[1].slice(m[1].indexOf("data:")) });
    } else if (m[4]) {
      // 音频/视频 <audio|video src="data:...">
      const type = m[4].toLowerCase();
      const ext = m[7].toLowerCase();
      counts[type]++;
      files.push({ name: `${type}-${String(counts[type]).padStart(2, "0")}.${ext}`, dataUrl: m[6] });
    }
  }
  return files;
}

/** 把 md 中的 base64 资源引用替换为相对路径 assets/img-xx.ext / audio-xx.ext / video-xx.ext（顺序与 extractBase64Images 一致） */
function toAssetRefMd(md) {
  const counts = { img: 0, audio: 0, video: 0 };
  return md.replace(BASE64_RESOURCE_RE, (match, imgMatch, imgExt, mediaMatch, mediaTag, mediaDataUri, mediaExt) => {
    if (imgMatch) {
      const ext = imgExt.toLowerCase() === "jpeg" ? "jpg" : imgExt.toLowerCase();
      counts.img++;
      const alt = imgMatch.match(/!\[([^\]]*)\]/)?.[1] || "";
      return `![${alt}](assets/img-${String(counts.img).padStart(2, "0")}.${ext})`;
    }
    const type = mediaTag.toLowerCase();
    const ext = mediaExt.toLowerCase();
    counts[type]++;
    return `<${type} src="assets/${type}-${String(counts[type]).padStart(2, "0")}.${ext}"`;
  });
}

/**
 * 保存当前文档。
 * @param {{forceDialog?: boolean}} opts forceDialog=true 时忽略已记忆的路径强制重新选择
 * @returns {Promise<boolean>} 是否保存成功
 */
async function saveCurrentFile(opts = {}) {
  const f = activeFile();
  if (!f || f.error) {
    setStatus("没有可保存的文档");
    return false;
  }
  setStatus("正在保存…");
  const fullMd = expandMarkdown(currentMarkdown());

  let p = f.path;
  if (!p || opts.forceDialog) {
    const base = (f.name || "未命名.md").replace(/\.[^.]+$/, "") + ".md";
    p = await window.api.choosePath(base, "md");
    if (!p) {
      setStatus("已取消保存");
      return false;
    }
  }

  // 图片保存策略（设置面板可改）：
  //   "archive"（默认）= 提取 base64 → 写 <目录>/assets/ → md 改相对路径（文件夹迁移不失效）
  //   "inline"         = 保持 base64 内嵌（单文件自包含）
  let finalMd = fullMd;
  let archived = 0;
  if (loadImgStrategy() === "archive") {
    const imgs = extractBase64Images(fullMd);
    if (imgs.length) {
      const dir = p.replace(/[\\/][^\\/]*$/, "");
      const ok = await window.api.archiveAssets(dir, imgs);
      if (ok) {
        finalMd = toAssetRefMd(fullMd);
        archived = ok;
      }
    }
  }

  const okWrite = await window.api.writeTextFile(p, finalMd);
  if (!okWrite) {
    setStatus("保存失败，请检查文件是否被占用或路径不可写");
    return false;
  }

  f.path = p;
  f.savedMd = currentMarkdown();
  f.dirty = false;
  saveDraft(f.name, f.savedMd); // 保存成功才写草稿（崩溃恢复用，不是实时保存）
  refreshListBadge(f);
  setStatus(
    archived
      ? `已保存 ${p}（${archived} 张图片已归档到 assets/）`
      : `已保存 ${p}`
  );
  return true;
}

/** 原生窗口菜单栏动作分发（文件/编辑/视图/设置 菜单项） */
function bindMenuActions() {
  if (!window.api || !window.api.onMenuAction) return;
  window.api.onMenuAction((action) => {
    try {
      switch (action) {
        case "newDoc": newDoc(); break;
        case "save": saveCurrentFile(); break;
        case "undo": undoHistory(); break;
        case "redo": redoHistory(); break;
        case "find": openFind(true); break;
        case "openSettings": openSettingsModal(); break;
        case "openWechatSettings": openWechatSettingsModal(); break;
        case "modeSplit": setMode("split"); break;
        case "modeSource": setMode("source"); break;
        case "modePreview": setMode("preview"); break;
        case "richText": switchEditorType("richtext"); break;
        case "sourceMode": switchEditorType("source"); break;
        case "focusMode": toggleFocus(); break;
      }
    } catch (e) {
      console.error("menu action", action, e);
    }
  });
}

/**
 * 操作系统「打开方式 / 双击文件」触发：主进程把双击的文件绝对路径推过来，
 * 走与「打开文件」相同的 convertByPaths（经 markitdown 后端转 Markdown 后载入编辑器）。
 */
function bindOpenPath() {
  if (!window.api || !window.api.onOpenPath) return;
  window.api.onOpenPath((filePath) => {
    if (!filePath) return;
    convertByPaths([filePath]);
  });
}

/**
 * 主进程关闭确认配合（原生对话框在主进程弹）：
 * - window.__getDirtyState：主进程查询当前文档是否有未保存修改；
 * - window.api.onSaveAndClose：主进程点了「保存」→ 渲染进程执行保存 → replyClose。
 */
function bindCloseConfirm() {
  window.__getDirtyState = () => {
    // #7：关闭校验覆盖「所有」打开的文档，而不只是当前激活的那篇。
    // 否则从文档树转换打开、且未在激活态编辑过的文档会被漏掉，关窗直接丢失。
    if (!state.files || !state.files.length) return false;
    return state.files.some((f) => f && f.dirty);
  };
  if (!window.api || !window.api.onSaveAndClose) return;
  window.api.onSaveAndClose(async () => {
    const ok = await saveCurrentFile();
    window.api.replyClose(ok ? "save" : "cancel"); // 保存成功→关闭；失败/取消→保持打开
  });
}

/* ---------- 文件名：首行自动命名 + 手动可改 ---------- */
// 从内容首行取文件名，最多取 20 个字符（超出截断），并去掉 Markdown 标记与首尾标点
function deriveNameFromContent(md) {
  const lines = (md || "").split("\n");
  let first = "";
  for (const l of lines) {
    if (l.trim()) {
      first = l.trim();
      break;
    }
  }
  if (!first) return "未命名.md";
  // 去掉行首 Markdown 标记：# 标题、> 引用、-/*/+ 列表、1. 有序列表、[ ] 任务项
  let base = first.replace(/^(\s*)(#{1,6}\s+|>\s+|[-*+]\s+|\d+\.\s+|\[[ xX]\]\s+)/, "");
  // 去掉行内强调符号与链接语法
  base = base.replace(/[*_`~]/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
  // 去掉首尾标点
  base = base
    .replace(/^[，。、！？：；,.!?:;#>\-[\]()（）「」『』"'"`]+/, "")
    .replace(/[，。、！？：；,.!?:;]+$/, "");
  base = base.slice(0, 20).trim();
  if (!base) return "未命名.md";
  return base + ".md";
}

/** 自动文档：内容变了就按首行重新命名（无手动改名入口，文件名只显示在文件列表） */
function maybeAutoName(md) {
  const f = activeFile();
  if (!f || f.error || f.userNamed) return;
  const derived = deriveNameFromContent(md);
  if (derived === f.name) return;
  setNameOnFile(f, derived, false);
}

/** 改名（自动）。会迁移草稿键，避免旧名草稿残留。excludeId 排除自身防自冲突 */
function setNameOnFile(f, newName, userNamed) {
  newName = uniqueName(newName, f.id);
  const draft = loadDraft(f.name);
  if (draft != null) {
    clearDraft(f.name);
    saveDraft(newName, draft);
  }
  f.name = newName;
  f.userNamed = userNamed;
  renderList();
}

/* ---------- 模式切换 ---------- */
function setMode(mode) {
  if (mode === state.mode) return;
  state.mode = mode;
  els.panes.className = `panes ${mode}`;
  document
    .querySelectorAll(".tb-group.mode .seg[data-mode]")
    .forEach((s) => s.classList.toggle("active", s.dataset.mode === mode));
  if (mode !== "preview") editor.focus();
  if (mode === "split") {
    // 从单栏切回分屏时先渲染再对齐一次，避免两边位置不一致
    renderPreview().then(() => requestAnimationFrame(syncScrollFromEditor));
  } else if (mode === "preview") {
    // 切到预览（无编辑区）：隐藏选区样式条，避免残留浮在预览上
    const sb = document.getElementById("sel-style-bar");
    if (sb) sb.classList.add("hidden");
  }
}

let _actionsFileOpen = false;
function setActionsEnabled(on) {
  _actionsFileOpen = on;
  updateCopyButton();
  els.btnExport.disabled = !on;
  els.btnPublish.disabled = !on;
  els.btnSave.disabled = !on;
  updateHistoryButtons();
  setToolbarEnabled(els.formatGroup, on);
}

/**
 * 复制 Markdown 按钮的可用性：当文档已套主题或含组件（文章排版）时，
 * 复制出去的只是带 tmpl-keep 标记的源码，其它文件打开没有样式，应改用「复制到公众号」。
 * 因此此时禁用该按钮，并用 title 说明原因。
 */
function updateCopyButton() {
  if (!els.btnCopy) return;
  const blocked = _actionsFileOpen && docHasComponentOrTheme();
  els.btnCopy.disabled = !_actionsFileOpen || blocked;
  els.btnCopy.title = blocked
    ? "已套用主题/插入组件：复制出去只是源码（无样式），请用「文章排版 → 复制到公众号」"
    : "复制 Markdown";
}

/** 底部状态栏展示本次 AI 调用的 token 用量（取自 ai:chat 返回的 usage） */
function showAiTokens(label) {
  const el = document.getElementById("token-count");
  if (!el) return;
  const u = lastAiResponse && lastAiResponse.usage;
  if (!u) {
    el.textContent = label + "完成（未返回 token）";
    el.classList.remove("has");
    el.title = "当前接口未返回 token 用量";
    return;
  }
  const inT = u.prompt_tokens || 0;
  const outT = u.completion_tokens || 0;
  const total = u.total_tokens || inT + outT;
  el.textContent = `${label} ${total} tokens（入 ${inT} / 出 ${outT}）`;
  el.classList.add("has");
  el.title = `本次「${label}」消耗 token：输入 ${inT} + 输出 ${outT} = ${total}`;
}

/** 清空状态栏 token 用量（打开/切换文件时，避免残留上一次的统计） */
function clearAiTokens() {
  const el = document.getElementById("token-count");
  if (!el) return;
  el.textContent = "";
  el.classList.remove("has");
}

/** 撤销/重做按钮的可用状态跟随历史栈 */
function updateHistoryButtons() {
  els.btnUndo.disabled = !hist.undoStack.length;
  els.btnRedo.disabled = !hist.redoStack.length;
}

function switchToResult() {
  // 编辑区现在常驻可见，这里只需要确保拖拽覆盖层已收起
  els.dropzone.classList.add("hidden");
  els.result.classList.remove("hidden");
}

/** 折叠 / 展开左侧栏。折叠后文件列表隐藏，编辑区占满；切换按钮本身贴边显示，并根据状态切换箭头方向 */
function toggleSidebar() {
  const collapsed = els.result.classList.toggle("sidebar-collapsed");
  if (els.btnToggle) els.btnToggle.textContent = collapsed ? "›" : "‹";
  try {
    localStorage.setItem("sidebar-collapsed", collapsed ? "1" : "0");
  } catch (_) {}
}

/** 侧栏标签页：文档树 / 会话 / 便签。切换只控制 .tab 与 .tab-panel 的 active/hidden，
 *  并把当前标签持久化到 localStorage，下次启动恢复。 */
function bindSidebarTabs() {
  const tabs = document.querySelectorAll(".sidebar-tabs .tab");
  const panels = document.querySelectorAll(".tab-panel");
  const activate = (name) => {
    tabs.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    panels.forEach((p) => p.classList.toggle("hidden", p.dataset.panel !== name));
    try {
      localStorage.setItem("sidebar-tab", name);
    } catch (_) {}
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activate(tab.dataset.tab));
  });
  // #5：优先恢复上次离开时停留的标签页；没有记录（首次/被清空）才默认「会话」
  let saved = "session";
  try {
    const s = localStorage.getItem("sidebar-tab");
    if (s === "tree" || s === "session" || s === "notes") saved = s;
  } catch (_) {}
  activate(saved);
}

/** 把左侧栏切到「会话」标签页（文档树打开/转换后聚焦会话列表） */
function switchToSessionTab() {
  const tab = document.querySelector('.sidebar-tabs .tab[data-tab="session"]');
  if (tab) tab.click();
}

/* ---------- 渲染预览（防抖 + 分块增量渲染） ---------- */
let renderTimer = null;
let rendering = false;
let renderDirty = false;
function isLargeDoc() {
  return (currentMarkdown() || "").length > LARGE_DOC_CHARS;
}
// 最近一次"用户输入字符"的时刻。预览渲染据此做「空闲闸门」：
// 用户正在打字（距上次输入 <200ms）时绝不重渲染预览，避免每敲一字都触发
// markdown 解析 + DOM 重建冻结主线程（修 #输入卡顿；参考 Typora/MarkText 增量渲染思路）。
let lastEditorInputAt = 0;

function scheduleRender() {
  if (window.__peneditComposing) { renderDirty = true; return; } // 组词期绝不重渲染预览：renderPreview 内部会二次拦截
  clearTimeout(renderTimer);
  const base = isLargeDoc() ? 450 : 180;
  // 把渲染推迟到「用户停手 200ms 后」才执行；连续打字时每次输入都会把渲染往后推，
  // 于是打字过程里预览零重渲染，光标/字符即时显示，停手后才一次性刷新预览。
  const idleAt = lastEditorInputAt + 200;
  const delay = Math.max(base, idleAt - Date.now());
  renderTimer = setTimeout(renderPreview, delay);
}
async function renderPreview() {
  perfStage("renderPreview start");
  if (window.__peneditComposing) { renderDirty = true; return; } // 中文组词期不渲染预览：DOM 重绘会打断候选窗
  if (state.mode === "source") return; // 仅编辑区时不渲染，省性能
  // AI 排版结果直接在分屏预览展示（替代弹出预览）：注入已净化的内联 HTML
  if (state.previewAi && pubState.aiHtml != null) {
    if (rendering) {
      renderDirty = true;
      return;
    }
    rendering = true;
    try {
      const html = pubState.showOriginal ? null : pubState.aiHtml;
      if (html) {
        renderRawHtml(els.preview, html);
        setAiPreviewEditable(pubState.aiEditable !== false); // 排版结果可直接改文字
      } else {
        // 切到「原文」：用现有 Markdown 管线渲染原文档作对比
        setAiPreviewEditable(false);
        await renderMarkdownInto(els.preview, currentMarkdown());
      }
    } finally {
      rendering = false;
      setStatus(
        state.previewAi
          ? pubState.aiEditable !== false && !pubState.showOriginal
            ? "AI 排版预览中（可直接在预览里改文字，复制/保存/推送用改后内容）"
            : "AI 排版预览中（可切「原文」对比，或复制/保存）"
          : "就绪"
      );
      if (renderDirty) {
        renderDirty = false;
        scheduleRender();
      }
    }
    return;
  }
  if (rendering) {
    renderDirty = true; // 渲染期间又有新改动，渲染完再补一次
    return;
  }
  rendering = true;
  const md = currentMarkdown(); // 已折叠为占位符的工作副本，体积小
  setAiPreviewEditable(false); // 普通预览恒为只读
  try {
    await renderMarkdownInto(els.preview, md);
    // 注意：不再在每次渲染后强制把预览滚动对齐到编辑区，
    // 否则链接/图片插入后整篇会跳回顶部。滚动联动由用户手动滚动的监听负责。
  } finally {
    rendering = false;
    if (state.mode !== "source") setStatus("就绪");
    if (renderDirty) {
      renderDirty = false;
      scheduleRender();
    }
  }
}

/* ---------- 滚动联动（分屏：编辑区 ⇄ 预览） ----------
 * 之前失效的原因：#preview 本身不是滚动容器（滚动条在父级 .pane-preview 上），
 * 所以读写它的 scrollTop 永远是 0。现在 CSS 已把 #preview 设为
 * height:100%; overflow-y:auto，它就是真正的滚动元素了。
 *
 * 防回环：A 滚动 → 设置 B.scrollTop 会触发 B 的 scroll 事件，若不加锁会来回抖动。
 * 这里用「谁先动谁持锁 + 短超时释放」，比 requestAnimationFrame 更稳（浏览器的
 * scroll 事件是异步节流派发的，可能落在下一帧之后）。
 */
let scrollOwner = null;
let scrollOwnerTimer = null;

function activeEditorEl() {
  return els.source.classList.contains("hidden") ? els.rich : els.source;
}

function syncFromTo(from, to) {
  perfStage("scrollSync(" + from.className + "→" + to.className + ")");
  const fMax = from.scrollHeight - from.clientHeight;
  const tMax = to.scrollHeight - to.clientHeight;
  if (tMax <= 0) return;
  const ratio = fMax > 0 ? from.scrollTop / fMax : 0;
  const target = Math.round(ratio * tMax);
  if (Math.abs(to.scrollTop - target) > 1) to.scrollTop = target;
}

/** 编辑区变化后把预览滚到相同比例（切换模式、插入内容后对齐用） */
function syncScrollFromEditor() {
  if (state.mode !== "split") return;
  syncFromTo(activeEditorEl(), els.preview);
}

function attachScrollSync() {
  const drive = (from, getTo) => () => {
    if (state.mode !== "split") return; // 非分屏没有联动的必要
    if (from.classList.contains("hidden")) return;
    if (window.__peneditComposing) return; // 中文组词期不做滚动联动：syncFromTo 会读 scrollHeight（强制布局），与输入法抢主线程
    if (scrollOwner && scrollOwner !== from) return; // 这次滚动是被对方带动的，忽略
    scrollOwner = from;
    clearTimeout(scrollOwnerTimer);
    syncFromTo(from, getTo());
    scrollOwnerTimer = setTimeout(() => (scrollOwner = null), 120);
  };

  els.source.addEventListener("scroll", drive(els.source, () => els.preview), { passive: true });
  els.rich.addEventListener("scroll", drive(els.rich, () => els.preview), { passive: true });
  els.preview.addEventListener("scroll", drive(els.preview, activeEditorEl), { passive: true });
}
function currentMarkdown() {
  const f = activeFile();
  if (!f || f.error) return "";
  return editor.getValue();
}

/* ---------- 复制 / 导出（最后一步才展开 base64，平时编辑器/预览都保持小巧） ---------- */
async function copyMarkdown() {
  const md = expandMarkdown(currentMarkdown());
  if (!md) return;
  try {
    await navigator.clipboard.writeText(md);
    setStatus("已复制到剪贴板");
  } catch (_) {
    setStatus("复制失败（剪贴板不可用）");
  }
}

async function exportMarkdown() {
  const md = expandMarkdown(currentMarkdown());
  if (!md) return;
  const f = activeFile();
  const base = (f ? f.name : "document").replace(/\.[^.]+$/, "");
  const path = await window.api.saveFile(base + ".md", md, "md");
  if (path) setStatus("已导出 " + path);
}

/* ---------- 导出体积控制（#5）：公众号/头条 md ≤15MB，超限自动压缩图片 ---------- */
const EXPORT_MAX_BYTES = 15 * 1024 * 1024; // 15MB

function byteLenOf(str) {
  if (typeof Blob !== "undefined") {
    try { return new Blob([str]).size; } catch (_) {}
  }
  return unescape(encodeURIComponent(str)).length;
}

/** 把单张 data URI 图片重采样为 JPEG（限制最长边 + 质量），显著减小体积 */
function compressDataUri(dataUri, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) return resolve(dataUri);
        if (w > maxDim || h > maxDim) {
          const scale = maxDim / Math.max(w, h);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#fff"; // JPEG 无透明通道，先铺白底避免透明处变黑
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      } catch (_) {
        resolve(dataUri); // 压缩失败保留原图
      }
    };
    img.onerror = () => resolve(dataUri);
    img.src = dataUri;
  });
}

/** 压缩 Markdown 内所有 base64 图片，迭代降低分辨率/质量直到总体积 ≤ targetBytes */
async function compressMarkdownImages(md, targetBytes) {
  const RE = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+)\)/g;
  const found = [];
  let m;
  while ((m = RE.exec(md))) found.push({ alt: m[1], uri: m[2] });
  if (!found.length) return md;
  let maxDim = 1920;
  let quality = 0.82;
  let last = found.map((f) => f.uri); // 兜底：保持原图
  for (let round = 0; round < 4; round++) {
    const compressed = await Promise.all(found.map((f) => compressDataUri(f.uri, maxDim, quality)));
    last = compressed;
    let i = 0;
    const out = md.replace(RE, () => `![${found[i].alt}](${compressed[i++]})`);
    if (byteLenOf(out) <= targetBytes) return out;
    maxDim = Math.max(720, Math.round(maxDim * 0.7));
    quality = Math.max(0.5, quality - 0.12);
  }
  // 兜底：用最后一轮（最激进压缩）的结果
  let i = 0;
  return md.replace(RE, () => `![${found[i].alt}](${last[i++]})`);
}

/* 设置入口已移至原生窗口菜单（通用设置 / 样式），见 main.js buildAppMenu */

/* ---------- 导出菜单：MD / HTML / PDF ---------- */
/* ============================================================
   公众号 / 头条 主题（选择 → 载入骨架 → 编辑器预览套用主题）
   ============================================================ */

let tmplCatFilter = "全部";


/** ① 主题色样本（一键换色，不替换正文） */

/** ② 行业 / 节日 分类筛选 */

/** ③ 整套主题卡片（点击载入骨架） */

/** 排版组件库：在光标处插入（参考秀米模块化组件）。popover 用 mousedown 保焦，
 *  所以这里直接按当前选区/光标插入，所见即所得。prefix 指定渲染到哪个容器
 *  （默认 "comp" = 工具栏目板弹层；"pub-comp" 此前用于左栏公众号排版面板，现左栏已移除）。 */

/* 只含 <br> 的空段落（光标停在这种空行上时，组件直接顶掉它，避免组件「上方」多出一行） */
function isBlankParagraph(n) {
  return !!n && n.nodeType === 1 && n.tagName === "P" && n.textContent.trim() === "";
}

/**
 * 在光标所在顶层块「之后」插入组件（DOM 级插入，不走 execCommand）。
 * execCommand("insertHTML") 会把当前段落从光标处劈成两半，块级组件前面就会残留一个空行，
 * 表现为「向上加了一行」。这里改为：定位顶层块 → 空行则替换、否则插到它后面 → 光标落到组件下方空段。
 */


/** 「更新目录」：按当前正文标题重新生成正文里所有目录组件 */


/** 一键换色：仅切换当前文档主题色，不替换正文内容（参考 135 一键配色） */


/* ============================================================
   可视化样式面板（正文/标题/引用/代码块主题，实时预览）
   ============================================================ */

// 样式面板字段配置（数据驱动生成控件）。每个字段对应主题对象的一个 key。

let styleWorkTheme = null;

function cloneTheme(t) {
  return t ? JSON.parse(JSON.stringify(t)) : JSON.parse(JSON.stringify(DEFAULT_THEME));
}

/** 实时套用样式面板的工作主题：更新 state、刷新预览、持久化到当前文档 */


function updateStyleVal(input) {
  const val = input.parentNode.querySelector(".style-val");
  if (!val) return;
  if (input.type === "range") val.textContent = input.value + (input.dataset.unit || "");
  else if (input.type === "color") val.textContent = input.value;
  else val.textContent = input.options[input.selectedIndex] ? input.options[input.selectedIndex].textContent : "";
}

/** 把当前工作主题填回控件显示 */
function syncStylePanel() {
  const body = document.getElementById("style-body");
  if (!body) return;
  body.querySelectorAll(".style-input").forEach((input) => {
    const key = input.dataset.key;
    let v = styleWorkTheme[key];
    if (v == null) v = input.dataset.fallback != null ? input.dataset.fallback : "";
    if (input.type === "range") input.value = v;
    else if (input.type === "color") input.value = v || "#000000";
    else input.value = String(v);
    updateStyleVal(input);
  });
}

function closeStyleModal() {
  const modal = document.getElementById("style-modal");
  if (modal) modal.classList.add("hidden");
}

function bindStyleModal() {
  const sClose = document.getElementById("style-close");
  if (sClose) sClose.addEventListener("click", closeStyleModal);
  const sReset = document.getElementById("style-reset");
  if (sReset)
    sReset.addEventListener("click", () => {
      const t = getActiveTheme();
      styleWorkTheme = cloneTheme(t ? t.theme : DEFAULT_THEME);
      syncStylePanel();
      setStatus("已恢复预设样式");
    });
  // 点遮罩关闭弹窗
  const m = document.getElementById("style-modal");
  if (m)
    m.addEventListener("click", (e) => {
      if (e.target === m) m.classList.add("hidden");
    });
}


/* ---------- 导出校验提示（编辑区顶部横幅） ---------- */
function hideExportTip() {
  const tip = document.getElementById("export-tip");
  if (tip) tip.classList.add("hidden");
}

function bindThemeUI() {
  const btn = document.getElementById("btn-template");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (btn.disabled) return; // 禁用态（未开启公众号排版）不打开主题
    });
  }
  const modal = document.getElementById("theme-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
    });
  }
  const close = document.getElementById("theme-close");
  if (close) close.addEventListener("click", undefined);
  const clear = document.getElementById("theme-clear");
  if (clear) clear.addEventListener("click", undefined);
  const custom = document.getElementById("theme-custom");
  if (custom) {
    // 取色器：基于当前主题派生自定义主色（参考 135 一键配色）
    custom.addEventListener("input", () => {
      const base = getActiveTheme() || DEFAULT_THEME;
    });
  }
  const tipClose = document.getElementById("export-tip-close");
  if (tipClose) tipClose.addEventListener("click", hideExportTip);
  bindComponentsUI();
  bindSelectionStyleBar();
  bindAiUI();
  bindAiModelSwitcher();
}

/* ---------- 排版组件库弹层（光标处插入，保焦；悬停展开，与窗口同款样式） ---------- */
function bindComponentsUI() {
  const btn = document.getElementById("btn-components");
  const pop = document.getElementById("comp-pop");
  if (!btn || !pop) return;
  let hideTimer = null;
  const openPop = () => {
    if (btn.disabled) return; // 禁用态（未开启公众号排版）不展开下拉
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    closeAllMenus();
    positionMenuUnder(pop, btn);
    pop.classList.remove("hidden");
  };
  const scheduleClose = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => pop.classList.add("hidden"), 220);
  };
  const cancelClose = () => { if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
  // 鼠标移到「组件」按钮即展开（也保留点击兜底）；禁用态下 CSS pointer-events:none 已拦截，
  // 这里再兜底一次，确保未开启公众号排版时绝不下拉
  btn.addEventListener("mouseenter", openPop);
  btn.addEventListener("click", (e) => { e.stopPropagation(); if (!btn.disabled) openPop(); });
  btn.addEventListener("mouseleave", scheduleClose);
  // 鼠标在弹层内不关闭；移出弹层稍候关闭，避免移动到组件时闪烁
  pop.addEventListener("mouseenter", cancelClose);
  pop.addEventListener("mouseleave", scheduleClose);
  // 阻止 mousedown 默认：点击「组件」按钮时不抢走编辑区焦点，保留光标/选区
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  // 弹层内点击不丢失编辑区焦点（mousedown 阻止默认），确保插入在光标处
  pop.addEventListener("mousedown", (e) => e.preventDefault());
  const closePop = () => { if (hideTimer) clearTimeout(hideTimer); pop.classList.add("hidden"); };
  pop.addEventListener("click", (e) => {
    if (e.target.closest(".tmpl-comp")) closePop();
  });
  const cclose = document.getElementById("comp-close");
  if (cclose) cclose.addEventListener("click", closePop);
  const ctoc = document.getElementById("comp-toc-refresh");
  if (ctoc)
    ctoc.addEventListener("click", (e) => {
      e.stopPropagation();
      closePop();
    });
  document.addEventListener("click", (e) => {
    if (!pop.classList.contains("hidden") && !e.target.closest("#btn-components") && !e.target.closest("#comp-pop")) {
      closePop();
    }
  });
}

/* ---------- 选中即套（秒刷）：选区出现浮动样式条 ---------- */
let lastSelRect = null; // 最近一次选区的视口坐标，供 AI 菜单定位到选区下方
function bindSelectionStyleBar() {
  const bar = document.getElementById("sel-style-bar");
  if (!bar) return;
  const acts = {
    h1: () => editor.toggleHeading(1),
    h2: () => editor.toggleHeading(2),
    quote: () => editor.linePrefix("> "),
    list: () => editor.linePrefix("- "),
    bold: () => editor.wrap("**", "**", "粗体"),
  };
  bar.querySelectorAll("button[data-act]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 保焦
    b.addEventListener("click", () => {
      const fn = acts[b.dataset.act];
      if (fn) {
        try {
          fn();
          setStatus("已套用：" + (b.title || b.dataset.act));
        } catch (_) {}
      }
      bar.classList.add("hidden");
    });
  });
  // 中文输入法组词期间(keyup 带 isComposing)跳过：updateSelBar 内的 getBoundingClientRect
  // 会强制同步布局刷新，而此时输入法正在逐帧重绘组词框，两者抢主线程 → 英文流畅、中文卡。
  // 组词结束后的 keyup 不带 isComposing，照常更新浮动样式条。
  const onSel = (e) => { if (e && e.isComposing) return; updateSelBar(bar); };
  els.rich.addEventListener("mouseup", onSel);
  els.rich.addEventListener("keyup", onSel);
  els.source.addEventListener("mouseup", onSel);
  els.source.addEventListener("keyup", onSel);
  els.rich.addEventListener("blur", () => setTimeout(() => bar.classList.add("hidden"), 150));
  els.source.addEventListener("blur", () => setTimeout(() => bar.classList.add("hidden"), 150));
}

function updateSelBar(bar) {
  // 样式条（标题/引用/列表/加粗）只作用于编辑区，在「分屏/编辑/专注」模式显示；
  // 仅「预览」模式(无编辑区)隐藏
  if (state.mode === "preview") {
    bar.classList.add("hidden");
    return;
  }
  let rect = null;
  if (state.editorType === "richtext") {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      bar.classList.add("hidden");
      return;
    }
    rect = sel.getRangeAt(0).getBoundingClientRect();
  } else {
    const ta = els.source;
    if (ta.selectionStart === ta.selectionEnd) {
      bar.classList.add("hidden");
      return;
    }
    rect = ta.getBoundingClientRect();
    rect = { top: rect.top + 8, left: rect.left + rect.width / 2, width: rect.width, bottom: rect.bottom };
  }
  if (!rect) {
    bar.classList.add("hidden");
    return;
  }
  lastSelRect = { top: rect.top, left: rect.left, width: rect.width || 0, bottom: rect.bottom };
  bar.classList.remove("hidden");
  const bw = bar.offsetWidth || 240;
  let left = rect.left + rect.width / 2 - bw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  bar.style.left = left + "px";
  bar.style.top = Math.max(8, rect.top - bar.offsetHeight - 8) + "px";
}

/* ================= AI 辅助（行内处理 + 自动标题/标签） =================
 * 通过主进程 ai:chat 调用 OpenAI 兼容接口；Key 与网络都在主进程，渲染进程只发消息。
 * 配置在设置面板（settings.js / loadAiSettings）。 */

/** 统一 AI 调用：成功返回文本，失败返回 null 并已 setStatus 提示 */
let lastAiResponse = null; // 供上层判断截断（res.truncated）等

/* 提示词取自公众号《写东西卡壳？这15个AI写作Prompt》文章创作类（润色/改写/续写/概括），
 * 其中 {text} 在 runAiInline 里被选中文本替换。翻译项文章无对应，保留原提示词。 */

/** 行内 AI：选中文字 → 调接口 → 替换/续写选区；未选中则对全文处理 */

/** 自动标题 / 标签：对全文调接口，回填文档标题与标签 */
async function runAiTitleTags() {
  const md = currentMarkdown() || "";
  // ---- 详细日志（写入 ai-layout.log，与 AI 排版同文件）----
  if (!md.trim()) {
    setStatus("文档为空，无法生成标题/标签");
    return;
  }
  const promptHead =
    "请基于下面的文章生成：1) 一个简洁吸引人的标题（不超过20字）；2) 3-5 个关键词标签（逗号分隔）。" +
    "严格按如下格式输出，不要多余解释：\n标题：<标题>\n标签：<标签1>, <标签2>, ...\n\n";
  const fullPrompt = promptHead + md.slice(0, 4000);
  if (out == null) {
    return;
  }
  const mt = out.match(/标题[：:]\s*(.+)/);
  const mg = out.match(/标签[：:]\s*(.+)/);
  const f = activeFile();
  if (mt && f) {
    const title = mt[1].trim().replace(/\.$/, "");
    f.name = title.endsWith(".md") ? title : title + ".md";
    renderList();
    scheduleSessionSave();
  }
  if (mg && f) {
    const tags = mg[1].trim().replace(/\.$/, "");
    f.tags = tags;
    scheduleSessionSave();
    setStatus("AI 标签：" + tags);
  } else if (mt) {
    setStatus("AI 已生成标题");
  } else {
    setStatus("AI 返回格式异常：" + out.slice(0, 60));
  }
  showAiTokens("AI 标题/标签");
}

/** AI 调试日志：写入 <userData>/ai-debug.log（排查 AI 排版空白问题时用，fire-and-forget） */
function aiDbg(msg) {
  try { window.api.debugLog(msg); } catch (_) {}
}

/** AI 排版专属详细日志：写入 <userData>/ai-layout.log，记录完整流程与提示词，便于核对 */

/** 全文 AI 排版：调用 gzh-design-skill 方法论，生成公众号兼容内联 HTML，进发布弹窗预览/复制 */
function showAiBusy(text) {
  const el = document.getElementById("ai-busy");
  if (!el) return;
  const t = el.querySelector(".ai-busy-text");
  if (t && text) t.textContent = text;
  el.classList.remove("hidden");
}
function hideAiBusy() {
  const el = document.getElementById("ai-busy");
  if (el) el.classList.add("hidden");
}


/** 把选区 AI 菜单定位到「选中文字正下方」（而非 AI 按钮处），避免飘到左上角 */
function positionAiMenuUnderSelection(menu) {
  menu.classList.remove("hidden");
  if (menu.parentNode !== document.body) document.body.appendChild(menu);
  const mw = menu.offsetWidth || 150;
  const mh = menu.offsetHeight || 200;
  const rect = lastSelRect;
  if (!rect) {
    menu.style.left = "8px";
    menu.style.top = "8px";
    return;
  }
  let left = rect.left + rect.width / 2 - mw / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = rect.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 6); // 下方放不下 → 上方
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}

/** 选区浮动条上的 AI 按钮 + 下拉菜单（润色/改写/续写/翻译/摘要/标题标签/全文排版） */
function bindAiUI() {
  const bar = document.getElementById("sel-style-bar");
  const aiBtn = bar && bar.querySelector('[data-act="ai"]');
  const menu = document.getElementById("ai-menu");
  if (!bar || !aiBtn || !menu) return;
  menu.querySelectorAll("button[data-ai]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault()); // 保焦，避免丢失选区
    b.addEventListener("click", () => {
      const kind = b.dataset.ai;
      menu.classList.add("hidden");
      bar.classList.add("hidden");
      if (kind === "title") runAiTitleTags();
    });
  });
  aiBtn.addEventListener("mousedown", (e) => e.preventDefault());
  aiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    menu.classList.toggle("hidden");
    if (!menu.classList.contains("hidden")) positionAiMenuUnderSelection(menu);
  });
  // 工具栏常驻「AI ✨」按钮：无需选中文字也能打开菜单；移到按钮上即展开，移出后收起
  const tbAi = document.getElementById("btn-ai");
  if (tbAi) {
    tbAi.addEventListener("mousedown", (e) => e.preventDefault());
    // 移到按钮上即展开
    tbAi.addEventListener("mouseenter", () => {
      closeAllMenus();
      positionMenuUnder(menu, tbAi);
    });
    // 鼠标从按钮移开、且没进入菜单时，稍等片刻收起（给移动到菜单留时间）
    tbAi.addEventListener("mouseleave", () => {
      if (menu.classList.contains("hidden")) return;
      const t = setTimeout(() => {
        if (!menu.matches(":hover")) menu.classList.add("hidden");
      }, 180);
      menu._closeTimer = t;
    });
  }
  // 点其它地方关闭菜单（不关浮动条，浮动条自有失焦逻辑）
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest("#ai-menu") && !e.target.closest('[data-act="ai"]') && !e.target.closest("#btn-ai")) {
      menu.classList.add("hidden");
    }
  });
  // 鼠标移出菜单后收起
  menu.addEventListener("mouseleave", () => {
    if (menu.classList.contains("hidden")) return;
    setTimeout(() => {
      if (!menu.matches(":hover") && !(tbAi && tbAi.matches(":hover"))) menu.classList.add("hidden");
    }, 180);
  });
}

/** 顶栏「AI 模型」下拉：列出所有已配置模型，点击即切换当前使用模型；含「管理模型…」入口 */
function bindAiModelSwitcher() {
  const btn = els.btnAiModel;
  const menu = document.getElementById("ai-model-menu");
  if (!btn || !menu) return;
  const refreshLabel = () => {
    const m = getActiveModel();
    btn.textContent = (m ? (m.name || m.model || "未命名") : "未配置模型") + " ▾";
  };
  window.__refreshAiModelBtn = refreshLabel;
  refreshLabel();
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    closeAllMenus();
    const wasOpen = !menu.classList.contains("hidden");
    menu.classList.add("hidden");
    if (wasOpen) return;
    const models = loadAiModels();
    const active = getActiveModel();
    menu.innerHTML = "";
    if (!models.length) {
      const empty = document.createElement("button");
      empty.disabled = true;
      empty.textContent = "未配置模型";
      menu.appendChild(empty);
    }
    models.forEach((m) => {
      const b = document.createElement("button");
      const isActive = active && active.id === m.id;
      b.innerHTML = (m.name || m.model || "未命名") + (isActive ? ' <span class="ai-check">✓</span>' : "");
      b.addEventListener("click", () => {
        setAiActiveId(m.id);
        refreshLabel();
        menu.classList.add("hidden");
        setStatus("已切换到模型：" + (m.name || m.model));
      });
      menu.appendChild(b);
    });
    const cfg = document.createElement("button");
    cfg.className = "ai-menu-cfg";
    cfg.textContent = "管理模型…";
    cfg.addEventListener("click", () => {
      menu.classList.add("hidden");
      refreshLabel();
    });
    menu.appendChild(cfg);
    menu.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!menu.classList.contains("hidden") && !e.target.closest("#ai-model-menu") && !e.target.closest("#btn-ai-model")) {
      menu.classList.add("hidden");
    }
  });
}

function bindExportMenu() {
  // 阻止 mousedown 默认行为：避免点击时编辑区失焦丢选区（与其它工具栏按钮一致）
  els.btnExport.addEventListener("mousedown", (e) => e.preventDefault());
  // 鼠标移到「导出」按钮上即展开下拉；移出后稍候收起（与公众号排版一致）
  els.btnExport.addEventListener("mouseenter", () => {
    closeAllMenus();
    positionMenuUnder(els.exportMenu, els.btnExport);
  });
  els.btnExport.addEventListener("mouseleave", () => {
    if (els.exportMenu.classList.contains("hidden")) return;
    setTimeout(() => {
      if (!els.exportMenu.matches(":hover") && !els.btnExport.matches(":hover")) els.exportMenu.classList.add("hidden");
    }, 180);
  });
  els.exportMenu.querySelectorAll("button[data-export]").forEach((b) => {
    b.addEventListener("click", () => {
      els.exportMenu.classList.add("hidden");
      doExport(b.dataset.export);
    });
  });
  // 点击菜单外部关闭（按钮在 .dropdown 内，菜单挂 body）
  document.addEventListener("click", (e) => {
    if (
      !els.exportMenu.classList.contains("hidden") &&
      !e.target.closest("#btn-export") &&
      !e.target.closest("#export-menu")
    ) {
      els.exportMenu.classList.add("hidden");
    }
  });
  // 鼠标移出导出菜单后收起
  els.exportMenu.addEventListener("mouseleave", () => {
    if (els.exportMenu.classList.contains("hidden")) return;
    setTimeout(() => {
      if (!els.exportMenu.matches(":hover") && !els.btnExport.matches(":hover")) els.exportMenu.classList.add("hidden");
    }, 180);
  });
}

/** 公众号排版：按钮作为「模式开关」。开启后左侧展开主题+组件面板，
 *  且导出菜单被限制为仅「长图 / HTML」；再次点击退出该模式、恢复全部导出。
 *  （即便不开启该模式，只要当前文档含组件或已套主题，导出也只允许长图 / HTML，见 #189） */
function bindPublishMenu() {
  // #btn-publish 作为下拉触发器：展开「手动排版 / AI 排版 / 空」
  els.btnPublish.addEventListener("mousedown", (e) => e.preventDefault());
  // 鼠标移到「文章排版」按钮上即展开下拉；移出后稍候收起
  const menu = els.pubModeMenu;
  els.btnPublish.addEventListener("mouseenter", () => {
    closeAllMenus();
    positionMenuUnder(menu, els.btnPublish);
    menu.classList.remove("hidden");
  });
  els.btnPublish.addEventListener("mouseleave", () => {
    if (menu.classList.contains("hidden")) return;
    setTimeout(() => {
      if (!menu.matches(":hover") && !els.btnPublish.matches(":hover")) menu.classList.add("hidden");
    }, 180);
  });
  els.pubModeMenu.querySelectorAll("button[data-mode]").forEach((b) => {
    b.addEventListener("mousedown", (e) => e.preventDefault());
    b.addEventListener("click", () => {
      els.pubModeMenu.classList.add("hidden");
      selectPubMode(b.dataset.mode);
    });
  });
  // 鼠标移出下拉后收起
  menu.addEventListener("mouseleave", () => {
    if (menu.classList.contains("hidden")) return;
    setTimeout(() => {
      if (!menu.matches(":hover") && !els.btnPublish.matches(":hover")) menu.classList.add("hidden");
    }, 180);
  });
  // 点击外部关闭模式菜单
  document.addEventListener("click", (e) => {
    if (
      !els.pubModeMenu.classList.contains("hidden") &&
      !e.target.closest("#pub-mode-menu") &&
      !e.target.closest("#btn-publish")
    ) {
      els.pubModeMenu.classList.add("hidden");
    }
  });
  // 组合框内的「复制到公众号」：打开公众号预览弹窗（从原左栏入口迁移而来）
  const copyWechat = document.getElementById("btn-copy-wechat");
  if (copyWechat)
    copyWechat.addEventListener("click", (e) => {
      e.stopPropagation();
      if (copyWechat.disabled) return; // 禁用态（未开启手动排版）不打开预览
    });
  // AI 排版按钮：先弹主题选择（可选），再调 AI 生成
  if (els.btnAiLayout)
    els.btnAiLayout.addEventListener("click", (e) => {
      e.stopPropagation();
      openAiThemeModal();
    });
  // 主题选择弹窗：网格点击选具体主题 / 「让 AI 决定」不指定 / ✕或遮罩关闭
  {
    const aiThemeModal = document.getElementById("ai-theme-modal");
    const aiThemeGrid = document.getElementById("ai-theme-grid");
    if (aiThemeGrid)
      aiThemeGrid.addEventListener("click", (e) => {
        const item = e.target.closest(".ai-theme-item");
        if (!item) return;
        const t = DESIGN_LANGUAGES.find((x) => x.id === item.dataset.id);
        if (aiThemeModal) aiThemeModal.classList.add("hidden");
      });
    const aiThemeSkip = document.getElementById("ai-theme-skip");
    if (aiThemeSkip)
      aiThemeSkip.addEventListener("click", () => {
        if (aiThemeModal) aiThemeModal.classList.add("hidden");
      });
    const aiThemeClose = document.getElementById("ai-theme-close");
    if (aiThemeClose) aiThemeClose.addEventListener("click", () => { if (aiThemeModal) aiThemeModal.classList.add("hidden"); });
    if (aiThemeModal)
      aiThemeModal.addEventListener("click", (e) => { if (e.target === aiThemeModal) aiThemeModal.classList.add("hidden"); });
  }
  // 查看排版按钮：已有上次结果时，直接在分屏预览展示（不重新调 AI）
  if (els.btnAiView)
    els.btnAiView.addEventListener("click", (e) => {
      e.stopPropagation();
    });
  // 初始同步一次导出菜单可见项
  refreshExportMenu();
}

/** 已生成过 AI 排版结果时，在 AI 模式组合框显示「查看排版」按钮，点它重开预览（不重新调 AI） */
function refreshAiViewBtn() {
  if (!els.btnAiView) return;
  const show = document.body.classList.contains("ai-layout-mode") && pubState.aiHtml != null;
  els.btnAiView.classList.toggle("hidden", !show);
  updateAiHistoryBtn();
}

/** 分屏预览顶部的 AI 排版工具条：AI 排版/原文切换 + 复制/保存/退出 */

/* ---------- AI 排版结果「就地改文字」 ----------
 * 排版结果是纯内联样式 HTML，直接把预览容器设成 contenteditable 即可编辑；
 * 用户的改动通过 syncAiHtmlFromPreview() 回写 pubState.aiHtml，
 * 因此复制 / 保存 / 推送拿到的始终是改后的内容。 */
let aiEditSyncTimer = null;
function setAiPreviewEditable(on) {
  if (!els.preview) return;
  if (on) {
    els.preview.setAttribute("contenteditable", "true");
    els.preview.setAttribute("spellcheck", "false");
    els.preview.classList.add("ai-editable");
  } else {
    els.preview.removeAttribute("contenteditable");
    els.preview.classList.remove("ai-editable");
  }
}

/** 把预览里用户改过的 HTML 回写到 pubState.aiHtml（复制/保存/推送前必须调用） */

/** 预览里编辑时防抖回写（避免每敲一个字都拼一次整篇字符串） */
function bindAiPreviewEditing() {
  if (!els.preview) return;
  els.preview.addEventListener("input", () => {
    if (!els.preview.isContentEditable) return;
    clearTimeout(aiEditSyncTimer);
    aiEditSyncTimer = setTimeout(() => {
      setStatus("排版内容已修改（复制 / 保存 / 推送将使用修改后的内容）");
    }, 300);
  });
  // 编辑区里粘贴统一按纯文本处理，避免把外部样式/脚本带进公众号 HTML
  els.preview.addEventListener("paste", (e) => {
    if (!els.preview.isContentEditable) return;
    e.preventDefault();
    const text = (e.clipboardData && e.clipboardData.getData("text/plain")) || "";
    if (text) document.execCommand("insertText", false, text);
  });
}

/** 进入分屏 AI 预览（不重新调 AI）：用于「查看排版」按钮 */

/** 退出分屏 AI 预览，恢复普通 Markdown 预览（由编辑/撤销/切文档/关闭触发） */

/* ===================== AI 排版历史记录 ===================== */
function aiHistoryOf() {
  const f = activeFile();
  return (f && f.aiLayoutHistory) || [];
}

/** 根据当前文档是否有历史，控制工具栏「历史」按钮显隐与角标 */
function updateAiHistoryBtn() {
  if (!els.btnAiHistory) return;
  const inAiMode = document.body.classList.contains("ai-layout-mode");
  const hist = aiHistoryOf();
  const show = inAiMode && (pubState.aiHtml != null || hist.length > 0);
  els.btnAiHistory.classList.toggle("hidden", !show);
  els.btnAiHistory.textContent = hist.length ? `历史 (${hist.length})` : "历史";
}

/** 打开历史面板（锚定到触发按钮下方） */
function openAiHistory(anchor) {
  const panel = document.getElementById("ai-history-panel");
  if (!panel) return;
  renderAiHistoryList();
  panel.classList.remove("hidden");
  // 定位到触发按钮下方（视口翻转兜底）
  const r = (anchor && anchor.getBoundingClientRect()) || null;
  const pw = panel.offsetWidth || 340;
  const ph = panel.offsetHeight || 300;
  if (r) {
    let left = Math.min(r.left, window.innerWidth - pw - 8);
    left = Math.max(8, left);
    let top = r.bottom + 6;
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 6);
    panel.style.left = left + "px";
    panel.style.top = top + "px";
  } else {
    panel.style.left = "50%";
    panel.style.top = "80px";
    panel.style.transform = "translateX(-50%)";
  }
}

function closeAiHistory() {
  const panel = document.getElementById("ai-history-panel");
  if (panel) panel.classList.add("hidden");
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function renderAiHistoryList() {
  const list = document.getElementById("ai-history-list");
  if (!list) return;
  const hist = aiHistoryOf();
  list.innerHTML = "";
  if (!hist.length) {
    const empty = document.createElement("div");
    empty.className = "ahp-empty";
    empty.textContent = "暂无历史记录（每次 AI 排版会自动保存一份）";
    list.appendChild(empty);
    return;
  }
  hist.forEach((h) => {
    const item = document.createElement("div");
    item.className = "ahp-item";
    const meta = document.createElement("div");
    meta.className = "ahp-meta";
    const title = document.createElement("div");
    title.className = "ahp-title";
    title.textContent = fmtTime(h.time);
    const sub = document.createElement("div");
    sub.className = "ahp-sub";
    const tok = h.inT || h.outT ? ` · ${h.inT + h.outT} tokens` : "";
    sub.textContent = `${h.model} · 原文 ${h.sourceLen} 字${tok}`;
    meta.appendChild(title);
    meta.appendChild(sub);
    const del = document.createElement("button");
    del.className = "ahp-del";
    del.type = "button";
    del.textContent = "×";
    del.title = "删除这条记录";
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteAiHistoryEntry(h.id);
    });
    item.appendChild(meta);
    item.appendChild(del);
    item.addEventListener("click", () => restoreAiHistoryEntry(h.id));
    list.appendChild(item);
  });
}

function restoreAiHistoryEntry(id) {
  const h = aiHistoryOf().find((x) => x.id === id);
  if (!h) return;
  pubState.aiHtml = h.html;
  pubState.showOriginal = false;
  state.previewAi = true;
  refreshAiViewBtn();
  closeAiHistory();
  if (state.mode === "source") setMode("split");
  else renderPreview();
  setStatus("已恢复该次 AI 排版历史（可复制 / 保存）");
}

function deleteAiHistoryEntry(id) {
  const f = activeFile();
  if (!f || !f.aiLayoutHistory) return;
  f.aiLayoutHistory = f.aiLayoutHistory.filter((x) => x.id !== id);
  scheduleSessionSave();
  renderAiHistoryList();
  updateAiHistoryBtn();
}

function clearAiHistory() {
  const f = activeFile();
  if (!f) return;
  f.aiLayoutHistory = [];
  scheduleSessionSave();
  renderAiHistoryList();
  updateAiHistoryBtn();
}

/** 分屏预览顶部 AI 工具条：AI 排版/原文切换、复制 HTML、保存 HTML、退出 */
function bindPreviewAiBar() {
  const bar = document.getElementById("preview-ai-bar");
  if (!bar) return;
  bar.querySelectorAll(".pab-av").forEach((b) =>
    b.addEventListener("click", () => {
      pubState.showOriginal = b.dataset.aiView === "original";
      renderPreview();
    })
  );
  // 「✏️ 可编辑」开关：关掉后预览恢复只读（防止误触改内容）
  const editBtn = document.getElementById("preview-ai-edit");
  if (editBtn)
    editBtn.addEventListener("click", () => {
      pubState.aiEditable = pubState.aiEditable === false;
      setAiPreviewEditable(pubState.aiEditable && !pubState.showOriginal);
      setStatus(pubState.aiEditable ? "已开启：可直接在预览里改文字" : "已关闭编辑，预览为只读");
    });
  const copyBtn = document.getElementById("preview-ai-copy");
  if (copyBtn)
    copyBtn.addEventListener("click", async () => {
      if (!pubState.aiHtml) return;
      const ok = await copyPlatformResult({ kind: "html", html: pubState.aiHtml, platform: PLATFORMS.wechat });
      if (ok) {
        showToast("✅ 已复制成功，去公众号后台 Ctrl+V 粘贴");
        setStatus("已复制 AI 排版 HTML，去公众号后台 Ctrl+V");
      } else {
        setStatus("复制失败，请重试");
      }
    });
  const pushBtn = document.getElementById("preview-ai-push");
  if (pushBtn)
    pushBtn.addEventListener("click", () => {
      if (!pubState.aiHtml) return;
      pushAiHtmlToWechat(pushBtn);
    });
  const saveBtn = document.getElementById("preview-ai-save");
  if (saveBtn)
    saveBtn.addEventListener("click", async () => {
      if (!pubState.aiHtml) return;
      const f = activeFile();
      const base = (f && f.name ? f.name.replace(/\.md$/i, "") : "ai-layout") + "-排版";
      const p = await window.api.choosePath(base, "html");
      if (!p) return;
      const ok = await window.api.writeTextFile(p, pubState.aiHtml);
      setStatus(ok ? "已保存 AI 排版 HTML 到本地" : "保存失败，请重试");
    });
  const closeBtn = document.getElementById("preview-ai-close");
  if (closeBtn)
    closeBtn.addEventListener("click", () => {
      renderPreview();
    });
  const histBtn = document.getElementById("preview-ai-history");
  if (histBtn)
    histBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openAiHistory(histBtn);
    });
  // 历史面板：清空 / 点击面板外自动收起
  const clearBtn = document.getElementById("ai-history-clear");
  if (clearBtn) clearBtn.addEventListener("click", (e) => { e.stopPropagation(); clearAiHistory(); });
  const panel = document.getElementById("ai-history-panel");
  if (panel) panel.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => closeAiHistory());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeAiHistory();
  });
}

/**
 * 一键推送 AI 排版到公众号草稿箱。
 * 流程：校验凭证 → 弹确认框（标题/作者/摘要/封面）→ 生成/选取封面 → 主进程代发微信 API。
 */
async function pushAiHtmlToWechat(btn) {
  if (!pubState.aiHtml) {
    showToast("⚠️ 请先生成 AI 排版");
    return;
  }
  if (!isWechatReady()) {
    showToast("⚠️ 尚未配置公众号凭证（设置 → 公众号推送）");
    openWechatSettingsModal();
    return;
  }
  const cfg = loadWechatCfg();
  const md = currentMarkdown() || "";
  let title = "";
  const m = md.match(/^\s*#{1,6}\s+(.+)$/m);
  if (m) title = m[1].replace(/[#*_`]/g, "").trim();
  if (!title) {
    const f = activeFile();
    if (f && f.name) title = f.name.replace(/\.md$/i, "");
  }
  const video =
    /视频|video|bilibili|腾讯视频|西瓜视频|\.mp4|\.mov|youtube/i.test(md) ||
    /class="[^"]*video[^"]*"/i.test(pubState.aiHtml || "");

  openWechatPushModal({ title, video }, async (p) => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "推送中…";
    try {
      let coverDataUrl = null;
      if (p.coverMode === "pick") {
        const img = await pickImageFile();
        if (!img || !img.dataUri) {
          showToast("已取消：未选择封面图");
          return;
        }
        coverDataUrl = img.dataUri;
      } else {
        coverDataUrl = generatePlaceholderCover(p.title || title, p.video);
      }
      const f = activeFile();
      const baseDir = f && f.path ? f.path.replace(/[^\\/]+$/, "") : "";
      const r = await window.api.wechatPush({
        appid: cfg.appid,
        appsecret: cfg.appsecret,
        title: p.title,
        author: p.author,
        digest: p.digest,
        html: pubState.aiHtml,
        coverDataUrl,
        baseDir,
      });
      if (r && r.ok)
        showToast("✅ 已推送草稿箱（" + (r.uploaded || 0) + " 张图已上传微信 CDN）");
      else showToast("❌ 推送失败：" + ((r && r.error) || "未知错误"));
    } catch (e) {
      showToast("❌ 推送异常：" + ((e && e.message) || String(e)));
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

/**
 * 用 canvas 生成 900×383 占位封面（data URL）。
 * video=true 时在左侧加圆形播放按钮 + 左上角红色「视频」标签。
 */
function generatePlaceholderCover(title, video) {
  const W = 900,
    H = 383;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d");
  // 背景：柔和的蓝灰渐变（与公众号封面常用调性一致）
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#1f2937");
  g.addColorStop(1, "#3b4a63");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  // 装饰：右下角浅色光晕
  const rg = ctx.createRadialGradient(W - 120, H - 60, 10, W - 120, H - 60, 260);
  rg.addColorStop(0, "rgba(255,255,255,0.10)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = rg;
  ctx.fillRect(0, 0, W, H);
  // 视频标签：左上角红色圆角块 + 文字
  if (video) {
    ctx.fillStyle = "#e4393c";
    const tw = 96,
      th = 38,
      tx = 40,
      ty = 36;
    roundRect(ctx, tx, ty, tw, th, 8);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = "600 22px sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText("视频", tx + 28, ty + th / 2 + 1);
  }
  // 标题：最多两行，自动换行
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 46px sans-serif";
  ctx.textBaseline = "top";
  const padding = 60;
  const maxW = W - padding * 2;
  const lines = wrapText(ctx, title || "未命名文章", maxW, 2);
  let ty = video ? 110 : 120;
  lines.forEach((ln, i) => {
    ctx.fillText(ln, padding, ty + i * 60);
  });
  // 视频：右下角大圆形播放按钮
  if (video) {
    const cx = W - 110,
      cy = H - 110,
      rad = 46;
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx - 14, cy - 22);
    ctx.lineTo(cx - 14, cy + 22);
    ctx.lineTo(cx + 22, cy);
    ctx.closePath();
    ctx.fillStyle = "#e4393c";
    ctx.fill();
  } else {
    // 普通文章：底部细分割线
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(padding, H - 56);
    ctx.lineTo(W - padding, H - 56);
    ctx.stroke();
  }
  return cv.toDataURL("image/png");
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapText(ctx, text, maxW, maxLines) {
  const chars = String(text).split("");
  const lines = [];
  let cur = "";
  for (const ch of chars) {
    if (cur && ctx.measureText(cur + ch).width > maxW) {
      lines.push(cur);
      cur = ch;
      if (lines.length === maxLines) {
        // 已到上限：把剩余字符塞进最后一行并截断
        cur = lines[maxLines - 1] + cur;
        break;
      }
    } else {
      cur += ch;
    }
  }
  if (lines.length < maxLines) lines.push(cur);
  // 最后一行若超限则截断加省略号
  let last = lines[maxLines - 1] || "";
  while (last.length > 1 && ctx.measureText(last + "…").width > maxW) last = last.slice(0, -1);
  if (last !== (lines[maxLines - 1] || "")) last += "…";
  lines[maxLines - 1] = last;
  return lines;
}

/** 工具栏「历史」按钮（AI 布局模式可见） */
function bindAiHistoryToolbar() {
  if (els.btnAiHistory)
    els.btnAiHistory.addEventListener("click", (e) => {
      e.stopPropagation();
      openAiHistory(els.btnAiHistory);
    });
}

/** AI 排版预览里的图片占位块：点一下选本地图，替换该占位符（源 HTML 同步更新，复制/保存都带图） */
const AI_IMG_PH_RE = /<p[^>]*class="ai-img-ph"[^>]*>[\s\S]*?<\/p>/g;
function bindPreviewImageInsert() {
  if (!els.preview) return;
  els.preview.addEventListener("click", (e) => {
    const ph = e.target.closest && e.target.closest(".ai-img-ph");
    if (!ph) return;
    insertImageAtPlaceholder(ph);
  });
}

async function insertImageAtPlaceholder(ph) {
  // 计算该占位符在预览中的序号，用于在源 HTML 中找到同一处替换
  const phs = [...els.preview.querySelectorAll(".ai-img-ph")];
  const idx = phs.indexOf(ph);
  let img;
  try {
    img = await pickImageFile();
  } catch (_) {
    return;
  }
  if (!img || !img.dataUri) return;
  const imgHtml =
    `<img src="${img.dataUri}" alt="${escapeAttr(img.name || "图片")}" ` +
    `style="max-width:100%;height:auto;display:block;margin:0 auto;border-radius:8px;" />`;
  // 同步更新源 HTML（复制 / 保存 HTML 都包含这张图）
  if (pubState.aiHtml != null) {
    let i = 0,
      out = "",
      last = 0,
      m;
    AI_IMG_PH_RE.lastIndex = 0;
    while ((m = AI_IMG_PH_RE.exec(pubState.aiHtml))) {
      out += pubState.aiHtml.slice(last, m.index) + (i === idx ? imgHtml : m[0]);
      last = m.index + m[0].length;
      i++;
    }
    out += pubState.aiHtml.slice(last);
    pubState.aiHtml = out;
  }
  // 直接替换 DOM 节点，无需整页重渲染
  const im = document.createElement("img");
  im.src = img.dataUri;
  im.alt = img.name || "图片";
  im.style.cssText = "max-width:100%;height:auto;display:block;margin:0 auto;border-radius:8px;";
  ph.replaceWith(im);
  setStatus("已插入图片（预览可继续点其它占位插入，复制 / 保存 HTML 已同步）");
}

/** 转义 HTML 属性里的特殊字符（用于图片 alt） */
function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 选择公众号排版模式：manual=手动（主题/组件/复制可用），ai=AI 排版（显示 AI 排版按钮） */
function selectPubMode(mode) {
  const ai = mode === "ai";
  const manual = mode === "manual";
  const none = mode === "none" || !mode;
  // 退出 AI 排版预览（如有），回到实时 Markdown 预览
  document.body.classList.toggle("ai-layout-mode", ai);
  document.body.classList.toggle("pub-mode", manual);
  const tpl = document.getElementById("btn-template");
  const comp = document.getElementById("btn-components");
  const copy = document.getElementById("btn-copy-wechat");
  if (none) {
    // 恢复原始状态：移除所有排版模式类，隐藏全部子工具，恢复全部导出
    document.body.classList.remove("ai-layout-mode", "pub-mode");
    [tpl, comp, copy].forEach((el) => { if (el) { el.classList.add("hidden"); el.disabled = true; } });
    if (els.btnAiLayout) els.btnAiLayout.classList.add("hidden");
    if (els.btnAiView) els.btnAiView.classList.add("hidden");
    els.btnPublish.classList.remove("active");
    els.btnPublish.title = "公众号排版：选择手动排版或 AI 排版";
    state.publishMode = false;
    refreshExportMenu();
    renderPreview();
    setStatus("已恢复原始状态：公众号排版模式已关闭");
    return;
  }
  els.btnPublish.classList.add("active"); // 触发器高亮表示已选定模式
  // AI 模式下隐藏手动子工具（主题/组件/复制到公众号），只留「AI 排版」按钮
  [tpl, comp, copy].forEach((el) => { if (el) el.classList.toggle("hidden", ai); });
  if (ai) {
    setPublishMode(false); // 关闭手动子工具
    if (els.btnAiLayout) els.btnAiLayout.classList.remove("hidden");
    setStatus("已选择 AI 排版：点击「AI 排版」生成公众号样式");
  } else {
    setPublishMode(true); // 开启手动模式，子工具可用
    if (els.btnAiLayout) els.btnAiLayout.classList.add("hidden");
    setStatus("已进入手动排版：主题与组件可用，导出仅限长图 / HTML");
  }
  refreshAiViewBtn();
}

/** 进入 / 退出手动公众号排版模式（子工具：主题 / 组件 / 复制到公众号） */
function setPublishMode(on) {
  state.publishMode = on;
  document.body.classList.toggle("pub-mode", on && !document.body.classList.contains("ai-layout-mode"));
  els.btnPublish.classList.toggle("active", on);
  els.btnPublish.title = on ? "退出手动排版（恢复全部导出）" : "公众号排版：选择手动排版或 AI 排版";
  // 主题 / 组件 / 复制到公众号 是「手动排版」的子工具：模式关闭时禁用，开启后可用
  const subDisabled = !on;
  const tpl = document.getElementById("btn-template");
  const comp = document.getElementById("btn-components");
  const copy = document.getElementById("btn-copy-wechat");
  if (tpl) tpl.disabled = subDisabled;
  if (comp) comp.disabled = subDisabled;
  if (copy) copy.disabled = subDisabled;
  refreshExportMenu();
  setStatus(on ? "已进入手动排版：主题与组件可用，导出仅限长图 / HTML" : "已退出手动排版，恢复全部导出格式");
}

/**
 * 当前文档是否「含组件或已套主题」——满足任一则导出只能长图 / HTML。
 * 组件判定：正文含 tmpl-keep 标记（组件骨架）；主题判定：当前文档带了主题。
 */
function docHasComponentOrTheme() {
  return false;
}

/** 按模式刷新导出菜单：限制时仅保留「长图(png) / HTML(html)」两项 */
function refreshExportMenu() {
  if (!els.exportMenu) return;
  const restrict = state.publishMode || docHasComponentOrTheme();
  els.exportMenu.querySelectorAll("button[data-export]").forEach((b) => {
    const k = b.dataset.export;
    const allowed = !restrict || k === "png" || k === "html";
    b.classList.toggle("hidden", !allowed);
  });
}

async function doPublish(kind) {
  // 复制类一律先开预览：粘到后台才发现样式跑偏的返工成本太高
}

/* ---------------- 发布预览弹窗 ---------------- */

// 当前预览的平台与编译结果，切页签/切宽度时复用，避免重复编译
const pubState = {
  platform: "wechat",
  width: 375,
  result: null,
  aiHtml: null,
  showOriginal: false,
  aiEditable: true, // AI 排版结果默认可直接在预览里改文字
};

/** 重新编译当前平台内容并刷新 iframe / 源码框 */
function renderPublishPreview() {
  const isAi = pubState.platform === "ai" && pubState.aiHtml != null;
  // 复制用的结果始终是 AI 排版 HTML（即便切到「原文」视图，交付物不变）
  if (isAi) {
    pubState.result = {
      kind: "html",
      html: pubState.aiHtml,
      inner: pubState.aiHtml,
      platform: PLATFORMS.wechat,
    };
  } else {
  }

  // iframe 展示内容：AI 模式且切到「原文」时，用现有 wechat 管线渲染原 md 作对比
  let doc;
  if (isAi && pubState.showOriginal) {
    doc = orig.html;
  } else if (pubState.result.kind === "markdown") {
    doc = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:12px;background:#fff;">${pubState.result.inner}</body></html>`;
  } else {
    doc = pubState.result.html;
  }
  els.pubFrame.srcdoc = doc;
  fitPublishFrame();
  els.pubSrc.value = doc; // 源码框显示当前所见
  els.pubHint.textContent = pubState.result.platform.hint || "";
  els.pubCopy.textContent = "复制到" + pubState.result.platform.name;

  // Markdown 平台没有「宽度」概念，隐藏宽度切换避免误导
  els.pubWidths.style.visibility = pubState.result.kind === "markdown" ? "hidden" : "";
  // 「AI 排版 / 原文」切换仅 AI 模式可见
  if (els.pubAiToggle) els.pubAiToggle.classList.toggle("hidden", !isAi);
  // 「保存 HTML」按钮仅 AI 模式可见
  if (els.pubSave) els.pubSave.classList.toggle("hidden", !isAi);
}

/**
 * 让 iframe 长到内容真实高度，长文由外层 .pub-stage 统一滚动。
 * srcdoc 是异步解析的，所以挂 onload；图片（base64/远程）会在之后继续改变高度，
 * 因此 load 后再补测一次。
 */
function fitPublishFrame() {
  const frame = els.pubFrame;
  const measure = () => {
    try {
      const d = frame.contentDocument;
      if (!d || !d.documentElement) return;
      const h = Math.max(d.documentElement.scrollHeight, d.body ? d.body.scrollHeight : 0);
      if (h > 0) frame.style.height = h + "px";
    } catch (_) {
      // 跨域理论上不会发生（srcdoc 同源），兜底不让预览崩掉
    }
  };
  frame.onload = () => {
    measure();
    setTimeout(measure, 120);
  };
}

function setPublishWidth(w) {
  pubState.width = w;
  els.pubFrame.style.width = w + "px";
  els.pubWidths.querySelectorAll(".pub-w").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.w) === w);
  });
  // 窄屏文字换行更多 → 高度会变，重测一次
  fitPublishFrame();
  if (els.pubFrame.contentDocument) els.pubFrame.onload();
}


function closePublishModal() {
  els.pubModal.classList.add("hidden");
  els.pubFrame.srcdoc = "";
  pubState.result = null;
}

function bindPublishModal() {
  if (!els.pubModal) return;
  els.pubClose.addEventListener("click", closePublishModal);
  els.pubModal.addEventListener("click", (e) => {
    if (e.target === els.pubModal) closePublishModal();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.pubModal.classList.contains("hidden")) closePublishModal();
  });

  els.pubTabs.querySelectorAll(".pub-tab").forEach((b) => {
    b.addEventListener("click", () => {
      pubState.platform = b.dataset.platform;
      els.pubTabs.querySelectorAll(".pub-tab").forEach((x) => x.classList.toggle("active", x === b));
      renderPublishPreview();
    });
  });
  els.pubWidths.querySelectorAll(".pub-w").forEach((b) => {
    b.addEventListener("click", () => setPublishWidth(Number(b.dataset.w)));
  });
  els.pubSrcToggle.addEventListener("change", () => {
    const src = els.pubSrcToggle.checked;
    els.pubSrc.classList.toggle("hidden", !src);
    els.pubFrame.classList.toggle("hidden", src);
  });

  // AI 排版 / 原文 切换：仅改变预览与源码框所见，复制交付物始终是 AI HTML
  if (els.pubAiToggle)
    els.pubAiToggle.querySelectorAll(".pub-av").forEach((b) => {
      b.addEventListener("click", () => {
        pubState.showOriginal = b.dataset.aiView === "original";
        els.pubAiToggle.querySelectorAll(".pub-av").forEach((x) => x.classList.toggle("active", x === b));
        renderPublishPreview();
      });
    });

  els.pubCopy.addEventListener("click", async () => {
    if (!pubState.result) return;
    const ok = await copyPlatformResult(pubState.result);
    if (ok) {
      showToast("✅ 已复制成功，去公众号后台 Ctrl+V 粘贴");
      setStatus(pubState.result.platform.hint);
      closePublishModal();
    } else {
      setStatus("复制失败，请重试");
    }
  });
  els.pubCopySrc.addEventListener("click", async () => {
    if (!pubState.result) return;
    const ok = await copyPlainToClipboard(els.pubSrc.value); // 复制当前预览所见源码
    setStatus(ok ? "已复制当前预览源码到剪贴板" : "复制失败，请重试");
  });

  // AI 排版 HTML 保存到本地（仅 AI 模式可见）
  if (els.pubSave)
    els.pubSave.addEventListener("click", async () => {
      if (!pubState.aiHtml) return;
      const f = activeFile();
      const base = (f && f.name ? f.name.replace(/\.md$/i, "") : "ai-layout") + "-排版";
      const p = await window.api.choosePath(base, "html");
      if (!p) return; // 用户取消
      const ok = await window.api.writeTextFile(p, pubState.aiHtml);
      setStatus(ok ? "已保存 AI 排版 HTML 到本地" : "保存失败，请重试");
    });

  // 右上角缩放手柄：钉住右上角拖拽放大/缩小
  bindPublishResize(els.pubModal.querySelector(".pub-card"));
}

/** 发布预览弹窗右上角手柄拖拽缩放：钉住右上角，向右拖变宽、向上拖变高 */
function bindPublishResize(card) {
  if (!card) return;
  const grip = document.getElementById("pub-resize");
  if (!grip) return;
  const MIN_W = 360, MIN_H = 280;
  let sx = 0, sy = 0, sw = 0, sh = 0, dragging = false;
  const onMove = (e) => {
    if (!dragging) return;
    const dw = e.clientX - sx;        // 向右拖 → 变宽（右上角固定，左边缘左移）
    const dh = sy - e.clientY;        // 向上拖 → 变高（右上角固定，底边缘下移）
    const nw = Math.max(MIN_W, Math.min(window.innerWidth - 20, sw + dw));
    const nh = Math.max(MIN_H, Math.min(window.innerHeight - 20, sh + dh));
    card.style.width = nw + "px";
    card.style.height = nh + "px";
  };
  const onUp = () => {
    dragging = false;
    document.body.style.cursor = "";
    if (els.pubFrame) els.pubFrame.style.pointerEvents = "";
    if (els.pubSrc) els.pubSrc.style.pointerEvents = "";
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
  grip.addEventListener("mousedown", (e) => {
    e.preventDefault();
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    sw = card.offsetWidth; sh = card.offsetHeight;
    // 钉住右上角：改用 fixed + right/top，使缩放时右上角不随鼠标漂移
    const rect = card.getBoundingClientRect();
    card.style.position = "fixed";
    card.style.margin = "0";
    card.style.left = "auto";
    card.style.right = window.innerWidth - rect.right + "px";
    card.style.top = rect.top + "px";
    document.body.style.cursor = "nesw-resize";
    // 拖拽时让 iframe/源码框不抢鼠标事件（否则移到预览内容上拖动会失效）
    if (els.pubFrame) els.pubFrame.style.pointerEvents = "none";
    if (els.pubSrc) els.pubSrc.style.pointerEvents = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  });
}

async function doExport(type) {
  const f = activeFile();
  if (!f) return;
  const base = (f.name || "document").replace(/\.[^.]+$/, "");
  hideExportTip(); // 每次导出先收起旧提示；wechat 若有问题会重新弹出
  try {
    if (type === "md") {
      await exportMarkdown();
    } else if (type === "html") {
      const html = await buildExportHtml(currentMarkdown(), base);
      const path = await window.api.saveFile(base + ".html", html, "html");
      setStatus(path ? "已导出 " + path : "已取消导出");
    } else if (type === "pdf") {
      setStatus("正在生成 PDF…");
      const html = await buildExportHtml(currentMarkdown(), base);
      const path = await window.api.exportPdf(html, base + ".pdf");
      setStatus(path ? "已导出 " + path : "已取消 PDF 导出");
    } else if (type === "png") {
      // PNG 长图（L3）：主进程用隐藏窗口整页截图，宽度取当前预览区宽度，
      // 这样导出的长图与用户屏幕上看到的排版一致。
      // 长图是给公众号/朋友圈直接用的成品图，必须跟随当前主题（区别于 .html/.pdf 的中性风）
      setStatus("正在生成长图…");
      const html = await buildExportHtml(currentMarkdown(), base, getActiveTheme());
      const width = Math.round(els.preview?.clientWidth || 900);
      const path = await window.api.exportPng(html, base + ".png", width, 2);
      setStatus(path ? "已导出 " + path : "已取消长图导出");
    } else if (type === "docx") {
      // DOCX（L3）：渲染进程生成 OOXML 部件，主进程打包成 zip
      setStatus("正在生成 Word 文档…");
      const entries = buildDocxEntries(currentMarkdown(), base, getActiveTheme());
      const path = await window.api.exportZip(base + ".docx", "docx", entries);
      setStatus(path ? "已导出 " + path : "已取消 Word 导出");
    } else if (type === "epub") {
      // EPUB（L3）：按 h1 自动切章，生成带目录的电子书
      setStatus("正在生成电子书…");
      const entries = buildEpubEntries(currentMarkdown(), base);
      const path = await window.api.exportZip(base + ".epub", "epub", entries);
      setStatus(path ? "已导出 " + path : "已取消电子书导出");
    }
  } catch (err) {
    console.error("[export]", err);
    setStatus("导出失败：" + (err?.message || err));
  }
}

/* ============================================================
   查找 / 替换（L1）
   ------------------------------------------------------------
   之前"下一个"点了没反应的两个原因：
   1) 富文本模式直接 return，压根不定位；
   2) 源码模式用 行号 × lineHeight 估算 scrollTop，长行折行后完全对不上，
      而且 textarea 没拿到焦点，原生选区是灰的，看着像"没高亮"。

   现在的做法：
   - 一次性扫出全部匹配（带缓存，文档没变就不重扫），支持 上一个/下一个 与 n/N 计数；
   - 源码模式：textarea 真实选区 + 用画布测量字宽估算折行，精确滚到匹配处并居中；
   - 富文本模式：TreeWalker 建立"纯文本 ↔ 文本节点"映射，用 Range 选中并滚动；
   - 每次替换前压栈快照，"撤销替换"可回退。
   ============================================================ */

let docVersion = 0; // 文档每次变更 +1，用于失效各类缓存
const findState = {
  key: "",
  matches: [], // [[start,end], ...] 相对"被搜索文本"的下标
  index: -1,
  previewIndex: -1, // 预览自身的匹配序号（与编辑器独立计数，见 scrollPreviewToMatch）
  undo: [], // [{ md, label }]
};

function resetFind() {
  findState.key = "";
  findState.matches = [];
  findState.index = -1;
  findState.previewIndex = -1;
  richIndex.version = -1;
  rowCache.version = -1;
  if (els.preview) clearPreviewFindHighlight(); // 关掉查找时清掉预览高亮
  updateFindStatus("");
}

function updateFindStatus(text) {
  if (els.findStatus) els.findStatus.textContent = text;
}

function clearFindUndo() {
  findState.undo.length = 0;
  if (els.findUndo) {
    els.findUndo.disabled = true;
    els.findUndo.title = "撤销上一次替换 / 全部替换";
  }
}

/* 焦点管理：定位匹配需要动编辑区的选区，但如果焦点也跟着跳进编辑区，
   用户在搜索框里连按回车就会往正文里插换行。所以先记住查找面板里的焦点，
   操作完再还原；只有从编辑区触发（F3）时才把焦点留在编辑区。 */
let findFocusEl = null;
function rememberFindFocus() {
  const a = document.activeElement;
  findFocusEl = a && els.findPanel.contains(a) ? a : null;
}
function restoreFindFocus() {
  if (!findFocusEl) return;
  const target = findFocusEl;
  setTimeout(() => target.focus(), 0);
}

function buildFindRegex(global) {
  const q = els.findInput.value;
  if (!q) return null;
  const flags = (els.findCase.checked ? "" : "i") + (global ? "g" : "");
  if (els.findRegex.checked) {
    try {
      return new RegExp(q, flags);
    } catch (_) {
      updateFindStatus("正则表达式有误");
      return null;
    }
  }
  let src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (els.findWord.checked) src = "\\b" + src + "\\b";
  return new RegExp(src, flags);
}

/* ---------- 富文本：纯文本 ↔ 文本节点 映射 ---------- */
const richIndex = { version: -1, text: "", nodes: [] };

function buildRichIndex() {
  if (richIndex.version === docVersion) return richIndex;
  const walker = document.createTreeWalker(els.rich, NodeFilter.SHOW_TEXT);
  const nodes = [];
  let text = "";
  let lastBlock = null;
  let n;
  while ((n = walker.nextNode())) {
    const v = n.nodeValue || "";
    if (!v) continue;
    const block = n.parentElement
      ? n.parentElement.closest("p,li,h1,h2,h3,h4,h5,h6,blockquote,pre,td,th,div")
      : null;
    // 跨块之间补一个换行，避免上一段结尾和下一段开头被拼成一个词
    if (lastBlock && block !== lastBlock) text += "\n";
    lastBlock = block;
    nodes.push({ node: n, start: text.length, len: v.length });
    text += v;
  }
  richIndex.version = docVersion;
  richIndex.text = text;
  richIndex.nodes = nodes;
  return richIndex;
}

function locateNode(nodes, offset) {
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const e = nodes[mid];
    if (offset < e.start) hi = mid - 1;
    else if (offset > e.start + e.len) lo = mid + 1;
    else return e;
  }
  return nodes[Math.min(nodes.length - 1, Math.max(0, lo))] || null;
}

function selectInRich(start, end) {
  const { nodes } = buildRichIndex();
  if (!nodes.length) return;
  const a = locateNode(nodes, start);
  const b = locateNode(nodes, end);
  if (!a || !b) return;
  const range = document.createRange();
  try {
    range.setStart(a.node, Math.max(0, Math.min(a.len, start - a.start)));
    range.setEnd(b.node, Math.max(0, Math.min(b.len, end - b.start)));
  } catch (_) {
    return;
  }
  if (!findFocusEl) els.rich.focus();
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  // 滚到视口中间
  const r = range.getBoundingClientRect();
  const host = els.rich.getBoundingClientRect();
  if (r.height || r.width) {
    els.rich.scrollTop += r.top - host.top - els.rich.clientHeight / 2 + r.height / 2;
  }
}

/* ---------- 源码：把 textarea 精确滚到某个字符位置 ---------- */
let taMetrics = null;
function textareaMetrics(ta) {
  const cs = getComputedStyle(ta);
  const key = cs.font + "|" + ta.clientWidth;
  if (taMetrics && taMetrics.key === key) return taMetrics;
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = cs.font;
  const wAscii = ctx.measureText("MMMMMMMMMM").width / 10 || 8;
  const wCjk = ctx.measureText("中中中中中中中中中中").width / 10 || 14;
  const padL = parseFloat(cs.paddingLeft) || 0;
  const padR = parseFloat(cs.paddingRight) || 0;
  const padT = parseFloat(cs.paddingTop) || 0;
  let lh = parseFloat(cs.lineHeight);
  if (!lh || Number.isNaN(lh)) lh = (parseFloat(cs.fontSize) || 14) * 1.7;
  taMetrics = {
    key,
    wAscii,
    wCjk,
    lh,
    padT,
    contentW: Math.max(60, ta.clientWidth - padL - padR),
  };
  return taMetrics;
}

// 顺序查找时 index 单调递增，缓存上次扫描进度，避免每次都从头遍历千万级文本
const rowCache = { version: -1, key: "", index: 0, rows: 0, lineW: 0 };

function visualRowsBefore(text, index, m) {
  if (rowCache.version !== docVersion || rowCache.key !== m.key || index < rowCache.index) {
    rowCache.version = docVersion;
    rowCache.key = m.key;
    rowCache.index = 0;
    rowCache.rows = 0;
    rowCache.lineW = 0;
  }
  let i = rowCache.index;
  let rows = rowCache.rows;
  let lineW = rowCache.lineW;
  const limit = Math.min(index, text.length);
  for (; i < limit; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      rows += Math.max(1, Math.ceil(lineW / m.contentW));
      lineW = 0;
    } else {
      lineW += c > 0x2e7f ? m.wCjk : m.wAscii;
    }
  }
  rowCache.index = i;
  rowCache.rows = rows;
  rowCache.lineW = lineW;
  return rows + Math.floor(lineW / m.contentW);
}

function selectInSource(start, end) {
  const ta = els.source;
  // 焦点在查找框时不抢焦点：setSelectionRange 对未聚焦的 textarea 同样生效，
  // 配合 CSS 的 ::selection 依然能看到黄色高亮
  if (!findFocusEl) ta.focus();
  ta.setSelectionRange(start, end);
  const m = textareaMetrics(ta);
  const rows = visualRowsBefore(ta.value, start, m);
  ta.scrollTop = Math.max(0, rows * m.lh + m.padT - ta.clientHeight / 2);
}

/* ---------- 预览联动：查找命中后把预览滚到对应内容 ---------- */
/**
 * 查找默认只在编辑器（隐藏的 rich/source）里选中并滚动编辑器，纯预览 / 分屏模式下
 * 用户看的是预览面板，编辑器不可见，所以点「下一个」时预览纹丝不动、像没定位。
 * 这里按匹配串在预览正文里找到对应位置并滚到视口中央，让"定位到内容"真正生效。
 */
/* 预览内查找定位：直接搜「预览渲染后的文本」（用户真正看到的内容），
 * 而不是用编辑器 markdown 的下标去猜预览位置——两者文本对不上会导致定位失效。
 * 收集预览自身的全部匹配下标，gotoMatch 命中第 N 个时，把预览滚到第 N 个。 */
let previewFindCache = { key: "", matches: [] };
function buildPreviewFindMatches() {
  const q = els.findInput.value;
  if (!q) return [];
  const key =
    q + "|" + els.findRegex.checked + "|" + els.findCase.checked + "|" + els.findWord.checked +
    "|" + docVersion; // 文档变更后缓存自动失效，避免定位到旧内容
  if (previewFindCache.key === key) return previewFindCache.matches;
  const pvText = els.preview.textContent || "";
  const flags = (els.findCase.checked ? "" : "i") + "g";
  let re;
  if (els.findRegex.checked) {
    try { re = new RegExp(q, flags); } catch { previewFindCache = { key, matches: [] }; return []; }
  } else {
    let src = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (els.findWord.checked) src = "\\b" + src + "\\b";
    re = new RegExp(src, flags);
  }
  const matches = [];
  let m, g = 0;
  while ((m = re.exec(pvText)) !== null) {
    matches.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
    if (++g >= 100000) break;
  }
  previewFindCache = { key, matches };
  return matches;
}

/* ---------- 预览查找高亮 ---------- */
function clearPreviewFindHighlight() {
  els.preview.querySelectorAll("mark.find-hl").forEach((m) => {
    const parent = m.parentNode;
    if (parent) parent.replaceChild(document.createTextNode(m.textContent), m);
  });
}

/** 高亮预览里「第 pidx 个」匹配（与编辑器独立计数）。
 *  用 <mark> 包裹匹配文本片段；mark 不增加文本长度，故不会扰动匹配坐标。 */
function highlightPreviewMatch(pidx) {
  if (state.mode === "source") return;
  if (els.preview.classList.contains("hidden")) return;
  clearPreviewFindHighlight();
  const matches = buildPreviewFindMatches();
  if (!matches.length) return;
  if (pidx == null) pidx = findState.previewIndex;
  if (pidx < 0 || pidx >= matches.length) pidx = 0;
  const [s, e] = matches[pidx];
  // 收集匹配范围内的文本节点片段（一个匹配可能跨多个文本节点）
  const walker = document.createTreeWalker(els.preview, NodeFilter.SHOW_TEXT);
  const parts = [];
  let node, pos = 0;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    const a = Math.max(s, pos);
    const b = Math.min(e, pos + len);
    if (a < b) parts.push({ node, start: a - pos, end: b - pos });
    pos += len;
  }
  // 从后往前替换，避免前面的替换使后面的偏移失效
  for (let i = parts.length - 1; i >= 0; i--) {
    const { node, start, end } = parts[i];
    const full = node.nodeValue;
    const before = full.slice(0, start);
    const mid = full.slice(start, end);
    const after = full.slice(end);
    const parent = node.parentNode;
    if (!parent) continue;
    const frag = document.createDocumentFragment();
    if (before) frag.appendChild(document.createTextNode(before));
    const mark = document.createElement("mark");
    mark.className = "find-hl";
    mark.textContent = mid;
    frag.appendChild(mark);
    if (after) frag.appendChild(document.createTextNode(after));
    parent.replaceChild(frag, node);
  }
}

function scrollPreviewToMatch(pidx) {
  if (state.mode === "source") return; // 源码模式没有预览
  if (els.preview.classList.contains("hidden")) return; // 预览不可见则无需定位
  const matches = buildPreviewFindMatches();
  if (!matches.length) return;
  // 用「预览自己的」匹配序号，而不是编辑器的 findState.index：
  // 编辑器文本含 Markdown 语法、预览是渲染后的文本，两者匹配数量/顺序并不一致，
  // 拿编辑器序号去索引预览数组会错位甚至越界（表现为"点下一个预览纹丝不动"）。
  if (pidx == null) pidx = findState.previewIndex;
  if (pidx < 0 || pidx >= matches.length) pidx = 0;
  const [s, e] = matches[pidx];
  // 在预览文本节点里定位 [s,e]，构造 Range
  const walker = document.createTreeWalker(els.preview, NodeFilter.SHOW_TEXT);
  let node, pos = 0, startNode = null, startOff = 0, endNode = null, endOff = 0;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (startNode === null && pos + len > s) { startNode = node; startOff = s - pos; }
    if (pos + len >= e) { endNode = node; endOff = e - pos; break; }
    pos += len;
  }
  if (!startNode || !endNode) return;
  const range = document.createRange();
  try {
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    // 手动滚动 #preview：比 range.scrollIntoView 更可控，避免被外层容器"吞掉"滚动，
    // 把匹配行滚到预览视口中央。
    const rect = range.getBoundingClientRect();
    const prect = els.preview.getBoundingClientRect();
    const delta = (rect.top - prect.top) - prect.height / 2 + rect.height / 2;
    els.preview.scrollTop += delta;
  } catch (_) { /* 忽略个别极端节点的定位失败 */ }
  highlightPreviewMatch(pidx); // 高亮当前匹配（修 #预览查找无高亮）
}

/* ---------- 匹配收集 ---------- */
function searchText() {
  return state.editorType === "source" ? els.source.value : buildRichIndex().text;
}

function collectMatches() {
  const key = [
    els.findInput.value,
    els.findRegex.checked,
    els.findCase.checked,
    els.findWord.checked,
    state.editorType,
    docVersion,
  ].join("\u0001");
  if (findState.key === key) return findState.matches;

  findState.key = key;
  findState.matches = [];
  findState.index = -1;

  const re = buildFindRegex(true);
  if (!re) return findState.matches;
  const text = searchText();
  let m;
  let guard = 0;
  while ((m = re.exec(text)) !== null) {
    findState.matches.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++; // 空匹配防死循环
    if (++guard >= 100000) break; // 上限保护，避免极端正则卡死
  }
  return findState.matches;
}

function gotoMatch(i, pidx) {
  const list = findState.matches;
  if (!list.length) return;
  findState.index = ((i % list.length) + list.length) % list.length;
  const [s, e] = list[findState.index];
  if (state.editorType === "source") selectInSource(s, e);
  else selectInRich(s, e);
  scrollPreviewToMatch(pidx); // 预览也定位到「它自己的」第 N 个匹配（修 #预览查找不定位）
  updateFindStatus(`第 ${findState.index + 1} / ${list.length} 个匹配`);
}

function findStep(dir) {
  rememberFindFocus();
  if (!els.findInput.value) {
    updateFindStatus("请输入要查找的内容");
    els.findInput.focus();
    return;
  }
  const list = collectMatches();
  if (!list.length) {
    updateFindStatus("无匹配");
    return;
  }
  // 编辑器匹配序号
  let idx = findState.index < 0 ? (dir > 0 ? 0 : list.length - 1) : findState.index + dir;
  idx = ((idx % list.length) + list.length) % list.length;
  // 预览匹配序号（与编辑器各自独立计数，避免文本不一致导致错位）
  const pmatches = buildPreviewFindMatches();
  if (pmatches.length) {
    let pidx = findState.previewIndex < 0
      ? (dir > 0 ? 0 : pmatches.length - 1)
      : findState.previewIndex + dir;
    findState.previewIndex = ((pidx % pmatches.length) + pmatches.length) % pmatches.length;
  } else {
    findState.previewIndex = -1;
  }
  gotoMatch(idx, findState.previewIndex);
  restoreFindFocus();
}

const findNext = () => findStep(1);
const findPrev = () => findStep(-1);

/* ---------- 替换 ---------- */
function pushUndo(label) {
  const md = editor.getValue();
  // 超大文档一份快照就上百 MB，只留最近一次；普通文档留 10 步
  const cap = md.length > 2_000_000 ? 1 : 10;
  findState.undo.push({ md, label });
  while (findState.undo.length > cap) findState.undo.shift();
  els.findUndo.disabled = false;
  els.findUndo.title = `撤销：${label}`;
}

function findReplace() {
  rememberFindFocus();
  const list = collectMatches();
  if (!list.length) {
    updateFindStatus("无匹配");
    return;
  }
  if (findState.index < 0) {
    findNext(); // 还没定位过，先跳到第一个，让用户看清将要替换什么
    return;
  }
  const [s, e] = list[findState.index];
  const rep = els.replaceInput.value;
  pushUndo("替换 1 处");

  if (state.editorType === "source") {
    // 就地替换，保留原生撤销栈，大文档也不用整篇重设
    editor.replaceRangeAt(s, e, rep);
  } else {
    // 富文本的匹配下标基于渲染文本，无法直接映射回 markdown，
    // 这里改用 Range 就地替换 DOM，再让编辑器回读 markdown
    const { nodes } = buildRichIndex();
    const a = locateNode(nodes, s);
    const b = locateNode(nodes, e);
    if (!a || !b) return;
    const range = document.createRange();
    range.setStart(a.node, Math.max(0, s - a.start));
    range.setEnd(b.node, Math.max(0, Math.min(b.len, e - b.start)));
    range.deleteContents();
    if (rep) range.insertNode(document.createTextNode(rep));
    els.rich.dispatchEvent(new Event("input", { bubbles: true }));
  }

  docVersion++;
  findState.key = ""; // 强制重扫
  const nextIdx = findState.index;
  const list2 = collectMatches();
  updateFindStatus(`已替换 1 处，剩余 ${list2.length} 个匹配`);
  if (list2.length) {
    findState.index = Math.min(nextIdx, list2.length - 1) - 1;
    findNext();
  }
  restoreFindFocus();
}

function findReplaceAll() {
  const re = buildFindRegex(true);
  if (!re) {
    updateFindStatus("请输入要查找的内容");
    return;
  }
  const md = editor.getValue();
  const count = (md.match(re) || []).length;
  if (!count) {
    updateFindStatus("无匹配");
    return;
  }
  pushUndo(`全部替换 ${count} 处`);
  const rep = els.replaceInput.value;
  const newMd = md.replace(re, rep);
  editor.setValue(newMd);
  onEditorChange(newMd);
  resetFind();
  updateFindStatus(`已替换 ${count} 处（可点「撤销替换」还原）`);
}

function findUndo() {
  const snap = findState.undo.pop();
  if (!snap) {
    updateFindStatus("没有可撤销的替换");
    els.findUndo.disabled = true;
    return;
  }
  editor.setValue(snap.md);
  onEditorChange(snap.md);
  resetFind();
  els.findUndo.disabled = findState.undo.length === 0;
  els.findUndo.title = findState.undo.length
    ? `撤销：${findState.undo[findState.undo.length - 1].label}`
    : "撤销上一次替换 / 全部替换";
  updateFindStatus(`已撤销：${snap.label}`);
}

function openFind(open) {
  els.findPanel.classList.toggle("hidden", !open);
  if (open) {
    els.findInput.focus();
    els.findInput.select();
  }
}

/* ---------- 富文本编辑区：悬停显示段落格式（如「一级标题」「引用」） ---------- */
function bindBlockFormatHint() {
  const tip = document.getElementById("block-format-tip");
  if (!tip) return;
  const root = els.rich;

  // 从悬停节点向上找「最大的语义块」：容器（引用/列表/代码块…）优先于内部的正文/列表项。
  function classify(el) {
    let n = el;
    let fallback = null;
    while (n && n !== root && n.nodeType === 1) {
      const tn = n.tagName;
      if (/^H([1-6])$/.test(tn))
        return { name: ["", "一级标题", "二级标题", "三级标题", "四级标题", "五级标题", "六级标题"][+tn[1]], tag: tn };
      if (tn === "BLOCKQUOTE") return { name: "引用", tag: "BLOCKQUOTE" };
      if (tn === "UL" || tn === "OL") return { name: "列表", tag: "UL" };
      if (tn === "PRE") return { name: "代码块", tag: "PRE" };
      if (tn === "HR") return { name: "分割线", tag: "HR" };
      if (tn === "IMG") return { name: "图片", tag: "IMG" };
      if (tn === "TABLE") return { name: "表格", tag: "TABLE" };
      if (tn === "P" && !fallback) fallback = { name: "正文", tag: "P" };
      if (tn === "LI" && !fallback) fallback = { name: "列表项", tag: "LI" };
      n = n.parentNode;
    }
    return fallback;
  }

  function show(info, x, y) {
    tip.textContent = info.name;
    tip.classList.remove("hidden", "bf-heading", "bf-quote");
    if (info.tag === "BLOCKQUOTE") tip.classList.add("bf-quote");
    else if (/^H[1-6]$/.test(info.tag)) tip.classList.add("bf-heading");
    // 跟随光标，贴右边界时翻到光标左侧，避免出屏
    const w = tip.offsetWidth || 80;
    let left = x + 14;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    tip.style.left = left + "px";
    tip.style.top = y + 16 + "px";
  }
  function hide() {
    tip.classList.add("hidden");
  }

  root.addEventListener("mousemove", (e) => {
    if (state.editorType !== "richtext") {
      hide();
      return;
    }
    let el = e.target;
    if (el && el.nodeType === 3) el = el.parentNode; // 文本节点→取父元素
    if (!el || el === root) {
      hide();
      return;
    }
    const info = classify(el);
    if (!info) hide();
    else show(info, e.clientX, e.clientY);
  });
  root.addEventListener("mouseleave", hide);
}

function bindFind() {
  // 查找/替换入口：Ctrl+F（快捷键）与右键菜单；工具栏不再放按钮
  els.findClose.addEventListener("click", () => openFind(false));
  els.findPrev.addEventListener("click", findPrev);
  els.findNext.addEventListener("click", findNext);
  els.findReplace.addEventListener("click", findReplace);
  els.findReplaceAll.addEventListener("click", findReplaceAll);
  els.findUndo.addEventListener("click", findUndo);

  // 改查询词或选项时，重置定位，从头开始找
  ["input", "change"].forEach((ev) => {
    els.findInput.addEventListener(ev, () => {
      findState.index = -1;
      findState.previewIndex = -1;
      previewFindCache.key = ""; // 预览匹配缓存随之失效，下次重新收集
    });
  });
  [els.findRegex, els.findCase, els.findWord].forEach((c) =>
    c.addEventListener("change", () => {
      findState.index = -1;
      findState.previewIndex = -1;
      previewFindCache.key = "";
    })
  );

  els.findInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.shiftKey ? findPrev() : findNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      openFind(false);
    }
  });

  // 全局快捷键：动作分发（组合键来自设置面板，可自定义）。
  // 编辑器内部的加粗/斜体等已由各自 keydown 处理并 stopPropagation；
  // 这里只负责全局动作：保存/撤销/重做/查找/新建/标题/粘贴纯文本。
  document.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // 中文组词期不分发快捷键：避免与输入法抢主线程（修 #中文组词卡顿）
    const action = actionForEvent(e);
    // 焦点在「可编辑的 AI 排版预览」里：撤销/重做交给浏览器原生处理。
    // 否则会去撤销左侧编辑器并退出 AI 预览，用户刚在预览里改的字就看不见了。
    if (
      (action === "undo" || action === "redo") &&
      els.preview &&
      els.preview.isContentEditable &&
      (document.activeElement === els.preview || els.preview.contains(document.activeElement))
    ) {
      return;
    }
    if (action) {
      switch (action) {
        case "save":
          e.preventDefault();
          saveCurrentFile();
          return;
        case "undo":
          e.preventDefault();
          undoHistory();
          return;
        case "redo":
          e.preventDefault();
          redoHistory();
          return;
        case "find":
          e.preventDefault();
          openFind(true);
          return;
        case "newDoc":
          e.preventDefault();
          newDoc();
          return;
        case "paragraph":
        case "heading1":
        case "heading2":
        case "heading3":
        case "heading4":
        case "heading5":
        case "heading6":
          e.preventDefault();
          editor.setHeading(action === "paragraph" ? 0 : Number(action.slice(-1)));
          return;
        case "pastePlain":
          e.preventDefault();
          window.api.clipboardReadText().then((t) => {
            if (t) editor.insertText(t);
          });
          return;
      }
    }
    // 查找面板内的导航：F3 / Ctrl+G / Esc（不参与自定义，保持稳定）
    if (els.findPanel.classList.contains("hidden")) return;
    if (e.key === "F3" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "g")) {
      e.preventDefault();
      e.shiftKey ? findPrev() : findNext();
    } else if (e.key === "Escape") {
      e.preventDefault();
      openFind(false);
    }
  });
}

/* ---------- 专注模式增强：富文本淡化非当前段落 + 源码居中 ---------- */
function bindFocusDim() {
  const rich = els.rich;
  const update = (e) => {
    if (e && e.isComposing) return; // 中文组词期不重算聚焦段落，避免与输入法抢主线程
    if (!document.body.classList.contains("focus-mode")) return;
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return;
    const node = sel.anchorNode;
    const p =
      node && node.nodeType === 3
        ? node.parentElement.closest("p,li,blockquote,h1,h2,h3,h4,h5,h6,pre")
        : null;
    rich.querySelectorAll(".focus-active").forEach((el) => el.classList.remove("focus-active"));
    if (p) p.classList.add("focus-active");
  };
  rich.addEventListener("keyup", update);
  rich.addEventListener("click", update);
  rich.addEventListener("focus", update);
}

function clearAll() {
  // 清掉所有文档的草稿，否则新建的同名空白文档会把旧内容又恢复回来
  state.files.forEach((f) => clearDraft(f.name));
  state.files = [];
  state.activeId = null;
  renderList();
  // 清空后回到一篇干净的空白文档，而不是退回「必须先上传」的空状态
  newDoc(BLANK_DOC_NAME, "", { silent: true });
  setStatus("已清空，可以直接开始写");
}

/** 删除单个文档（左侧栏每项的 ✕ 按钮）。删除当前文档时切到相邻文档，列表空了则新建空白页 */
function deleteFile(id) {
  const idx = state.files.findIndex((f) => f.id === id);
  if (idx < 0) return;
  const f = state.files[idx];
  clearDraft(f.name);
  state.files.splice(idx, 1);
  if (state.activeId === id) {
    const next = state.files[idx] || state.files[idx - 1] || null;
    state.activeId = null;
    if (next) selectFile(next.id);
    else newDoc(BLANK_DOC_NAME, "", { silent: true });
  }
  renderList();
  setStatus(`已删除 ${f.name}`);
  // #7：删除文档后防抖备份会话
  scheduleSessionSave();
}

/* ---------- 主题 / 专注 ---------- */
function toggleFocus() {
  const on = document.body.classList.toggle("focus-mode");
  els.btnFocus.classList.toggle("active", on);
  setStatus(on ? "专注模式：已隐藏工具栏" : "已退出专注模式");
}

/* ---------- 自动保存（崩溃恢复） ---------- */
function draftKey(name) {
  return "draft::" + name;
}
function saveDraft(name, md) {
  try {
    localStorage.setItem(draftKey(name), md);
  } catch (_) {}
}
function loadDraft(name) {
  try {
    const v = localStorage.getItem(draftKey(name));
    return v == null ? null : v;
  } catch (_) {
    return null;
  }
}
function clearDraft(name) {
  try {
    localStorage.removeItem(draftKey(name));
  } catch (_) {}
}

/* ---------- 分隔条 ---------- */
function initResizer() {
  const r = els.resizer;
  let dragging = false;
  r.addEventListener("mousedown", (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = "col-resize";
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = els.panes.getBoundingClientRect();
    let ratio = (e.clientX - rect.left) / rect.width;
    ratio = Math.min(0.8, Math.max(0.2, ratio));
    els.panes.style.setProperty("--split", ratio);
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.cursor = "";
  });
}

/* ---------- 工具 ---------- */
function showOverlay(text) {
  els.overlayText.textContent = text;
  els.overlay.classList.remove("hidden");
}
function hideOverlay() {
  els.overlay.classList.add("hidden");
}
function setStatus(text) {
  els.status.textContent = text;
}

/** 底部状态栏：实时显示当前文档字数（编辑 / 切文件 / 撤销重做都会刷新） */
function updateCharCount() {
  const el = els.charCount;
  if (!el) return;
  const len = (currentMarkdown() || "").length;
  el.textContent = `${len} 字`;
  // 接近/超过 AI 排版上限（6000 字）时高亮，给用户一个直观预警
  el.classList.toggle("over", len > 6000);
}

/* ---------- AI 排版主题选择弹窗 ---------- */
/** 读取主题弹窗里的「插入图片占位块」开关，传给 AI 排版（默认开启） */
function openAiThemeModal() {
  const modal = document.getElementById("ai-theme-modal");
  const grid = document.getElementById("ai-theme-grid");
  if (!modal || !grid) return;
  grid.innerHTML = "";
  // 分组展示：core = skill 原生主题；ported = 新增主题
  const GROUPS = [
    { key: "core", label: "原生主题" },
    { key: "ported", label: "新增主题" },
  ];
  GROUPS.forEach(({ key, label }) => {
    const items = DESIGN_LANGUAGES.filter((t) => (t.group || "core") === key);
    if (!items.length) return;
    const head = document.createElement("div");
    head.className = "ai-theme-group";
    head.textContent = label;
    grid.appendChild(head);
    items.forEach((t) => {
      const card = document.createElement("div");
      card.className = "ai-theme-item";
      card.dataset.id = t.id;
      card.title = t.vibe || "";
      const dot = document.createElement("span");
      dot.className = "ai-theme-dot";
      dot.style.background = t.mainColor || "#888";
      const name = document.createElement("span");
      name.className = "ai-theme-name";
      name.textContent = t.name;
      const sw = document.createElement("div");
      sw.className = "ai-theme-swatch";
      sw.appendChild(dot);
      sw.appendChild(name);
      const fit = document.createElement("div");
      fit.className = "ai-theme-fit";
      fit.textContent = t.fit || "";
      card.appendChild(sw);
      card.appendChild(fit);
      grid.appendChild(card);
    });
  });
  // 图片占位开关：默认勾选（恢复「之前都有占位」的行为）
  const phCb = document.getElementById("ai-img-ph");
  if (phCb) phCb.checked = true;
  modal.classList.remove("hidden");
}

/* ---------- 复制成功 toast（轻量浮层，自动消失） ---------- */
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast hidden";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove("hidden");
  requestAnimationFrame(() => el.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.classList.add("hidden"), 220);
  }, 2400);
}

/* ---------- 通用提示弹窗（AI 排版字数/图片拦截等） ---------- */
function showAlert(title, msg) {
  const modal = document.getElementById("alert-modal");
  const t = document.getElementById("alert-title");
  const b = document.getElementById("alert-body");
  if (!modal || !t || !b) return;
  t.textContent = title || "提示";
  b.textContent = msg || "";
  modal.classList.remove("hidden");
}
function closeAlert() {
  const modal = document.getElementById("alert-modal");
  if (modal) modal.classList.add("hidden");
}
function wireAlertModal() {
  const modal = document.getElementById("alert-modal");
  if (!modal) return;
  const ok = document.getElementById("alert-ok");
  const close = document.getElementById("alert-close");
  if (ok) ok.addEventListener("click", closeAlert);
  if (close) close.addEventListener("click", closeAlert);
  // 点击遮罩空白处关闭
  modal.addEventListener("click", (e) => { if (e.target === modal) closeAlert(); });
}

init();
