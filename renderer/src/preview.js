/**
 * preview.js — Markdown 渲染管线（从零实现，仅依赖标准库）
 *
 * 链路：marked(CommonMark+GFM) → highlight.js(代码高亮) → [TOC]目录生成
 *      → DOMPurify(净化，防 XSS)。返回一个可直接 innerHTML 的安全字符串。
 *
 * 性能：大文档（如 1000 万字符 + 几十张 base64 图片）若每次按键都全量重渲染，
 * 会卡死主线程。这里改为「分块增量渲染」：
 *  - 按标题 / 段落把 Markdown 切成多段（每段上限约 30KB）；
 *  - 每段用内容哈希缓存，未变化的段直接复用 DOM 节点（图片也不会被重新解码）；
 *  - 只在编辑发生时重渲染发生变化的那一段；
 *  - 渲染过程每 16 段让出一次主线程，避免输入卡顿。
 *
 * 安全说明：渲染的内容来自 markitdown 转换结果或用户粘贴，可能含原始 HTML /
 * 恶意脚本，因此必须经过 DOMPurify 净化后才插入 DOM。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github.css";
import { getImageById, isDocImageLight } from "./imageStore.js";
import { useMathExtensions, decorateMath } from "./math.js";
import { useFootnoteExtensions, assignHeadingIds } from "./extras.js";
import mermaid from "mermaid";
import { perfStage, perfSlow, perfSelf } from "./perf.js";

marked.setOptions({
  gfm: true,
  breaks: false,
});

// 公式（KaTeX）：$$...$$ / $...$。marked 是单例，useMathExtensions 内部保证只注册一次。
useMathExtensions(marked);
// 脚注（L2）：[^1] / [^1]: 内容
useFootnoteExtensions(marked);

/* ---------- Mermaid 图表（L2） ---------- */
let mermaidInit = false;
function ensureMermaid() {
  if (mermaidInit) return;
  mermaidInit = true;
  const dark = !document.documentElement.classList.contains("light");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "loose",
    theme: dark ? "dark" : "neutral",
    fontFamily: "inherit",
  });
}

/** 主题切换后重新初始化 mermaid（图表配色跟随主题） */
export function reinitMermaid() {
  mermaidInit = false;
  // 已渲染的图表不重绘（避免闪烁）；新图表用新主题
  ensureMermaid();
}

/** 把容器内未渲染的 .mermaid 块交给 mermaid 渲染（失败时回退显示源码） */
export async function renderMermaidIn(container) {
  ensureMermaid();
  const blocks = [...container.querySelectorAll(".mermaid:not([data-mermaid-done])")];
  if (!blocks.length) return;
  for (const el of blocks) {
    el.setAttribute("data-mermaid-done", "1");
    const code = el.textContent || "";
    const t0 = performance.now();
    try {
      const { svg } = await mermaid.render("mmd-" + Math.random().toString(36).slice(2, 9), code);
      const wrap = document.createElement("div");
      wrap.className = "mermaid-wrap";
      wrap.innerHTML = svg;
      el.replaceWith(wrap);
    } catch (_) {
      // 渲染失败：保留源码并标记错误，方便用户修正语法
      el.classList.add("mermaid-error");
      el.textContent = "⚠️ Mermaid 渲染失败：\n" + code;
    }
    perfSlow("mermaid block(" + code.length + "字)", performance.now() - t0, 200);
  }
}

/* ---------- 内部链接（文档锚点跳转，L2） ---------- */
export function bindAnchorClick(container) {
  container.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href^='#']") : null;
    if (!a) return;
    const target = document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

const TOC_RE = /^\[TOC\]$/i;
const SECTION_MAX = 30000; // 单段最大字符数，超过则按空行继续切分

function htmlToNodes(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return [...t.content.childNodes];
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

/* ---------- 分块 + 标题收集（单次扫描） ---------- */
function prepare(md) {
  const lines = (md || "").split("\n");
  const sections = [];
  const headings = [];
  let cur = [];
  let curLen = 0;
  const flush = () => {
    if (cur.length) {
      sections.push(cur.join("\n"));
      cur = [];
      curLen = 0;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hm = line.match(/^(#{1,6})\s+(.*)$/);
    if (hm) {
      headings.push({
        level: Number(hm[1]),
        text: hm[2],
        id: "h-" + Math.random().toString(36).slice(2, 8),
      });
    }
    if (hm && cur.length) {
      // 标题是安全的切分点：上一块收尾，本行另起一块
      flush();
      cur = [line];
      curLen = line.length + 1;
    } else {
      cur.push(line);
      curLen += line.length + 1;
      // 当前块过大且正好处在段落边界，切一刀
      if (curLen >= SECTION_MAX && line.trim() === "") {
        sections.push(cur.join("\n"));
        cur = [];
        curLen = 0;
      }
    }
  }
  flush();
  return { sections, headings };
}

/* 轻量 FNV-1a 哈希：用于判断是否同一段，避免重复渲染 */
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ---------- 单段渲染（marked + 高亮 + 净化） ---------- */
/**
 * @param {string} md 单段 Markdown（含 @img: 占位符）
 * @param {boolean} inline 全局轻量判定（整篇图片总字节 ≤ 阈值）→ 直接内嵌真图，否则折叠占位块
 */
function renderSectionInner(md, inline) {
  const raw = marked.parse(md || "");
  const root = document.createElement("div");
  root.innerHTML = raw;

  // 代码高亮
  root.querySelectorAll("pre code").forEach((block) => {
    // Mermaid 图不交给 hljs（语言未注册会抛错），单独抽出来
    if (block.classList.contains("language-mermaid")) return;
    try {
      hljs.highlightElement(block);
    } catch (_) {
      /* 个别语言未注册时忽略 */
    }
  });

  // Mermaid：```mermaid 围栏 → 渲染占位块（renderMermaidIn 在拼装后统一渲染）
  root.querySelectorAll("pre code.language-mermaid").forEach((code) => {
    const pre = code.closest("pre");
    if (!pre) return;
    const div = document.createElement("div");
    div.className = "mermaid";
    div.textContent = code.textContent;
    pre.replaceWith(div);
  });

  // 链接安全打开
  root.querySelectorAll("a").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });

  // 把 @img:{id}:filename 占位符处理为图片。
  // 轻量文档（inline=true，即整篇图片总字节 ≤ 阈值）：直接解码成真实图片显示，不折叠、不要求点击；
  // 否则：换成轻量占位块（不解码巨大 base64，保持小巧流畅），点击占位块可单独展开（见 main.js）。
  root.querySelectorAll("img").forEach((img) => {
    const src = img.getAttribute("src") || "";
    const m = src.match(/^@img:(\d+):(.*)$/);
    if (m) {
      if (inline) {
        const dataUri = getImageById(Number(m[1]));
        if (dataUri) {
          // 直接内嵌真实图片（带 data-img-id，净化后序列化安全；DOMPurify 放行 data:image base64）
          const real = document.createElement("img");
          real.src = dataUri;
          real.alt = img.getAttribute("alt") || "";
          real.loading = "lazy";
          real.className = "img-expanded";
          real.dataset.imgId = m[1];
          img.replaceWith(real);
          return;
        }
        // 映射丢失则退化为占位块
      }
      const ph = document.createElement("div");
      ph.className = "img-ph";
      ph.dataset.imgId = m[1];
      const name = decodeURIComponent(m[2] || "");
      ph.textContent = `🖼️ 图片：${name || img.getAttribute("alt") || "（点击展开）"}`;
      img.replaceWith(ph);
    }
  });

  // 净化：放行 data:image base64（图片内嵌）、file:、https:，禁止脚本/样式注入
  return DOMPurify.sanitize(root.innerHTML, {
    ADD_ATTR: ["target", "rel"],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?:|mailto:|tel:|data:(?:image|audio|video)\/[^;]+;base64,|file:)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
}

/* ---------- [TOC] 目录（在整体拼装后统一处理） ---------- */
function buildTOC(heads) {
  if (!heads.length) return "";
  let html = '<nav class="toc"><div class="toc-title">目录</div><ul>';
  heads.forEach((h) => {
    const text = h.textContent.replace(/¶|#/g, "").trim();
    html += `<li class="toc-l${h.tagName.slice(1)}"><a href="#${h.id}">${escapeHtml(text)}</a></li>`;
  });
  html += "</ul></nav>";
  return html;
}

function finalizeTOC(container) {
  const placeholders = [...container.querySelectorAll("p")].filter((p) =>
    TOC_RE.test(p.textContent.trim())
  );
  const existing = container.querySelectorAll(".toc");
  if (!placeholders.length && !existing.length) return;
  const heads = [...container.querySelectorAll("h1,h2,h3,h4,h5,h6")];
  assignHeadingIds(heads); // 确定性 slug id（L2 内部链接/锚点）
  if (!heads.length) return;
  const nav = htmlToNodes(buildTOC(heads));
  placeholders.forEach((p) => p.replaceWith(...nav.map((n) => n.cloneNode(true))));
  existing.forEach((n) => n.replaceWith(...nav.map((x) => x.cloneNode(true))));
}

/* ---------- 直接注入已净化的原始 HTML（AI 排版结果进分屏预览用） ----------
 * 不跑 Markdown 管线：AI 返回的就是 100% 内联样式的公众号 HTML。
 * 仅用与正文一致的净化配置（保留内联 style / data:image，禁脚本/style 标签）。 */
export function renderRawHtml(container, html) {
  container.innerHTML = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "rel", "data-ai-img"],
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?:|mailto:|tel:|data:(?:image|audio|video)\/[^;]+;base64,|file:)|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "link", "meta"],
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
  });
  reinitMermaid();
}

/* ---------- 完整同步渲染（用于导出 HTML/PDF，含真实图片而非占位块） ---------- */
/**
 * 把整篇 Markdown 渲染成安全的 HTML 片段（不含 <html>/<head> 外壳）。
 * 与 renderMarkdownInto 不同：这里是一次性同步渲染，不切分增量、不把图片
 * 换成占位块——专供导出场景（HTML/PDF 需要把 base64 图片原样写进文件）。
 * @param {string} md 已展开（含 base64）的 Markdown
 */
export function renderFullHtml(md) {
  const { sections } = prepare(md || "");
  const tmp = document.createElement("div");
  tmp.innerHTML = sections
    .map((s) => `<div class="md-sec">${renderSectionInner(s, true)}</div>`)
    .join("");
  decorateMath(tmp); // 占位节点 → 真实 KaTeX（净化之后再做，避免被 sanitize 削掉）
  finalizeTOC(tmp);
  return tmp.innerHTML;
}

/* ---------- 分块增量渲染入口（异步，让出主线程） ---------- */
let renderToken = 0;

/**
 * 把 Markdown 分块增量渲染进 container。
 * @param {HTMLElement} container
 * @param {string} md
 */
export async function renderMarkdownInto(container, md) {
  const token = ++renderToken; // 每次渲染自增；旧渲染在让出点检测到 token 变化即放弃
  perfStage("renderMarkdownInto start(" + (md || "").length + "字)");
  const { sections, headings } = prepare(md);
  perfStage("prepare done(" + sections.length + " sections)");
  // 全局轻量判定：整篇图片总字节 ≤ 阈值才内嵌（按全篇算，不能按段）。
  // 翻转为内嵌/折叠时，所有段都应重渲染，故把 inline 编入段缓存键。
  const inline = isDocImageLight(md);
  const inlineBit = inline ? "\x01" : "\x00";

  const prevNodes = container._secNodes || [];
  const prevHash = container._secHash || [];
  const nextNodes = [];
  const nextHash = [];

  for (let i = 0; i < sections.length; i++) {
    if (token !== renderToken) return; // 已被更新的渲染取代，放弃本次
    const h = hashStr(sections[i] + inlineBit);
    let node;
    if (prevNodes[i] && prevHash[i] === h) {
      node = prevNodes[i]; // 复用：不重新 marked/净化，图片也不重新解码
    } else {
      const t0 = performance.now();
      node = document.createElement("div");
      node.className = "md-sec";
      node.innerHTML = renderSectionInner(sections[i], inline);
      decorateMath(node); // 净化后再渲染公式
      perfSlow("section#" + i + " render(" + sections[i].length + "字)", performance.now() - t0);
    }
    nextNodes.push(node);
    nextHash.push(h);
    if ((i & 15) === 15) await new Promise((r) => setTimeout(r)); // 每 16 段让出主线程
  }

  if (token !== renderToken) return;
  const savedScroll = container.scrollTop; // 重渲染前记录滚动位置，渲染后还原，避免回到顶部
  const _tr = performance.now();
  container.replaceChildren(...nextNodes);
  container._secNodes = nextNodes;
  container._secHash = nextHash;
  finalizeTOC(container);
  perfSelf("preview: replaceChildren+finalizeTOC", performance.now() - _tr);
  perfStage("finalizeTOC done");
  container.scrollTop = savedScroll;
  perfStage("mermaid render start");
  await renderMermaidIn(container); // 渲染 Mermaid 图（异步，不阻塞主渲染）
  perfStage("mermaid render done");
  perfStage("renderMarkdownInto done(" + sections.length + " sections)");
  perfSelf("renderMarkdownInto(总 " + (md || "").length + "字)", performance.now() - _t0);
}
