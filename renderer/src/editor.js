/**
 * editor.js — 编辑器统一入口（源码 / 富文本 双模式）
 *
 * 对外暴露一致 API：setValue/getValue/focus 和各种格式命令。
 * 内部根据 type 选择：
 * - source: 原生 <textarea>，Markdown 源码编辑；base64 图片用 imageStore 折叠显示。
 * - richtext: contenteditable div，类 Word 所见即所得；Markdown ↔ HTML 双向转换。
 */

import { shrinkMarkdown } from "./imageStore.js";
import { createRichEditor } from "./richtext.js";
import { status } from "./status.js";
import { showPrompt, showChoiceModal, openLocalImageFile } from "./prompt.js";
import { matchAction } from "./settings.js";
import {
  locateTable,
  formatTable,
  tableOp as mdTableOp,
  cellCaretOffset,
} from "./tableMd.js";

export function createEditor({ type = "richtext", ta, rich, onChange, onInput }) {
  return type === "source"
    ? createSourceEditor({ ta, onChange })
    : createRichEditor({ el: rich, onChange, onInput });
}

/**
 * 源码编辑器：基于原生 textarea，带 base64 图片占位符折叠。
 */
function createSourceEditor({ ta, onChange, onInput }) {
  let composing = false; // 中文输入法组合中：组词期不触发 triggerChange，避免每个拼音字母都跑 onEditorChange 链
  function triggerChange() {
    // 直接传当前（已折叠为 @img: 占位符的）源码。
    // 千万不要在这里 expandMarkdown：一旦展开成 11MB base64，
    // 每次按键 / 每个格式命令都会触发 11MB 重渲染，导致卡顿。
    // 仅在导出 / 复制时（main.js）才按需展开。
    onChange?.(ta.value);
  }

  function sel() {
    return { start: ta.selectionStart, end: ta.selectionEnd };
  }
  function setSel(s, e) {
    ta.focus();
    ta.setSelectionRange(s, e);
  }
  function replaceRange(start, end, text) {
    ta.focus();
    ta.setSelectionRange(start, end);
    document.execCommand("insertText", false, text);
  }

  function wrap(before, after = "", placeholder = "") {
    const { start, end } = sel();
    const selected = ta.value.slice(start, end) || placeholder;
    replaceRange(start, end, before + selected + after);
    const ns = start + before.length;
    setSel(ns, ns + selected.length);
    triggerChange();
  }

  function linePrefix(prefix) {
    const { start, end } = sel();
    const val = ta.value;
    const ls = val.lastIndexOf("\n", start - 1) + 1;
    let le = val.indexOf("\n", end);
    if (le === -1) le = val.length;
    const block = val.slice(ls, le);
    const newBlock = block
      .split("\n")
      .map((l) => (l.startsWith(prefix) ? l : l.trim() === "" ? prefix + l : prefix + l))
      .join("\n");
    replaceRange(ls, le, newBlock);
    setSel(ls, ls + newBlock.length);
    triggerChange();
  }

  function toggleHeading(level) {
    const { start } = sel();
    const val = ta.value;
    const ls = val.lastIndexOf("\n", start - 1) + 1;
    let le = val.indexOf("\n", start);
    if (le === -1) le = val.length;
    let line = val.slice(ls, le);
    const m = line.match(/^(#{1,6})\s?(.*)$/);
    if (m && m[1].length === level) {
      line = m[2];
    } else {
      line = "#".repeat(level) + " " + (m ? m[2] : line);
    }
    replaceRange(ls, le, line);
    setSel(ls, ls + line.length);
    triggerChange();
  }

  // 设定标题级别（下拉选择用）：level 1-6 设对应标题，0 取消标题变正文。
  // 与 toggleHeading 不同，这里"选中即设定"，再次点同级不会取消，符合下拉交互习惯。
  function setHeading(level) {
    const { start } = sel();
    const val = ta.value;
    const ls = val.lastIndexOf("\n", start - 1) + 1;
    let le = val.indexOf("\n", start);
    if (le === -1) le = val.length;
    let line = val.slice(ls, le);
    const m = line.match(/^(#{1,6})\s?(.*)$/);
    const content = m ? m[2] : line;
    line = level >= 1 && level <= 6 ? "#".repeat(level) + " " + content : content;
    replaceRange(ls, le, line);
    setSel(ls, ls + line.length);
    triggerChange();
  }

  function insertBlock(text) {
    const { start } = sel();
    const val = ta.value;
    const before = val.slice(0, start);
    const after = val.slice(start);
    const lead = before && !before.endsWith("\n") ? "\n" : "";
    const trail = after && !after.startsWith("\n") ? "\n" : "";
    const insert = lead + text + trail;
    replaceRange(start, start, insert);
    const pos = start + insert.length;
    setSel(pos, pos);
    triggerChange();
  }

  function insertLink() {
    const { start, end } = sel();
    const text = ta.value.slice(start, end) || "链接文字";
    replaceRange(start, end, `[${text}](url)`);
    setSel(start + text.length + 3, start + text.length + 6);
    triggerChange();
  }

  /** 插入图片：先选「图片链接」或「本地图片」，再分别走 URL 输入 / 文件选择器(base64) */
  async function insertImage() {
    const { start, end } = sel();
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
      url = await showPrompt({ title: "插入图片", placeholder: "图片地址(URL 或 data:image/...;base64,)" });
    } else {
      url = await new Promise((resolve) => openLocalImageFile((dataUrl) => resolve(dataUrl)));
    }
    if (!url) return;
    ta.focus();
    ta.setSelectionRange(start, end);
    replaceRange(start, end, `![alt](${url})`);
    setSel(start + 2, start + 5);
    triggerChange();
  }

  /** 源码模式：插入 ``` 代码块围栏（无语言弹窗，语言直接写在围栏上） */
  function insertCodeBlock(defaultLang = "") {
    const { start, end } = sel();
    const selected = ta.value.slice(start, end);
    const body = selected.includes("\n") ? selected : "";
    const block = "```\n" + body + "\n```";
    replaceRange(start, end, block);
    const pos = start + block.length;
    setSel(pos, pos);
    triggerChange();
  }

  function insertTable() {
    insertBlock("| 列1 | 列2 |\n| --- | --- |\n| 单元格 | 单元格 |\n| 单元格 | 单元格 |\n");
  }

  /**
   * 表格增删行列 / 自动格式化（源码模式）。
   * 光标必须落在某个 Markdown 表格块内；操作完成后整块会重新对齐竖线，
   * 并把光标放回目标单元格，方便连续操作。
   * @param {'rowAbove'|'rowBelow'|'colLeft'|'colRight'|'delRow'|'delCol'|'delTable'|'format'} op
   */
  function tableOp(op) {
    const { start } = sel();
    const val = ta.value;
    const t = locateTable(val, start);
    if (!t) {
      status("请先把光标放到表格内，再执行表格操作");
      return;
    }

    if (op === "delTable") {
      // 连同表格块后面的换行一起删掉，避免留下空行
      const end = val[t.end] === "\n" ? t.end + 1 : t.end;
      replaceRange(t.start, end, "");
      setSel(t.start, t.start);
      triggerChange();
      status("已删除表格");
      return;
    }

    const res =
      op === "format"
        ? { lines: formatTable(t.lines), rowIdx: t.rowIdx, colIdx: t.colIdx }
        : mdTableOp(t.lines, op, t.rowIdx, t.colIdx);

    if (res.error) {
      status(res.error);
      return;
    }

    const newText = res.lines.join("\n");
    replaceRange(t.start, t.end, newText);

    // 光标定位回目标单元格
    let offset = 0;
    for (let i = 0; i < res.rowIdx && i < res.lines.length; i++) offset += res.lines[i].length + 1;
    const line = res.lines[Math.min(res.rowIdx, res.lines.length - 1)] || "";
    const pos = t.start + offset + cellCaretOffset(line, res.colIdx);
    setSel(pos, pos);
    triggerChange();
    status(op === "format" ? "表格已格式化" : "表格已更新");
  }

  function toggleCode() {
    const { start, end } = sel();
    const selected = ta.value.slice(start, end);
    if (selected.includes("\n")) wrap("```\n", "\n```");
    else wrap("`", "`", "代码");
  }

  function indent(extra) {
    const { start, end } = sel();
    const val = ta.value;
    const ls = val.lastIndexOf("\n", start - 1) + 1;
    let le = val.indexOf("\n", end);
    if (le === -1) le = val.length;
    const block = val.slice(ls, le);
    const newBlock = block
      .split("\n")
      .map((l) => (extra ? "  " + l : l.replace(/^ {1,2}/, "")))
      .join("\n");
    replaceRange(ls, le, newBlock);
    setSel(ls, ls + newBlock.length);
    triggerChange();
  }

  function listContinue(e) {
    const { start } = sel();
    const val = ta.value;
    const ls = val.lastIndexOf("\n", start - 1) + 1;
    const line = val.slice(ls, start);
    const m = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (!m) return false;
    const prefix = m[1] + m[2] + " ";
    if (m[3].trim() === "") {
      e.preventDefault();
      replaceRange(ls, start, "");
      triggerChange();
      return true;
    }
    e.preventDefault();
    replaceRange(start, start, "\n" + prefix);
    triggerChange();
    return true;
  }

  function onKeydown(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      // 组合键可自定义（设置面板）；命中则本层处理并 stopPropagation
      if (matchAction(e, "bold")) return e.preventDefault(), e.stopPropagation(), wrap("**", "**", "粗体");
      if (matchAction(e, "italic")) return e.preventDefault(), e.stopPropagation(), wrap("*", "*", "斜体");
      if (matchAction(e, "link")) return e.preventDefault(), e.stopPropagation(), insertLink();
      if (matchAction(e, "inlineCode")) return e.preventDefault(), e.stopPropagation(), toggleCode();
    }
    if (e.key === "Tab") {
      e.preventDefault();
      indent(!e.shiftKey);
      return;
    }
    if (e.key === "Enter" && listContinue(e)) return;
  }

  // 防止 createEditor 被反复调用时在持久的 textarea 上重复绑定事件（同 richtext 的处理）。
  // 每次绑定前先移除上一次的同类型处理器，避免出现两份监听器。
  const srcBound = (ta.__srcBound = ta.__srcBound || {});
  const onSrc = (type, handler) => {
    if (srcBound[type]) ta.removeEventListener(type, srcBound[type]);
    srcBound[type] = handler;
    ta.addEventListener(type, handler);
  };
  onSrc("input", () => {
    onInput?.(); // 始终上报输入时刻（含组词中）：供预览渲染的「空闲闸门」正确生效
    if (composing) return; // 组词中：不触发 triggerChange，等 compositionend 统一处理
    triggerChange();
  });
  onSrc("compositionstart", () => { composing = true; window.__peneditComposing = true; });
  onSrc("compositionend", () => {
    composing = false;
    window.__peneditComposing = false;
    triggerChange();
  });
  onSrc("keydown", onKeydown);

  return {
    type: "source",
    el: ta,
    getValue: () => ta.value, // 已折叠为占位符的工作副本，体积小、编辑/预览都快
    setValue: (v) => {
      ta.value = shrinkMarkdown(v || "");
    },
    focus: () => ta.focus(),

    /* ---- 右键菜单用到的基础能力 ---- */
    /** 当前选中的纯文本 */
    getSelectionText: () => ta.value.slice(ta.selectionStart, ta.selectionEnd),
    /** 在光标处插入文本（走 execCommand 保留原生撤销栈） */
    insertText: (text) => {
      const { start, end } = sel();
      replaceRange(start, end, text);
      triggerChange();
    },
    /** 在光标处插入图片占位标记【插入图片】，并选中"图片"两字便于直接改写描述 */
    insertImagePlaceholder: () => {
      const { start, end } = sel();
      const token = "【插入图片】";
      replaceRange(start, end, token);
      const nameStart = start + "【插入".length; // 定位到"图片"起始
      setSel(nameStart, nameStart + "图片".length);
      triggerChange();
    },
    /** 删除选中内容 */
    deleteSelection: () => {
      const { start, end } = sel();
      if (start === end) return;
      replaceRange(start, end, "");
      triggerChange();
    },
    selectAll: () => {
      ta.focus();
      ta.select();
    },
    /** 选中光标所在整行（右键「选中当前行」） */
    selectLine: () => {
      const { start } = sel();
      const v = ta.value;
      const ls = v.lastIndexOf("\n", start - 1) + 1;
      let le = v.indexOf("\n", start);
      if (le === -1) le = v.length;
      setSel(ls, le);
    },
    /** 光标是否落在 Markdown 表格内（决定右键菜单是否显示表格操作） */
    inTable: () => !!locateTable(ta.value, ta.selectionStart),
    /** 右键时把光标移到点击位置——textarea 由浏览器自动处理，这里无需额外动作 */
    caretFromPoint: () => {},

    // 查找替换用：按字符区间就地替换（走 execCommand 以保留原生撤销栈，
    // 也避免大文档整体 setValue 造成的重排卡顿）
    replaceRangeAt: (s, e, text) => {
      replaceRange(s, e, text);
      const pos = s + text.length;
      setSel(pos, pos);
      triggerChange();
    },
    wrap,
    linePrefix,
    toggleHeading,
    setHeading,
    insertBlock,
    insertLink,
    insertImage,
    insertTable,
    insertCodeBlock,
    tableOp,
    toggleCode,
    indent,
    undo: () => {
      ta.focus();
      document.execCommand("undo");
      triggerChange();
    },
    redo: () => {
      ta.focus();
      document.execCommand("redo");
      triggerChange();
    },
  };
}
