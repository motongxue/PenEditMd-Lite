/**
 * imageStore.js — base64 图片占位符管理
 *
 * 问题：Word/PDF 转出来的图片是 data:image/...;base64,... 内嵌在 Markdown 里，
 * 一个高清图就是几万字符，把源码区撑爆，无法编辑。
 *
 * 解决：在源码编辑区把 base64 地址折叠成短占位符 @img:{id}:{filename}，
 * 但实际存储、导出、渲染、复制时仍使用完整 base64。
 *
 * 规则：
 * - 占位符格式：@img:{id}:{filename}，id 是自增数字，filename 从原 alt 或默认名推导
 * - shrink(md): 把 md 中所有 ![alt](data:image/...;base64,...) 替换为 ![alt](@img:id:filename)
 * - expand(md): 把占位符还原为完整 base64
 * - 映射在应用运行期间保存在内存，不持久化（md 本身仍包含完整 base64）
 */

const PLACEHOLDER_RE = /!\[([^\]]*)\]\(@img:(\d+):([^)]+)\)/g;
const BASE64_IMG_RE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9+.-]+;base64,[a-zA-Z0-9+/=]+)\)/g;

let nextId = 0;
const map = new Map(); // id -> { dataUri, filename }

// 图片是否相对「上次快照」发生变化。未变化时正文频繁自动保存无需再搬运整包 base64，
// 否则每张截图几 MB，每次停手都把全部图片经 IPC 序列化发往主进程，主线程被堵 ~500ms（见 #打字卡顿）。
let imagesDirty = true;

function extFromMime(mime) {
  const m = mime.match(/image\/(\w+)/);
  if (!m) return "png";
  let ext = m[1];
  if (ext === "jpeg") ext = "jpg";
  return ext;
}

function makeFilename(alt, dataUri) {
  if (alt) return alt.replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
  const mime = dataUri.match(/data:image\/([^;]+)/)?.[1] || "png";
  return `image.${extFromMime(`image/${mime}`)}`;
}

export function resetImageStore() {
  nextId = 0;
  map.clear();
  imagesDirty = true;
}

// 图片是否相对「上次快照」发生变化。未变化时正文频繁自动保存无需再搬运整包 base64，
// 否则每张截图几 MB，每次停手都把全部图片经 IPC 序列化发往主进程，主线程被堵 ~500ms（见 #打字卡顿）。

/** 会话恢复用：把内存中的图片映射导出为可序列化的快照。
 *  未变化（imagesDirty=false）时返回 null，由主进程保留磁盘上已有的图片，
 *  从而避免「每次打字都重写整包 base64」造成的主线程阻塞。 */
export function snapshotImages() {
  if (!imagesDirty) return null;
  imagesDirty = false;
  return {
    nextId,
    images: Array.from(map.entries()).map(([id, item]) => ({ id, filename: item.filename, dataUri: item.dataUri })),
  };
}

/** 会话恢复用：从快照还原图片映射（与 @img:id:name 占位符对应） */
export function restoreImages(snapshot) {
  if (!snapshot) return;
  if (typeof snapshot.nextId === "number") nextId = snapshot.nextId;
  if (Array.isArray(snapshot.images)) {
    snapshot.images.forEach(({ id, filename, dataUri }) => {
      map.set(Number(id), { dataUri, filename });
    });
  }
  imagesDirty = false; // 刚从磁盘恢复，尚未改动，无需立刻回写
}

export function registerImage(dataUri, alt = "") {
  for (const [id, item] of map) {
    if (item.dataUri === dataUri) return `@img:${id}:${item.filename}`;
  }
  const filename = makeFilename(alt, dataUri);
  const id = nextId++;
  map.set(id, { dataUri, filename });
  imagesDirty = true; // 新增图片：下次快照需重新搬运
  return `@img:${id}:${filename}`;
}

export function resolveImage(placeholder) {
  const m = placeholder.match(/^@img:(\d+):/);
  if (!m) return null;
  const item = map.get(Number(m[1]));
  return item ? item.dataUri : null;
}

/** 按 id 取回完整 base64（点击预览占位块时按需展开，避免一次性解码全部图片） */
export function getImageById(id) {
  const item = map.get(Number(id));
  return item ? item.dataUri : null;
}

/**
 * 替换指定 id 的图片数据（右键「替换图片」用）。
 * 占位符 @img:{id}:name 不变，只是映射指向新的 base64，
 * 因此正文 Markdown 无需改动即可跨重渲染 / 会话恢复持久生效。
 * @returns {boolean} 是否成功（id 存在）
 */
export function replaceImage(id, dataUri, filename) {
  const numId = Number(id);
  if (!map.has(numId)) return false;
  map.set(numId, {
    dataUri,
    filename: filename || map.get(numId).filename || makeFilename("", dataUri),
  });
  imagesDirty = true; // 图片数据被替换，下次快照需重新搬运
  return true;
}

/**
 * 轻量文档判定：是否把 @img: 图片直接内嵌显示（不折叠成占位块、不要求点击展开）。
 * 真正的性能成本来自"解码进 DOM 的总字节数"，所以以「图片总 base64 字符串长度
 * ≤ INLINE_MAX_BYTES」为唯一判定：
 *  - 图片少 ⇒ 总字节小 ⇒ 内嵌；
 *  - 文档小 ⇒ 图片总字节通常也小 ⇒ 内嵌；
 *  - 只有 1 张却有 30MB 这种极端大图 ⇒ 超过阈值 ⇒ 仍折叠（点击才展开）。
 * 该值在渲染前对当前文档的 @img 节点求和，O(图片数)，开销可忽略。
 */
export const INLINE_MAX_BYTES = 1.5 * 1024 * 1024; // ~1.1MB 二进制

export function shouldInlineImages(root) {
  if (!root || !root.querySelectorAll) return true;
  let total = 0;
  let hasImg = false;
  root.querySelectorAll('img[src^="@img:"]').forEach((img) => {
    const m = (img.getAttribute("src") || "").match(/^@img:(\d+):/);
    if (!m) return;
    hasImg = true;
    const data = getImageById(Number(m[1]));
    if (data) total += data.length;
  });
  return hasImg && total <= INLINE_MAX_BYTES;
}

/**
 * 基于整篇 Markdown（含 @img: 占位符）的全局轻量判定：图片总 base64 字节 ≤ 阈值则内嵌。
 * 与 shouldInlineImages(DOM) 等价，但用于「分块增量渲染」入口——阈值必须按全篇算，
 * 不能按单段算，否则大文档里某段单独小会被误判为内嵌。在入口算一次后传进各段。
 */
export function isDocImageLight(md) {
  if (!md || md.indexOf("@img:") === -1) return true; // 无图：无所谓内嵌
  let total = 0;
  const re = /@img:(\d+):/g;
  let m;
  while ((m = re.exec(md))) {
    const data = getImageById(Number(m[1]));
    if (data) total += data.length;
  }
  return total <= INLINE_MAX_BYTES;
}

export function shrinkMarkdown(md) {
  if (!md) return "";
  // 短路：没有 base64 图片时直接返回，避免对整个大文档做正则扫描（大文档每键都走这里）
  if (md.indexOf("data:image/") === -1) return md;
  return md.replace(BASE64_IMG_RE, (match, alt, dataUri) => {
    const ph = registerImage(dataUri, alt);
    return `![${alt}](${ph})`;
  });
}

export function expandMarkdown(md) {
  if (!md) return "";
  // 短路：没有 @img: 占位符时直接返回（markitdown 转换出的文档是完整 base64，无需还原）
  if (md.indexOf("@img:") === -1) return md;
  return md.replace(PLACEHOLDER_RE, (match, alt, idStr, filename) => {
    const item = map.get(Number(idStr));
    if (!item) return match; // 丢失映射则保留占位符，避免数据丢失
    return `![${alt}](${item.dataUri})`;
  });
}

export function extractImages(md) {
  const out = [];
  md.replace(BASE64_IMG_RE, (match, alt, dataUri) => out.push({ alt, dataUri }));
  return out;
}
