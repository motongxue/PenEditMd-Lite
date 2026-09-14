/**
 * richtext.js — 轻量富文本编辑器（从零实现，不依赖 Vditor/TipTap）
 *
 * 设计取舍：
 * - 用 contenteditable div 做编辑面，用户像 Word 一样直接打字、看图。
 * - Markdown → HTML 用 marked；HTML → Markdown 用 turndown + gfm 插件。
 * - 工具栏命令主要用 document.execCommand（浏览器原生，支持撤销/重做栈）。
 * - 不实现完整 ProseMirror 式模型，只覆盖常见排版（标题/加粗/列表/引用/链接/图片/代码/表格/任务列表）。
 * - 图片保留 base64，粘贴图片时自动转 base64 插入。
 */

import { marked } from "marked";
import DOMPurify from "dompurify";
import Turndown from "turndown";
import { gfm } from "turndown-plugin-gfm";
import hljs from "highlight.js";
import { showPrompt, showChoiceModal, openLocalImageFile } from "./prompt.js";
import { status } from "./status.js";
import { shrinkMarkdown, getImageById, registerImage, shouldInlineImages } from "./imageStore.js";
import {
  useMathExtensions,
  decorateMath,
  mathTurndownRules,
  renderKatex,
} from "./math.js";
import { useFootnoteExtensions, footnoteTurndownRules } from "./extras.js";
import { matchAction } from "./settings.js";
import { perfReset, perfStage, perfMark, perfSelf } from "./perf.js";

// 配置 marked：高亮代码块、GFM
marked.use({
  gfm: true,
  breaks: false,
  pedantic: false,
  headerIds: false,
  highlight: (code, lang) => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang }).value;
      } catch (_) {}
    }
    return hljs.highlightAuto(code).value;
  },
});

// 公式（KaTeX）：块级 $$...$$ 与行内 $...$
useMathExtensions(marked);
// 脚注（L2）：[^1] 引用 + [^1]: 定义
useFootnoteExtensions(marked);

// 配置 turndown：保留表格、任务列表、删除线等 GFM 特性
const turndown = new Turndown({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
turndown.use(gfm);

// 保留 base64 图片地址不被 turndown 转义
const originalLinkReplacement = turndown.options.linkReplacement ||
  turndown.options.defaultLinkReplacement ||
  function (href) { return href; };
turndown.addRule("keepDataUriImages", {
  filter: (node) => node.nodeName === "IMG" && node.getAttribute("src")?.startsWith("data:"),
  replacement: (content, node) => {
    const alt = node.getAttribute("alt") || "";
    const src = node.getAttribute("src") || "";
    return `![${alt}](${src})`;
  },
});

// 图片占位符（与右侧预览一致的「点击才展开」策略）：
// 折叠态是 <span class="img-ph" data-img-id>，展开态是 <img class="img-expanded" data-img-id>。
// 两者都带 data-img-id，序列化时统一还原成短占位符 ![alt](@img:id:name)，
// 绝不把 base64 写回工作副本 —— 这是大文档不卡顿的关键（getValue 每次按键都会跑）。
// 本规则后注册 ⇒ 优先级高于 keepDataUriImages，展开后的图片也不会吐出 base64。
turndown.addRule("imgPlaceholder", {
  filter: (node) =>
    (node.nodeName === "IMG" || node.nodeName === "SPAN") && node.hasAttribute?.("data-img-id"),
  replacement: (_content, node) => {
    const id = node.getAttribute("data-img-id");
    const name = node.getAttribute("data-img-name") || "image.png";
    const alt = node.getAttribute("data-img-alt") || "";
    return `![${alt}](@img:${id}:${name})`;
  },
});

// Typora 风格代码块：<pre class="cb" contenteditable=false>
//   <div class="cb-stack">
//     <pre class="cb-hl"><code>…</code></pre>     ← 高亮背板（pointer-events:none）
//     <textarea class="cb-input">…</textarea>     ← 真正接收输入（透明文字、可见光标）
//   </div>
//   <span class="cb-lang">语言</span>              ← 右下角标签，点击弹出语言选择浮层
// 关键：语言控件是一个「非编辑的标签」，只有点击它才在 body 上弹出一个搜索浮层，
// 浮层里的 <input> 属于 body（不在 contenteditable 内），绝不会抢代码区的输入焦点。
// 代码正文用 textarea 承载：换行是真实 \n，语法高亮通过背板实时同步，光标永不被语言框遮挡。
turndown.addRule("codeBlockWithLang", {
  filter: (node) => node.nodeName === "PRE" && node.classList.contains("cb"),
  replacement: (_content, node) => {
    const lang = node.getAttribute("data-lang") || "";
    const ta = node.querySelector("textarea.cb-input");
    const code = node.querySelector("code");
    const text = ta ? ta.value : code ? code.textContent : node.textContent;
    return "\n```" + lang + "\n" + text + "\n```\n";
  },
});

// 公式：块级 $$...$$ / 行内 $...$ 读 data-tex 还原
mathTurndownRules(turndown);
// 排版组件（tmpl-keep 包裹的卡片/时间轴等）：原样保留为 HTML，避免富文本→Markdown
// 往返时丢失结构（预览 marked 会重新解析这段 HTML，docx 则递归取文本，内容不丢）。
turndown.addRule("keepTmplComponents", {
  filter: (node) => node.nodeName === "DIV" && node.classList && node.classList.contains("tmpl-keep"),
  replacement: (content, node) => "\n" + node.outerHTML + "\n",
});
// 脚注：读 data-fn-id 还原成 [^id] 语法
footnoteTurndownRules(turndown);

// 代码块语言候选项（与 highlight.js 的 language id 对齐，便于直接高亮）；输入框也允许列表外的任意语言
const LANG_OPTIONS = [
  "plaintext", "text", "bash", "sh", "shell", "powershell", "python", "javascript",
  "typescript", "java", "c", "cpp", "csharp", "go", "rust", "php", "ruby", "swift",
  "kotlin", "dart", "scala", "html", "xml", "css", "scss", "sql", "json", "yaml",
  "markdown", "lua", "r", "matlab", "perl", "dockerfile", "nginx", "git", "diff",
  "makefile", "ini", "toml", "vue", "jsx", "tsx", "graphql",
];

// 旧版「常驻 <input> 语言框」已废弃：它会一直抢代码区输入焦点（用户反复反馈「只能在小框里输、别处输不进」）。
// 新版见 createRichEditor 内的 buildCodeBlock / openLangPop：语言是「点击才弹出的标签」，不再有常驻输入框。

// 判断"块级容器"用：插入代码块/公式块时要提升到这些元素的同级，避免出现 <p><pre>…</pre></p>
const BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6",
  "BLOCKQUOTE", "LI", "PRE", "TD", "TH", "SECTION", "ARTICLE",
]);

export function createRichEditor({ el, onChange, onInput }) {
  // 关闭浏览器内置拼写检查：它与中文输入法(IME)组词逐帧重绘严重冲突，
  // 会在每个组词更新时反复跑拼写扫描，导致「英文流畅、中文组词卡」且主线程被反复堵 ~1s
  // （拼写检查是浏览器内部行为，JS 计时看不出、也没有对应 JS 循环）。HTML 已设 spellcheck=false，这里再强制一次。
  el.spellcheck = false;
  let lastMarkdown = "";
  let composing = false; // 中文输入法组合中
  let cachedMd = ""; // getValue 的序列化结果缓存：DOM 未变时直接复用，避免每次按键全量 turndown
  let domDirty = true; // 内容是否发生变化、需要重新序列化
  let inputTimer = null; // 输入防抖：把连续打字合并成一次序列化，消除卡顿

  function triggerChange() {
    if (composing) return;
    perfMark("rich:triggerChange");
    domDirty = true;
    const md = getValue();
    if (md !== lastMarkdown) {
      lastMarkdown = md;
      onChange?.(md);
    }
  }

  // 输入事件走防抖：连续打字只在停顿后序列化一次，主线程不再被 turndown 占满，
  // 光标/字符就能即时显示（修 #输入卡顿）。命令式改动（加粗/粘贴/插入等）仍走同步 triggerChange。
  function scheduleTrigger() {
    perfMark("rich:scheduleTrigger(防抖80ms→triggerChange)");
    perfReset(); // 性能埋点：以本次输入为时间线起点
    onInput?.(); // 始终上报输入时刻（含中文组词中）：供预览渲染的「空闲闸门」正确生效，
                 // 否则 lastEditorInputAt 停在组词前，闸门失效、打字中仍会重渲染冻结主线程。
    if (composing) return; // 组词中：不序列化、不触发 onChange，等 compositionend 统一处理
    domDirty = true; // 标记脏：刷新前若外部取 getValue，也返回最新 DOM 而非旧缓存
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(() => { inputTimer = null; triggerChange(); }, 80);
  }

  function setValue(md) {
    // 先把内嵌 base64 折叠成 @img:id:name 占位符（与源码模式同一套 imageStore）。
    // 否则一张高清图就是几十万字符，直接进 contenteditable 会让大文档打字明显掉帧。
    md = shrinkMarkdown(md || "");
    lastMarkdown = md;
    cachedMd = md;
    domDirty = false; // 刚由 md 重建 DOM，序列化结果即等于 md
    const html = marked.parse(md || "") + "\n<p><br></p>"; // 末尾留空行方便继续输入
    const clean = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      ADD_TAGS: ["audio", "video", "source"],
      ADD_ATTR: ["target", "rel", "controls", "src"],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?:|mailto:|tel:|data:(?:image|audio|video)\/[^;]+;base64,|file:)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
      FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "link", "meta"],
      FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    });
    el.innerHTML = clean;
    // 把加载进来的普通代码块升级成 Typora 风格（语言标签头 + 高亮）
    decorateCodeBlocks();
    // 把 $$...$$ / $...$ 占位节点渲染成 KaTeX 公式
    decorateMath(el);
    // 把 @img: 占位符变成「点击才展开」的图片占位块（与右侧预览一致）
    decorateImages();
    // 相邻的不可编辑块（代码块 / 公式块）之间补空段落，否则光标无处落脚
    ensureEditableGaps();
  }

  /**
   * 把 <img src="@img:id:name"> 处理为图片。
   * - 轻量文档（shouldInlineImages=true，即图片总字节 ≤ 阈值）：直接解码成真实图片显示，
   *   不折叠、不要求点击 —— 小文档 / 图片少时"点一下才显示"纯属多余摩擦。
   * - 否则：换成轻量占位块，点击后才解码（大文档不卡顿的关键）。
   * 设计要点（性能）：只遍历 img 节点；占位块/内嵌图都带 data-img-id，序列化时统一
   * 还原成短占位符，绝不把 base64 写回工作副本。
   */
  function decorateImages() {
    const inline = shouldInlineImages(el);
    el.querySelectorAll('img[src^="@img:"]').forEach((img) => {
      const m = (img.getAttribute("src") || "").match(/^@img:(\d+):(.*)$/);
      if (!m) return;
      const id = m[1];
      const name = decodeURIComponent(m[2] || "");
      const alt = img.getAttribute("alt") || "";
      if (inline) {
        const dataUri = getImageById(Number(id));
        if (dataUri) {
          // 直接内嵌真实图片：带 data-img-id，序列化安全；标 data-inline 避免被点收起。
          const real = document.createElement("img");
          real.src = dataUri;
          real.alt = alt;
          real.loading = "lazy";
          real.className = "img-expanded";
          real.setAttribute("contenteditable", "false");
          real.dataset.imgId = id;
          real.dataset.imgName = name || "image.png";
          real.dataset.imgAlt = alt || "";
          real.dataset.inline = "1";
          img.replaceWith(real);
          return;
        }
        // 映射丢失则退化为占位块（数据不丢）
      }
      img.replaceWith(makeImgPlaceholder(id, name, alt));
    });
  }

  /** 构造折叠态图片占位块 */
  function makeImgPlaceholder(id, name, alt) {
    const ph = document.createElement("span");
    ph.className = "img-ph";
    ph.setAttribute("contenteditable", "false");
    ph.dataset.imgId = id;
    ph.dataset.imgName = name || "image.png";
    ph.dataset.imgAlt = alt || "";
    ph.textContent = `🖼️ 图片：${name || alt || "（点击展开）"}`;
    return ph;
  }

  /** 点击占位块 → 按 id 取回 base64，就地换成真实图片（仍带 data-img-id，序列化时不会吐 base64） */
  function expandImgPlaceholder(ph) {
    const id = ph.dataset.imgId;
    const dataUri = id ? getImageById(Number(id)) : null;
    if (!dataUri) {
      ph.textContent = "🖼️ 图片（已丢失，无法展开）";
      return;
    }
    const img = document.createElement("img");
    img.src = dataUri;
    img.alt = ph.dataset.imgAlt || "";
    img.loading = "lazy";
    img.className = "img-expanded";
    img.setAttribute("contenteditable", "false");
    img.dataset.imgId = id;
    img.dataset.imgName = ph.dataset.imgName || "image.png";
    img.dataset.imgAlt = ph.dataset.imgAlt || "";
    ph.replaceWith(img);
  }

  /** 收起：点击已展开的图片，换回占位块（避免大图一直占内存 / 影响滚动） */
  function collapseImg(img) {
    const ph = makeImgPlaceholder(
      img.dataset.imgId,
      img.dataset.imgName || "",
      img.dataset.imgAlt || "",
    );
    img.replaceWith(ph);
  }

  /** 两个相邻的 contenteditable=false 块之间插入空段落，保证任意位置都能继续输入 */
  function ensureEditableGaps() {
    const kids = [...el.children];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i];
      const b = kids[i + 1];
      if (a.getAttribute("contenteditable") === "false" && b.getAttribute("contenteditable") === "false") {
        const p = document.createElement("p");
        p.innerHTML = "<br>";
        el.insertBefore(p, b);
      }
    }
    // 文档以不可编辑块开头 / 结尾时，两端也各补一个
    const first = el.firstElementChild;
    if (first && first.getAttribute("contenteditable") === "false") {
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      el.insertBefore(p, first);
    }
    const last = el.lastElementChild;
    if (last && last.getAttribute("contenteditable") === "false") {
      const p = document.createElement("p");
      p.innerHTML = "<br>";
      el.appendChild(p);
    }
  }

  /** 构造一个 Typora 风格代码块 DOM：textarea(输入) + 高亮背板 + 右下角语言标签 */
  function buildCodeBlock(lang, codeText) {
    const pre = document.createElement("pre");
    pre.className = "cb";
    pre.setAttribute("contenteditable", "false");
    pre.setAttribute("data-lang", lang || "");

    const stack = document.createElement("div");
    stack.className = "cb-stack";

    const hl = document.createElement("pre");
    hl.className = "cb-hl";
    const code = document.createElement("code");
    code.className = "language-" + (lang || "");
    code.textContent = codeText || "";
    hl.appendChild(code);

    const ta = document.createElement("textarea");
    ta.className = "cb-input";
    ta.spellcheck = false;
    // 用 textContent（= defaultValue）而不是 .value：这样 outerHTML 里带得上初始代码，
    // 经 execCommand 插入后内容不会丢；value 会自动跟随 defaultValue（控件尚未 dirty）。
    ta.textContent = codeText || "";
    // 让 textarea 优先接收 Enter/Tab，不被外部 contenteditable 抢走
    ta.setAttribute("data-lang", lang || "");

    stack.appendChild(hl);
    stack.appendChild(ta);
    pre.appendChild(stack);

    const label = document.createElement("span");
    label.className = "cb-lang";
    label.setAttribute("contenteditable", "false");
    label.textContent = lang || "语言";
    pre.appendChild(label);
    return pre;
  }

  /** textarea 高度自适应内容（它在流内，负责撑开整个代码块；背板绝对定位跟随） */
  function autoSizeCodeInput(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = ta.scrollHeight + "px";
  }

  /** 把 textarea 的纯文本同步成高亮背板（hljs），避免改写 textContent 丢失光标 */
  function syncCodeHighlight(pre) {
    const ta = pre.querySelector(".cb-input");
    const code = pre.querySelector(".cb-hl code");
    if (!ta || !code) return;
    autoSizeCodeInput(ta);
    const lang = pre.getAttribute("data-lang") || "";
    const text = ta.value;
    code.className = "language-" + lang;
    try {
      code.removeAttribute("data-highlighted");
    } catch (_) {}
    if (lang && hljs.getLanguage(lang)) {
      try {
        code.innerHTML = hljs.highlight(text, { language: lang }).value;
        return;
      } catch (_) {}
    }
    // 无语言或语言非法：自动识别（开销略大，仅空语言时）
    try {
      const auto = hljs.highlightAuto(text);
      code.innerHTML = auto.value;
      code.className = "language-" + (auto.language || "");
    } catch (_) {
      code.textContent = text;
    }
  }

  /** 设置/切换代码块语言：更新标签与高亮（不弹窗） */
  function setCodeLang(pre, lang) {
    lang = (lang || "").trim();
    pre.setAttribute("data-lang", lang);
    const ta = pre.querySelector(".cb-input");
    if (ta) ta.setAttribute("data-lang", lang);
    const label = pre.querySelector(".cb-lang");
    if (label) label.textContent = lang || "语言";
    syncCodeHighlight(pre);
  }

  /* ---------- 语言选择浮层（挂在 body，独立于 contenteditable，绝不抢焦点） ---------- */
  let langPop = null;
  function ensureLangPop() {
    if (langPop) return langPop;
    langPop = document.createElement("div");
    langPop.className = "cb-lang-pop";
    langPop.hidden = true;
    langPop.innerHTML =
      '<input class="cb-lang-search" type="text" spellcheck="false" placeholder="搜索语言…（回车使用自定义）" />' +
      '<div class="cb-lang-list"></div>';
    document.body.appendChild(langPop);

    const search = langPop.querySelector(".cb-lang-search");
    const list = langPop.querySelector(".cb-lang-list");
    let curPre = null;
    let active = -1;
    let items = [];

    function render() {
      const q = search.value.trim().toLowerCase();
      items = LANG_OPTIONS.filter((l) => !q || l.toLowerCase().includes(q));
      list.innerHTML = "";
      if (!items.length) {
        const d = document.createElement("div");
        d.className = "cb-lang-empty";
        d.textContent = "回车即使用自定义语言";
        list.appendChild(d);
        return;
      }
      items.forEach((name, i) => {
        const d = document.createElement("div");
        d.className = "cb-lang-item" + (i === active ? " active" : "");
        d.textContent = name;
        d.addEventListener("mousedown", (e) => {
          e.preventDefault(); // 防止 search 失焦
          commit(name);
        });
        list.appendChild(d);
      });
    }

    function commit(lang) {
      const pre = curPre;
      closeLangPop();
      if (!pre) return;
      setCodeLang(pre, lang);
      focusCodeEnd(pre);
      triggerChange();
    }

    search.addEventListener("input", () => {
      active = -1;
      render();
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (items.length) {
          active = (active + 1) % items.length;
          render();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (items.length) {
          active = (active - 1 + items.length) % items.length;
          render();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        const lang = active >= 0 && items[active] ? items[active] : search.value.trim();
        commit(lang);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeLangPop();
      }
    });

    langPop._search = search;
    langPop._render = render;
    langPop._setPre = (pre) => {
      curPre = pre;
    };

    // 点击浮层外部关闭（点在语言标签上不算外部）
    document.addEventListener("mousedown", (e) => {
      if (langPop && !langPop.hidden && !langPop.contains(e.target) &&
          !(e.target.closest && e.target.closest(".cb-lang"))) {
        closeLangPop();
      }
    });
    return langPop;
  }

  function openLangPop(pre) {
    const pop = ensureLangPop();
    pop._setPre(pre);
    pop.hidden = false;
    const label = pre.querySelector(".cb-lang");
    const r = label.getBoundingClientRect();
    pop._search.value = pre.getAttribute("data-lang") || "";
    pop._render();
    // 先渲染再定位（高度已知）
    const ph = pop.getBoundingClientRect();
    let top = r.top - ph.height - 6;
    let left = r.left;
    if (top < 8) top = r.bottom + 6; // 上方放不下则放到下方
    left = Math.min(left, window.innerWidth - ph.width - 8);
    left = Math.max(8, left);
    pop.style.top = top + "px";
    pop.style.left = left + "px";
    pop._search.focus();
    pop._search.select();
  }

  function closeLangPop() {
    if (langPop) {
      langPop.hidden = true;
      langPop._setPre(null);
    }
  }

  /** 绑定代码块：输入同步高亮、滚动联动、Tab 缩进、点击标签弹语言浮层 */
  function bindCodeBlock(pre) {
    const ta = pre.querySelector(".cb-input");
    const hl = pre.querySelector(".cb-hl");
    if (ta && hl) {
      ta.addEventListener("input", () => {
        syncCodeHighlight(pre);
        ta._dirty = true;
        triggerChange();
      });
      ta.addEventListener("scroll", () => {
        hl.scrollTop = ta.scrollTop;
        hl.scrollLeft = ta.scrollLeft;
      });
      ta.addEventListener("keydown", (e) => {
        const s = ta.selectionStart;
        const en = ta.selectionEnd;
        if (e.key === "Tab") {
          e.preventDefault();
          ta.value = ta.value.slice(0, s) + "  " + ta.value.slice(en);
          ta.selectionStart = ta.selectionEnd = s + 2;
          syncCodeHighlight(pre);
          triggerChange();
        } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          // Ctrl/Cmd+Enter：跳出代码块，到下方段落继续写（Typora 行为）
          e.preventDefault();
          leaveCodeBlock(pre, "after");
        } else if (e.key === "ArrowDown" && s === en && en === ta.value.length) {
          // 光标已在末尾再按 ↓：离开代码块
          e.preventDefault();
          leaveCodeBlock(pre, "after");
        } else if (e.key === "ArrowUp" && s === en && s === 0) {
          e.preventDefault();
          leaveCodeBlock(pre, "before");
        } else if (e.key === "Backspace" && s === 0 && en === 0 && ta.value === "") {
          // 空代码块按退格：整块删除（Typora 行为）
          e.preventDefault();
          removeCodeBlock(pre);
        } else if (e.key === "Escape") {
          e.preventDefault();
          leaveCodeBlock(pre, "after");
        }
        // 代码块内不触发编辑器的加粗/撤销等快捷键
        e.stopPropagation();
      });
    }
    const label = pre.querySelector(".cb-lang");
    if (label) {
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        openLangPop(pre);
      });
    }
  }

  /**
   * 在光标处插入一个「真实 DOM 节点」。
   * 不直接用 execCommand("insertHTML", node.outerHTML)：浏览器会对插入的 HTML 做净化，
   * 可能丢掉 contenteditable="false"、textarea 的初始内容等关键属性，这正是之前代码块
   * 反复出问题的根源之一。这里先插一个空标记（借用原生撤销栈定位），再把标记换成真节点。
   * @param {Node} node 要插入的节点
   * @param {boolean} withTailP 是否在其后补一个空段落（块级元素需要，否则光标无处可去）
   * @returns {Node|null} 插入后的节点
   */
  function insertNodeAtCaret(node, isBlock) {
    ensureFocus();
    const MARK = "__rt_ins_mark__";
    document.execCommand("insertHTML", false, `<span id="${MARK}"></span>`);
    const mark = el.querySelector("#" + MARK);
    if (!mark) {
      el.appendChild(node);
    } else if (!isBlock) {
      mark.replaceWith(node); // 行内节点（如行内公式）就地替换
    } else {
      // 块级节点不能塞进 <p> 内部（非法嵌套，turndown 会串行），要提升到块级祖先的同级
      let block = mark.parentElement;
      while (block && block !== el && !BLOCK_TAGS.has(block.nodeName)) block = block.parentElement;
      if (!block || block === el) {
        mark.replaceWith(node);
      } else {
        const empty = !block.textContent.trim() && !block.querySelector("img,table,pre");
        mark.remove();
        if (empty) block.replaceWith(node); // 空段落直接被替换掉，不留空行
        else block.parentNode.insertBefore(node, block.nextSibling);
      }
    }
    if (isBlock) ensureSiblingP(node, "after"); // 块后必须有可写段落，否则光标无处可去
    return node;
  }

  /** 把光标放进某个块级节点（用于离开代码块 / 公式后继续输入） */
  function caretIntoBlock(node) {
    if (!node) return;
    const range = document.createRange();
    range.selectNodeContents(node);
    range.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    el.focus();
  }

  /** 确保节点前/后存在一个可编辑空段落，并返回它 */
  function ensureSiblingP(node, where) {
    const sib = where === "before" ? node.previousElementSibling : node.nextElementSibling;
    // 相邻已有普通可编辑块则直接用，否则插入空段落
    if (sib && sib.nodeName !== "PRE" && sib.getAttribute("contenteditable") !== "false") return sib;
    const p = document.createElement("p");
    p.innerHTML = "<br>";
    if (where === "before") node.parentNode.insertBefore(p, node);
    else node.parentNode.insertBefore(p, node.nextSibling);
    return p;
  }

  /** 离开代码块，把光标落到上/下方段落 */
  function leaveCodeBlock(pre, where) {
    caretIntoBlock(ensureSiblingP(pre, where));
    triggerChange();
  }

  /** 删除整个代码块，光标落到相邻段落 */
  function removeCodeBlock(pre) {
    const target = ensureSiblingP(pre, "before");
    pre.remove();
    caretIntoBlock(target);
    triggerChange();
  }

  function placeCaretEnd(ta) {
    try {
      ta.focus();
      const n = ta.value.length;
      ta.setSelectionRange(n, n);
    } catch (_) {}
  }

  function focusCodeEnd(pre) {
    const ta = pre.querySelector(".cb-input");
    if (ta) placeCaretEnd(ta);
  }

  function highlightCodeBlock(pre) {
    // 兼容旧调用：直接按当前语言重新高亮
    syncCodeHighlight(pre);
  }

  /** 给加载的普通 <pre><code class="language-x"> 升级成 Typora 风格（textarea + 背板 + 语言标签） */
  function decorateCodeBlocks() {
    el.querySelectorAll("pre > code").forEach((code) => {
      const pre = code.parentElement;
      if (!pre || pre.nodeName !== "PRE" || pre.classList.contains("cb")) return;
      const m = (code.className || "").match(/language-([\w+-]+)/);
      const lang = m ? m[1] : "";
      const text = code.textContent;
      const newPre = buildCodeBlock(lang, text);
      // 保留 marked 已做好的高亮作为初始背板
      const newCode = newPre.querySelector(".cb-hl code");
      if (newCode) newCode.innerHTML = code.innerHTML;
      pre.replaceWith(newPre);
      bindCodeBlock(newPre);
      // 进入 DOM 后才能拿到 scrollHeight，此时撑开高度
      autoSizeCodeInput(newPre.querySelector(".cb-input"));
    });
  }

  function getValue() {
    // 缓存：DOM 未变时直接返回上次的序列化结果，避免每次按键都全量 turndown 整篇文档（修 #输入卡顿）。
    if (!domDirty) return cachedMd;
    perfMark("rich:getValue(turndown整篇)");
    perfStage("getValue: serialize start");
    // 关键：<textarea> 序列化成 HTML 时用的是「默认值」（子文本节点），不是用户输入后的 value。
    // 不同步的话，用户在代码块里敲的内容永远不会进入 markdown（改了等于没改）。
    // 把 value 写回 defaultValue 即可更新子文本节点；因为控件已 dirty，不会反过来重置 value/光标。
    el.querySelectorAll("textarea.cb-input").forEach((ta) => {
      if (ta.defaultValue !== ta.value) ta.defaultValue = ta.value;
    });
    // 先把 contenteditable 的 HTML 转回 markdown
    let html = el.innerHTML;
    // 去掉末尾由我们添加的空白段落，避免无限追加换行
    html = html.replace(/<p><br\s*\/?><\/p>\s*$/i, "");
    const _tt = performance.now();
    cachedMd = turndown.turndown(html).trim();
    perfSelf("getValue: turndown(" + html.length + "字)", performance.now() - _tt);
    perfStage("getValue: turndown done(" + html.length + " chars)");
    domDirty = false;
    return cachedMd;
  }

  function focus() {
    el.focus();
  }

  function ensureFocus() {
    el.focus();
    const sel = window.getSelection();
    if (!sel.rangeCount) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  // 在弹窗等会抢走焦点的操作前克隆选区，操作结束后再还原，
  // 否则插入会落到文档最开头（选区丢失后 caret 回到 0）。
  function restoreRange(range) {
    el.focus();
    if (range) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      try {
        sel.addRange(range);
      } catch (_) {}
    }
  }

  function exec(cmd, val = null) {
    ensureFocus();
    document.execCommand(cmd, false, val);
    triggerChange();
  }

  function currentBlock() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    let node = sel.getRangeAt(0).commonAncestorContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentElement;
    while (node && node !== el && !/^H[1-6]|P|BLOCKQUOTE|LI|PRE|DIV$/i.test(node.nodeName)) {
      node = node.parentElement;
    }
    return node === el ? null : node;
  }

  /**
   * 工具栏传入的是 Markdown 包裹标记（如 **、*、~~），需要映射到 HTML 格式命令。
   */
  function wrap(before, after, placeholder = "") {
    ensureFocus();
    const map = {
      "**": "bold",
      "*": "italic",
      "~~": "strikeThrough",
      "“": "q",
      "”": "q",
    };
    const cmd = map[before];
    if (cmd === "bold" || cmd === "italic" || cmd === "strikeThrough") {
      // 无选区时先插入占位文本并选中，再执行格式命令
      const sel = window.getSelection();
      if (sel.rangeCount && sel.getRangeAt(0).collapsed) {
        const text = placeholder || "文本";
        exec("insertText", text);
        const r = sel.getRangeAt(0);
        const start = Math.max(0, r.startOffset - text.length);
        r.setStart(r.startContainer, start);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      exec(cmd);
      return;
    }
    // 引号等：用语义化 HTML 标签包裹（<q>）
    wrapInline(cmd || "span", placeholder);
  }

  function wrapInline(tag, placeholder = "") {
    ensureFocus();
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) {
      const text = document.createTextNode(placeholder || "文本");
      const wrapper = document.createElement(tag);
      wrapper.appendChild(text);
      range.insertNode(wrapper);
      range.setStartAfter(wrapper);
      range.setEndAfter(wrapper);
    } else {
      const wrapper = document.createElement(tag);
      // 跨块选中时 surroundContents 会抛错：改用 extractContents 取出片段整体包裹，
      // 避免回退到 strikeThrough 等错误命令（#6：引用包裹误加删除线的根因）。
      wrapper.appendChild(range.extractContents());
      range.insertNode(wrapper);
      range.setStartBefore(wrapper);
      range.setEndAfter(wrapper);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    triggerChange();
  }

  function toggleHeading(level) {
    ensureFocus();
    const block = currentBlock();
    if (!block) {
      exec("formatBlock", `<h${level}>`);
      triggerChange();
      return;
    }
    if (/^H[1-6]$/i.test(block.nodeName) && block.nodeName === `H${level}`) {
      // 同级再次点击 -> 取消标题，变回 p
      exec("formatBlock", "<p>");
    } else {
      exec("formatBlock", `<h${level}>`);
    }
    triggerChange();
  }

  // 设定标题级别（下拉选择用）：level 1-6 设对应标题，0 取消标题变正文。
  function setHeading(level) {
    ensureFocus();
    if (level >= 1 && level <= 6) {
      exec("formatBlock", `<h${level}>`);
    } else {
      exec("formatBlock", "<p>");
    }
    triggerChange();
  }

  function linePrefix(prefix) {
    ensureFocus();
    if (prefix === "- ") exec("insertUnorderedList");
    else if (prefix === "1. ") exec("insertOrderedList");
    else if (prefix === "> ") exec("formatBlock", "<blockquote>");
    else if (prefix === "- [ ] ") insertTaskList();
    triggerChange();
  }

  function insertTaskList() {
    ensureFocus();
    exec("insertUnorderedList");
    // 把刚创建的 li 前面加上 checkbox
    setTimeout(() => {
      const block = currentBlock();
      if (block && /^LI$/i.test(block.nodeName) && !block.querySelector('input[type="checkbox"]')) {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.disabled = false;
        cb.style.pointerEvents = "none"; // 防止点击抢走焦点；状态由 turndown 读取 checked
        block.insertBefore(cb, block.firstChild);
      }
      triggerChange();
    }, 0);
  }

  function insertBlock(text) {
    ensureFocus();
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0) : null;

    let html;
    if (text.trim() === "---") {
      html = "<hr>";
    } else if (/^```[\s\S]*```$/.test(text.trim())) {
      // 代码块 markdown → Typora 风格代码块（textarea + 高亮背板 + 语言标签）
      const lines = text.trim().split("\n");
      const lang = lines[0].replace(/^```/, "").trim();
      const code = lines.slice(1, -1).join("\n");
      const pre = buildCodeBlock(lang, code);
      html = pre.outerHTML + "<p><br></p>";
    } else {
      // 其他文本按换行转成段落/换行
      html = text
        .split("\n")
        .map((line) => (line.trim() ? `<p>${escapeHtml(line)}</p>` : "<p><br></p>"))
        .join("");
    }

    const div = document.createElement("div");
    div.innerHTML = html;
    if (range) {
      range.deleteContents();
      range.insertNode(div);
      range.setStartAfter(div);
      range.setEndAfter(div);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.appendChild(div);
    }
    // 若插入的是代码块，补绑语言浮层与高亮同步
    const insPre = div.querySelector("pre.cb");
    if (insPre) {
      bindCodeBlock(insPre);
      syncCodeHighlight(insPre);
    }
    triggerChange();
  }

  async function insertLink() {
    const sel = window.getSelection();
    const range = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const text = sel.toString().trim();
    const url = await showPrompt({ title: "插入链接", value: "https://", placeholder: "链接地址" });
    if (!url) return;
    restoreRange(range); // 还原到插入前的光标/选区位置
    if (text) {
      exec("createLink", url);
    } else {
      // 无选中文字时，直接插入一个带文字的链接节点
      const a = document.createElement("a");
      a.href = url;
      a.textContent = "链接文字";
      const cur = window.getSelection();
      const r = cur.rangeCount ? cur.getRangeAt(0) : null;
      if (r) {
        r.deleteContents();
        r.insertNode(a);
        r.setStartAfter(a);
        r.setEndAfter(a);
        cur.removeAllRanges();
        cur.addRange(r);
      } else {
        el.appendChild(a);
      }
    }
    triggerChange();
  }

  /** 插入图片：先选「图片链接」或「本地图片」，再分别走 URL 输入 / 文件选择器。
   *  文件对话框会让编辑区失焦，所以先克隆当前选区，插入前再还原。 */
  async function insertImage() {
    const sel = window.getSelection();
    const savedRange = sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const choice = await showChoiceModal({
      title: "插入图片",
      options: [
        { key: "url", label: "图片链接", primary: true },
        { key: "local", label: "本地图片" },
      ],
    });
    if (!choice) return;
    let url = null;
    if (choice === "url") {
      url = await showPrompt({
        title: "插入图片",
        placeholder: "图片地址(URL 或 data:image/...;base64,)",
      });
    } else {
      url = await new Promise((resolve) => openLocalImageFile((dataUrl) => resolve(dataUrl)));
    }
    if (!url) return;
    restoreRange(savedRange);
    insertImageSrc(url);
  }

  /**
   * 统一的图片插入入口。
   * base64 图片先登记进 imageStore 换成 id，DOM 里放带 data-img-id 的 <img>；
   * 这样即使正文有几十张图，getValue 也只吐短占位符，打字不会因为反复拼接
   * 几 MB 的 base64 而卡顿。普通 URL 图片体积小，按原样插入即可。
   */
  function insertImageSrc(url, alt = "") {
    if (typeof url === "string" && url.startsWith("data:")) {
      const ph = registerImage(url, alt); // → "@img:{id}:{filename}"
      const m = ph.match(/^@img:(\d+):(.*)$/);
      if (m) {
        const img = document.createElement("img");
        img.src = url; // 刚插入的图直接可见，不用再点一次
        img.alt = alt;
        img.className = "img-expanded";
        img.setAttribute("contenteditable", "false");
        img.dataset.imgId = m[1];
        img.dataset.imgName = m[2];
        img.dataset.imgAlt = alt;
        ensureFocus();
        document.execCommand("insertHTML", false, img.outerHTML);
        triggerChange();
        return;
      }
    }
    exec("insertImage", url);
    triggerChange();
  }

  /** 插入 Typora 风格代码块（textarea + 高亮背板 + 右下角语言标签）。
   *  若已有跨行选区，则把选区内容包进代码块；插入后光标直接进代码区，可正常输入。
   *  语言用「点击标签弹浮层」选择，绝不在代码块里放常驻输入框，从根上避免抢焦点。 */
  function insertCodeBlock(defaultLang = "") {
    const sel = window.getSelection();
    const selected = sel.rangeCount ? sel.getRangeAt(0).toString() : "";
    const safeLang = (defaultLang || "").trim();
    // #7：无论选中文字是否含换行，都放入代码块（原逻辑对单行选中丢弃，导致文字不进代码框）。
    // insertNodeAtCaret 内部 insertHTML 会用占位 span 替换当前选区，原文不会重复。
    const codeText = selected;

    const newPre = insertNodeAtCaret(buildCodeBlock(safeLang, codeText), true);
    bindCodeBlock(newPre);
    syncCodeHighlight(newPre);
    // 光标放进代码区（末尾），方便直接输入
    focusCodeEnd(newPre);
    triggerChange();
  }

  function insertTable() {
    const html =
      '<table><thead><tr><th>列1</th><th>列2</th></tr></thead><tbody><tr><td>单元格</td><td>单元格</td></tr><tr><td>单元格</td><td>单元格</td></tr></tbody></table><p><br></p>';
    ensureFocus();
    exec("insertHTML", html);
    triggerChange();
  }

  /* ---------- 表格增删行列（富文本：直接操作 DOM） ---------- */

  /** 光标所在的单元格（td/th），不在表格里返回 null */
  function currentCell() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    let n = sel.getRangeAt(0).startContainer;
    if (n.nodeType === Node.TEXT_NODE) n = n.parentElement;
    if (!n || !n.closest) return null;
    const cell = n.closest("td,th");
    return cell && el.contains(cell) ? cell : null;
  }

  function placeCaret(cell) {
    if (!cell) return;
    const r = document.createRange();
    r.selectNodeContents(cell);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    el.focus();
  }

  function ensureTbody(table) {
    if (table.tBodies && table.tBodies.length) return table.tBodies[0];
    const tb = document.createElement("tbody");
    table.appendChild(tb);
    return tb;
  }

  /**
   * @param {'insert'|'rowAbove'|'rowBelow'|'colLeft'|'colRight'|'delRow'|'delCol'|'delTable'|'format'} op
   */
  function tableOp(op) {
    if (op === "insert") return insertTable();
    if (op === "format") {
      status("富文本模式表格由浏览器自动排版；切到源码模式可对齐 Markdown 竖线");
      return;
    }
    const cell = currentCell();
    if (!cell) {
      status("请先把光标放到表格内，再执行表格操作");
      return;
    }
    const table = cell.closest("table");
    const tr = cell.parentElement;
    const colIdx = [...tr.children].indexOf(cell);
    const allRows = [...table.rows];
    const colCount = allRows.reduce((m, r) => Math.max(m, r.cells.length), 0);
    const inHead = tr.parentElement && tr.parentElement.tagName === "THEAD";

    const makeCell = (tag, text) => {
      const e = document.createElement(tag);
      // 空单元格塞一个 <br>，否则 contenteditable 里点不进去
      if (text) e.textContent = text;
      else e.appendChild(document.createElement("br"));
      return e;
    };

    switch (op) {
      case "rowAbove":
      case "rowBelow": {
        const newTr = document.createElement("tr");
        for (let i = 0; i < colCount; i++) newTr.appendChild(makeCell("td", ""));
        if (inHead) {
          // 表头上下都只能插到数据区最前面，保证 thead 只有一行
          const tb = ensureTbody(table);
          tb.insertBefore(newTr, tb.firstChild);
        } else {
          tr.parentElement.insertBefore(newTr, op === "rowAbove" ? tr : tr.nextSibling);
        }
        placeCaret(newTr.cells[Math.min(colIdx, newTr.cells.length - 1)]);
        status("已插入行");
        break;
      }
      case "colLeft":
      case "colRight": {
        const at = op === "colLeft" ? colIdx : colIdx + 1;
        allRows.forEach((r) => {
          const isHeadRow =
            (r.parentElement && r.parentElement.tagName === "THEAD") ||
            (r.cells[0] && r.cells[0].tagName === "TH");
          const c = makeCell(isHeadRow ? "th" : "td", isHeadRow ? "新列" : "");
          if (at >= r.cells.length) r.appendChild(c);
          else r.insertBefore(c, r.cells[at]);
        });
        placeCaret(tr.cells[Math.min(at, tr.cells.length - 1)]);
        status("已插入列");
        break;
      }
      case "delRow": {
        if (inHead) {
          status("表头行不可删除（可用「删除表格」）");
          return;
        }
        const body = tr.parentElement;
        if (body.rows.length <= 1) {
          status("表格至少保留一行数据（可用「删除表格」）");
          return;
        }
        const next = tr.nextElementSibling || tr.previousElementSibling;
        tr.remove();
        if (next) placeCaret(next.cells[Math.min(colIdx, next.cells.length - 1)]);
        status("已删除行");
        break;
      }
      case "delCol": {
        if (colCount <= 1) {
          status("表格至少保留一列（可用「删除表格」）");
          return;
        }
        allRows.forEach((r) => {
          if (r.cells[colIdx]) r.deleteCell(colIdx);
        });
        const back = tr.cells[Math.min(colIdx, tr.cells.length - 1)];
        placeCaret(back);
        status("已删除列");
        break;
      }
      case "delTable": {
        const holder = document.createElement("p");
        holder.appendChild(document.createElement("br"));
        table.replaceWith(holder);
        placeCaret(holder);
        status("已删除表格");
        break;
      }
      default:
        return;
    }
    triggerChange();
  }

  function toggleCode() {
    ensureFocus();
    const sel = window.getSelection();
    const text = sel.toString();
    if (text.includes("\n")) {
      // 代码块：Typora 风格（textarea + 高亮背板 + 语言标签）
      const pre = buildCodeBlock("", text || "// 代码");
      const range = sel.getRangeAt(0);
      range.deleteContents();
      range.insertNode(pre);
      range.setStartAfter(pre);
      range.setEndAfter(pre);
      sel.removeAllRanges();
      sel.addRange(range);
      bindCodeBlock(pre);
      syncCodeHighlight(pre);
      ensureSiblingP(pre, "after"); // 保证代码块后面有可写的段落
      focusCodeEnd(pre);
    } else {
      wrapInline("code", "代码");
    }
    triggerChange();
  }

  function indent(extra) {
    ensureFocus();
    exec(extra ? "indent" : "outdent");
    triggerChange();
  }

  function undo() {
    ensureFocus();
    exec("undo");
  }
  function redo() {
    ensureFocus();
    exec("redo");
  }

  /* ---------- 公式（KaTeX，对齐 Typora） ---------- */
  /** 公式为空时加 .math-empty，由 CSS 显示占位提示，避免"看不见的公式" */
  function markMathEmpty(node, tex) {
    node.classList.toggle("math-empty", !String(tex || "").trim());
  }

  function buildMathBlock(tex) {
    const div = document.createElement("div");
    div.className = "math-block";
    div.setAttribute("contenteditable", "false");
    div.setAttribute("data-tex", tex || "");
    const render = document.createElement("span");
    render.className = "math-render";
    render.innerHTML = renderKatex(tex || "", true);
    div.appendChild(render);
    markMathEmpty(div, tex);
    return div;
  }

  function buildMathInline(tex) {
    const span = document.createElement("span");
    span.className = "math-inline";
    span.setAttribute("contenteditable", "false");
    span.setAttribute("data-tex", tex || "");
    const render = document.createElement("span");
    render.className = "math-render";
    render.innerHTML = renderKatex(tex || "", false);
    span.appendChild(render);
    markMathEmpty(span, tex);
    return span;
  }

  /** 块公式后补一个空段落，方便继续输入；并把光标放进去 */
  function ensureTrailingP(node) {
    let next = node.nextSibling;
    const isEmptyP = (n) =>
      n && n.nodeName === "P" && (n.textContent === "" || (n.childNodes.length === 1 && n.firstChild.nodeName === "BR"));
    if (!isEmptyP(next)) {
      next = document.createElement("p");
      next.appendChild(document.createElement("br"));
      node.parentNode.insertBefore(next, node.nextSibling);
    }
    const p = next;
    const r = document.createRange();
    r.setStart(p, 0);
    r.collapse(true);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    el.focus();
  }

  /** 双击块公式进入源码编辑（textarea），失焦或 Ctrl+Enter 提交 */
  function openMathBlockEditor(div) {
    if (div.querySelector("textarea.math-src")) {
      div.querySelector("textarea.math-src").focus();
      return; // 已在编辑中，避免叠加多个编辑框
    }
    const render = div.querySelector(".math-render") || div;
    const tex = div.getAttribute("data-tex") || "";
    const ta = document.createElement("textarea");
    ta.className = "math-src";
    ta.spellcheck = false;
    ta.value = tex;
    div.insertBefore(ta, render);
    render.hidden = true;
    ta.focus();
    ta.select();
    const commit = () => {
      const v = ta.value;
      if (!ta.parentNode) return; // 已提交过
      div.setAttribute("data-tex", v);
      render.innerHTML = renderKatex(v, true);
      render.hidden = false;
      markMathEmpty(div, v);
      ta.parentNode.removeChild(ta);
      ensureTrailingP(div);
      triggerChange();
    };
    ta.addEventListener("blur", commit);
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        ta.blur();
      } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        ta.blur();
      }
      e.stopPropagation(); // 公式内不触发编辑器快捷键
    });
  }

  /** 双击行内公式：弹窗编辑 LaTeX 源码 */
  function editInlineMath(span) {
    const cur = span.getAttribute("data-tex") || "";
    showPrompt({ title: "行内公式 (LaTeX)", value: cur, placeholder: "如 x^2 + 1" }).then((v) => {
      if (v === null) return;
      span.setAttribute("data-tex", v);
      const r = span.querySelector(".math-render");
      if (r) r.innerHTML = renderKatex(v, false);
      markMathEmpty(span, v);
      const rg = document.createRange();
      rg.setStartAfter(span);
      rg.collapse(true);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(rg);
      el.focus();
      triggerChange();
    });
  }

  function insertMathBlock(tex = "") {
    const mb = insertNodeAtCaret(buildMathBlock(tex), true);
    openMathBlockEditor(mb); // 插入后直接进源码编辑，和 Typora 一样
    triggerChange();
  }

  function insertMathInline(tex = "") {
    const mi = insertNodeAtCaret(buildMathInline(tex), false);
    editInlineMath(mi);
    triggerChange();
  }

  /** 单击块公式即进入源码编辑（Typora 行为）；行内公式用双击，避免误触。 */
  function onRichClick(e) {
    if (!e.target || !e.target.closest) return;
    // 图片：折叠态点开、展开态点收（与右侧预览的交互一致）
    const ph = e.target.closest(".img-ph");
    if (ph && el.contains(ph)) {
      e.preventDefault();
      expandImgPlaceholder(ph);
      return;
    }
    const openImg = e.target.closest("img.img-expanded");
    if (openImg && el.contains(openImg)) {
      // 轻量文档内嵌图（data-inline）：已是真图，点击不折叠（小文档无需"点开/收起"）
      if (openImg.dataset.inline) return;
      e.preventDefault();
      collapseImg(openImg);
      return;
    }
    const mb = e.target.closest(".math-block");
    if (mb && el.contains(mb)) openMathBlockEditor(mb);
  }

  function onRichDblClick(e) {
    if (!e.target || !e.target.closest) return;
    const mb = e.target.closest(".math-block");
    if (mb) {
      openMathBlockEditor(mb);
      return;
    }
    const mi = e.target.closest(".math-inline");
    if (mi) {
      editInlineMath(mi);
    }
  }

  function onKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      // 加粗/斜体/链接/行内代码：组合键可自定义（设置面板）。
      // 命中则在本层处理并 stopPropagation，避免冒泡到 document 被重复分发。
      if (matchAction(e, "bold")) return e.preventDefault(), e.stopPropagation(), exec("bold");
      if (matchAction(e, "italic")) return e.preventDefault(), e.stopPropagation(), exec("italic");
      if (matchAction(e, "link")) return e.preventDefault(), e.stopPropagation(), insertLink();
      if (matchAction(e, "inlineCode")) return e.preventDefault(), e.stopPropagation(), toggleCode();
      // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z：原生 execCommand 撤销栈会被直接改 DOM
      // （代码块/公式/表格）弄坏，统一交给渲染进程的「快照历史栈」处理。
      // 这里只阻止浏览器默认行为，不 return，让事件冒泡到 document 层。
      if (e.key.toLowerCase() === "z" || e.key.toLowerCase() === "y") {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      const block = currentBlock();
      const raw = block ? block.textContent.trim() : "";
      // 空段落里输入 $$ 回车 → 块级公式（对齐 Typora）
      if (block && block.nodeName === "P" && raw === "$$") {
        e.preventDefault();
        const mb = buildMathBlock("");
        block.replaceWith(mb);
        openMathBlockEditor(mb);
        triggerChange();
        return;
      }
      // 段落里输入 ``` 或 ```js 回车 → 代码块（对齐 Typora）
      const fence = block && block.nodeName === "P" ? raw.match(/^```([\w+#-]*)$/) : null;
      if (fence) {
        e.preventDefault();
        const cb = buildCodeBlock(fence[1] || "", "");
        block.replaceWith(cb);
        const tail = document.createElement("p");
        tail.innerHTML = "<br>";
        if (!cb.nextElementSibling) cb.parentNode.insertBefore(tail, cb.nextSibling);
        bindCodeBlock(cb);
        syncCodeHighlight(cb);
        focusCodeEnd(cb);
        triggerChange();
        return;
      }
    }
    if (e.key === "Tab") {
      e.preventDefault();
      indent(!e.shiftKey);
    }
  }

  function onPaste(e) {
    const items = [...(e.clipboardData?.items || [])];
    const imageItem = items.find((it) => it.type.startsWith("image/"));
    if (imageItem) {
      e.preventDefault();
      const file = imageItem.getAsFile();
      if (!file) return;
      blobToBase64(file).then((dataUri) => {
        ensureFocus();
        insertImageSrc(dataUri, file.name || "");
      });
    }
    // 非图片粘贴走默认行为（浏览器会尽量保留格式）
  }

  // 防止 createEditor 被反复调用（切换模式 / 大文档自动降级）时，
  // 在持久的 contenteditable 节点上重复绑定事件 → 粘贴图片等被多次触发（出现两张一样的图）。
  // 每次绑定前先移除上一次的同类型处理器。
  const richBound = (el.__richBound = el.__richBound || {});
  const onRich = (type, handler) => {
    if (richBound[type]) el.removeEventListener(type, richBound[type]);
    richBound[type] = handler;
    el.addEventListener(type, handler);
  };
  onRich("input", scheduleTrigger);
  onRich("keydown", onKeydown);
  onRich("click", onRichClick);
  onRich("dblclick", onRichDblClick);
  onRich("paste", onPaste);
  onRich("compositionstart", () => { composing = true; window.__peneditComposing = true; });
  onRich("compositionend", () => {
    composing = false;
    window.__peneditComposing = false;
    // 改为防抖同步，而非在组词结束的同步调用里对整篇文档跑 turndown：
    // 否则每打一个中文词都要卡一次（整篇 HTML→Markdown 序列化阻塞主线程）。
    // 预览渲染另有「空闲闸门」保护，不会在打字过程中冻结界面。
    scheduleTrigger();
  });

  /* ---- 右键菜单用到的基础能力 ---- */

  /** 当前选中的纯文本 */
  function getSelectionText() {
    const sel = window.getSelection();
    return sel && sel.rangeCount ? sel.toString() : "";
  }

  /** 在光标处插入纯文本（会替换掉当前选区） */
  function insertText(text) {
    ensureFocus();
    document.execCommand("insertText", false, text);
    triggerChange();
  }

  /** 插入图片占位标记【插入图片】，并选中"图片"两字便于直接改写描述 */
  function insertImagePlaceholder() {
    const token = "【插入图片】";
    ensureFocus();
    document.execCommand("insertText", false, token);
    const sel = window.getSelection();
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0);
      const node = r.startContainer;
      const off = r.startOffset; // 插入后光标落在标记末尾
      if (node.nodeType === 3 && off >= 3) {
        try {
          const nr = document.createRange();
          nr.setStart(node, off - 3); // 图
          nr.setEnd(node, off - 1); // 片
          sel.removeAllRanges();
          sel.addRange(nr);
        } catch (_) {}
      }
    }
    triggerChange();
  }

  /** 插入一段 HTML（粘贴富文本 / 插入图片用） */
  function insertHTML(html) {
    ensureFocus();
    document.execCommand("insertHTML", false, html);
    triggerChange();
  }

  function deleteSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    exec("delete");
  }

  function selectAll() {
    el.focus();
    const r = document.createRange();
    r.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  /** 选中光标所在的整个块（段落 / 标题 / 列表项），对应 Typora 的「选中当前行」 */
  function selectLine() {
    const block = currentBlock();
    if (!block) return;
    const r = document.createRange();
    r.selectNodeContents(block);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    el.focus();
  }

  /**
   * 右键点击时把光标移到点击处。
   * contenteditable 在右键时不会自动移动 caret，
   * 不处理的话「粘贴」会插到上一次光标的位置，而不是用户右击的地方。
   */
  function caretFromPoint(x, y) {
    const sel = window.getSelection();
    // 右击落在已有选区内时保留选区（用户是想对选中内容操作）
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const rects = sel.getRangeAt(0).getClientRects();
      for (const rc of rects) {
        if (x >= rc.left && x <= rc.right && y >= rc.top && y <= rc.bottom) return;
      }
    }
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(x, y); // Chromium（Electron 走这条）
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p) {
        range = document.createRange();
        range.setStart(p.offsetNode, p.offset);
        range.collapse(true);
      }
    }
    if (range && el.contains(range.startContainer)) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
  }

  return {
    type: "richtext",
    el,
    getValue,
    setValue,
    focus,
    getSelectionText,
    insertText,
    insertImagePlaceholder,
    insertHTML,
    deleteSelection,
    selectAll,
    selectLine,
    caretFromPoint,
    /** 光标是否落在表格内（决定右键菜单是否显示表格操作） */
    inTable: () => !!currentCell(),
    wrap, // markdown 包裹标记 -> 对应 HTML 格式命令（**→bold 等）
    linePrefix,
    toggleHeading,
    setHeading,
    insertBlock,
    insertLink,
    insertImage,
    insertTable,
    insertCodeBlock,
    insertMathBlock,
    insertMathInline,
    tableOp,
    toggleCode,
    indent,
    undo,
    redo,
  };
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
