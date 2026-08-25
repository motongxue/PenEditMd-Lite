// 极简 ZIP 写入器（纯 Node，无第三方依赖）。
// 仅支持 STORE（未压缩）模式——Word / Excel / EPUB 阅读器均接受未压缩条目，
// 这样可避免引入 deflate 实现，且对 docx/epub 导出 100% 合法。
//
// API: createZip(entries) -> Buffer
//   entries: [{ name: string, data: Buffer|string, store?: bool }]
//   - name 使用正斜杠路径（如 "word/document.xml"）
//   - data 为 Buffer 或 字符串（按 UTF-8 处理）
//   - store 字段保留以兼容调用方，本实现统一以 STORE 写出
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function createZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries || []) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf-8");
    const name = Buffer.from(entry.name, "utf-8");
    const crc = crc32(data);
    const size = data.length;

    // local file header (30 bytes)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // 本地文件头签名
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // general purpose flag
    local.writeUInt16LE(0, 8); // method = 0 (store)
    local.writeUInt16LE(0, 10); // mod time
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    chunks.push(local, name, data);

    // central directory header (46 bytes)
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); // 中央目录头签名
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0, 8); // flag
    cd.writeUInt16LE(0, 10); // method
    cd.writeUInt16LE(0, 12); // mod time
    cd.writeUInt16LE(0, 14); // mod date
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20); // compressed size
    cd.writeUInt32LE(size, 24); // uncompressed size
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42); // local header offset
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const total = (entries || []).length;

  // end of central directory record (22 bytes)
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with cd
  end.writeUInt16LE(total, 8); // entries in this disk
  end.writeUInt16LE(total, 10); // total entries
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuf, end]);
}

module.exports = { createZip };
