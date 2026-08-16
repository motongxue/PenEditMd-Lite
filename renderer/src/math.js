/**
 * math.js — 公式（KaTeX）支持
 *
 * 设计（对齐 Typora）：
 * - 块级公式：  $$  tex  $$    渲染为居中的 .math-block（contenteditable=false，双击编辑源码）
 * - 行内公式：  $   tex  $     渲染为 .math-inline（contenteditable=false，双击编辑源码）
 * - marked 扩展把 $$...$$ / $...$ 先转成带 data-tex 的占位节点；因为 DOMPurify 会净化，
 *   这里不直接输出 KaTeX HTML，而是通过 decorateMath() 在净化之后再把占位换成真实 KaTeX。
 *   这样既能规避 sanitize 把 KaTeX/MathML 误删，又能保证数据-tex 一直保留，
 *   turndown 导出时直接读 data-tex 还原成 $$...$$ / $...$。
 * - 导出 HTML 时，getKatexExportCss() 把 KaTeX 的 CSS 与字体(woff2)以 base64 内联，
 *   生成完全自包含、可离线打开的文件。
 */

import katex from "katex";
import "katex/dist/katex.min.css";
import { perfSlow } from "./perf.js";

// 占位符：净化后一定存在，decorateMath 时整体替换为 KaTeX
const PLACEHOLDER = "​MATH​";

function escAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 用 KaTeX 把 LaTeX 渲染成 HTML 字符串（出错也不崩，显示红字） */
export function renderKatex(tex, displayMode) {
  const t0 = performance.now();
  let out;
  try {
    out = katex.renderToString(tex || "", {
      displayMode: !!displayMode,
      throwOnError: false,
      output: "htmlAndMathml",
    });
  } catch (e) {
    out = `<span class="math-error">${escAttr(tex)}</span>`;
  }
  // KaTeX 对病态/超长公式可能卡数秒甚至更久（同步、不主动让出主线程）——这正是「单帧几十秒」的可疑来源
  perfSlow("katex(" + (tex || "").length + "字)", performance.now() - t0, 200);
  return out;
}

/** marked 扩展：把 $$...$$ 与 $...$ 转成带 data-tex 的占位节点 */
export const MATH_EXTENSIONS = {
  extensions: [
    {
      name: "blockMath",
      level: "block",
      // 关键：不能提供 start()。start 返回 indexOf("$$") 会让 marked 把段落从任意
      // "$$" 处（包括行内代码 `$$`、标题里的 $$）裁开，段落被切碎、块级公式边界错乱。
      // 去掉 start 后，block 阶段扩展 tokenizer 先于 paragraph 执行：
      // 只要 $$ 独立成块（标准 Markdown 要求块级元素前有空行），行首锚定即可正确匹配。
      tokenizer(src) {
        // 块级公式：开闭 $$ 都独占一行（可选前导空白），支持跨行内容
        const m = /^[ \t]*\$\$[ \t]*\n([\s\S]*?)\n[ \t]*\$\$/.exec(src);
        if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
        // 兼容单行形式：$$x^2$$
        const m2 = /^[ \t]*\$\$(.+?)\$\$[ \t]*$/.exec(src);
        if (m2) return { type: "blockMath", raw: m2[0], text: m2[1].trim() };
      },
      renderer(token) {
        return `<div class="math-block" data-tex="${escAttr(token.text)}">${PLACEHOLDER}</div>\n`;
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start(src) {
        const i = src.indexOf("$");
        return i < 0 ? undefined : i;
      },
      // 收紧规则（对齐 Typora / CommonMark 数学扩展的通行做法）：
      //   1) 开定界符后不能紧跟空白或 $   → 排除 "$ x$"、"$$"
      //   2) 闭定界符前不能是空白        → 排除 "$x $"
      //   3) 闭定界符后不能紧跟数字      → 排除货币写法 "$100 到 $200"
      tokenizer(src) {
        const m = /^\$(?![\s$])((?:\\.|[^$\n])*?)(?<!\s)\$(?!\d)/.exec(src);
        if (m && m[1].trim()) return { type: "inlineMath", raw: m[0], text: m[1].trim() };
      },
      renderer(token) {
        return `<span class="math-inline" data-tex="${escAttr(token.text)}">${PLACEHOLDER}</span>`;
      },
    },
  ],
};

/**
 * 给 marked 注册公式扩展。marked 是全局单例（richtext.js 与 preview.js 共用），
 * 重复 use 会把 tokenizer 压进数组两次（浪费且行为诡异），这里用标记保证只注册一次。
 */
let _mathRegistered = false;
export function useMathExtensions(marked) {
  if (_mathRegistered) return;
  _mathRegistered = true;
  marked.use(MATH_EXTENSIONS);
}

/** 把容器里（已 sanitize）的占位节点换成真实 KaTeX，并设为不可编辑原子节点 */
export function decorateMath(container) {
  if (!container) return;
  container.querySelectorAll(".math-block, .math-inline").forEach((node) => {
    if (node.querySelector(":scope > .math-render")) return; // 已渲染过
    const tex = node.getAttribute("data-tex") || "";
    node.setAttribute("contenteditable", "false");
    const render = document.createElement("span");
    render.className = "math-render";
    render.innerHTML = renderKatex(tex, node.classList.contains("math-block"));
    node.innerHTML = "";
    node.appendChild(render);
    node.classList.toggle("math-empty", !tex.trim());
  });
}

/** 给 turndown 注册公式规则：直接读 data-tex 还原成 Markdown */
export function mathTurndownRules(turndown) {
  turndown.addRule("blockMath", {
    filter: (n) => n.nodeName === "DIV" && n.classList.contains("math-block"),
    replacement: (_c, n) => "\n$$\n" + (n.getAttribute("data-tex") || "") + "\n$$\n",
  });
  turndown.addRule("inlineMath", {
    filter: (n) => n.nodeName === "SPAN" && n.classList.contains("math-inline"),
    replacement: (_c, n) => "$" + (n.getAttribute("data-tex") || "") + "$",
  });
}

/* ---------- 导出用：把 KaTeX 的 CSS + 字体内联成自包含字符串 ---------- */
function base64FromBuffer(buf) {
  let bin = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

let _katexCssPromise = null;
/** 返回内联了字体的 KaTeX CSS（用于导出的独立 HTML）。失败时返回纯 CSS（无字体）。 */
export function getKatexExportCss() {
  if (_katexCssPromise) return _katexCssPromise;
  _katexCssPromise = (async () => {
    try {
      const mod = await import("katex/dist/katex.min.css?inline");
      let css = mod.default || "";
      // 注意：import.meta.glob 不支持裸包名，必须用相对路径指到 node_modules
      const fontMap = import.meta.glob("../../node_modules/katex/dist/fonts/*.woff2", {
        query: "?url",
        import: "default",
        eager: true,
      });
      for (const [p, url] of Object.entries(fontMap)) {
        const name = p.split("/").pop();
        const re = new RegExp(
          "url\\(['\"]?[^'\")]*" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "['\"]?\\)"
        );
        if (!re.test(css)) continue;
        try {
          const buf = await fetch(url).then((r) => r.arrayBuffer());
          const b64 = base64FromBuffer(buf);
          css = css.replace(re, `url(data:font/woff2;base64,${b64})`);
        } catch (_) {
          /* 字体内联失败不影响结构 */
        }
      }
      return css;
    } catch (e) {
      return "";
    }
  })();
  return _katexCssPromise;
}
