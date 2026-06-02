/**
 * Minimal ZIP writer — STORE method only (no DEFLATE). Used by the
 * "Download current state" bundle on Home. Pure browser code, no deps.
 *
 * Format reference: PKWARE APPNOTE.TXT 6.3.10, sections 4.3 (local file
 * header), 4.4 (central directory), 4.5 (end-of-central-directory). Each
 * file produces one local header + raw data + one central-directory entry;
 * the archive ends with one EOCD record.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const TEXT_ENCODER = new TextEncoder();

function dosDateTime(date) {
  const dt = date instanceof Date ? date : new Date();
  const dosTime =
    ((dt.getHours() & 0x1f) << 11) |
    ((dt.getMinutes() & 0x3f) << 5) |
    ((dt.getSeconds() >>> 1) & 0x1f);
  const dosDate =
    (((dt.getFullYear() - 1980) & 0x7f) << 9) |
    (((dt.getMonth() + 1) & 0x0f) << 5) |
    (dt.getDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Build a ZIP archive (STORE method) from a list of files.
 *
 * @param {{name: string, data: string | Uint8Array}[]} files
 * @returns {Uint8Array}
 */
export function makeZip(files) {
  const { dosTime, dosDate } = dosDateTime(new Date());
  const parts = [];
  const centralEntries = [];
  let offset = 0;

  for (const f of files) {
    const nameBytes = TEXT_ENCODER.encode(f.name);
    const dataBytes = typeof f.data === "string" ? TEXT_ENCODER.encode(f.data) : f.data;
    const crc = crc32(dataBytes);
    const size = dataBytes.length;

    // Local file header: 30 bytes fixed + filename.
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);              // local file header signature
    lv.setUint16(4, 20, true);                      // version needed
    lv.setUint16(6, 0x0800, true);                  // bit 11 = UTF-8 filename
    lv.setUint16(8, 0, true);                       // method = STORE
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);                   // compressed size
    lv.setUint32(22, size, true);                   // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);                      // extra field length
    local.set(nameBytes, 30);

    parts.push(local);
    parts.push(dataBytes);

    // Central directory entry: 46 bytes fixed + filename.
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);              // central dir signature
    cv.setUint16(4, 20, true);                      // version made by
    cv.setUint16(6, 20, true);                      // version needed
    cv.setUint16(8, 0x0800, true);                  // bit 11 = UTF-8 filename
    cv.setUint16(10, 0, true);                      // method = STORE
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);                      // extra field length
    cv.setUint16(32, 0, true);                      // file comment length
    cv.setUint16(34, 0, true);                      // disk number start
    cv.setUint16(36, 0, true);                      // internal attrs
    cv.setUint32(38, 0, true);                      // external attrs
    cv.setUint32(42, offset, true);                 // local header offset
    central.set(nameBytes, 46);
    centralEntries.push(central);

    offset += local.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of centralEntries) {
    parts.push(c);
    centralSize += c.length;
  }

  // End-of-central-directory record (22 bytes, no comment).
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);                // EOCD signature
  ev.setUint16(4, 0, true);                         // disk number
  ev.setUint16(6, 0, true);                         // disk with central dir
  ev.setUint16(8, centralEntries.length, true);
  ev.setUint16(10, centralEntries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true);                        // comment length
  parts.push(eocd);

  const totalSize = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalSize);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

/** Trigger a browser download of `bytes` as a file. */
export function downloadBlob(bytes, filename, mime = "application/octet-stream") {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
