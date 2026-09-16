'use strict';
// Minimal streaming ZIP writer — STORE (no compression) only, Node stdlib only.
//
// Replaces the `archiver` dependency for download-as-zip, POST /api/files/zip
// and POST /api/files/batch-zip. Portable by construction: pure JS + `fs`,
// no native modules, no shell-outs, no platform branches. Zip entry names
// always use `/` separators (normalized on write, so Windows backslashes can
// never leak into the archive).
//
// Format notes (classic, non-Zip64 — callers cap totals at 1GB / 50000
// entries, and entry counts stay under the 65535 EOCD limit):
// - Every file entry uses a data descriptor (general-purpose flag bit 3), so
//   file bytes stream straight from disk with no pre-stat: the size seen
//   during collection is never trusted at write time (TOCTOU-safe).
// - Filenames are UTF-8 with the UTF-8 flag (bit 11) set.
// - Directories are zero-length entries with a trailing '/'.
// - Timestamps are DOS dates clamped to >= 1980 (zip epoch).

const fs = require('fs');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const SIG_DESCRIPTOR = 0x08074b50;
const METHOD_STORE = 0;
const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const MADE_BY = 0x031e; // Unix host, version 2.0
const NEED_EXTRACT = 20; // version 2.0
const MODE_FILE = 0o644 << 16;
const MODE_DIR = (0o755 << 16) | 0x10;

// CRC-32 (ISO 3309), table-driven and incremental.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32Update(crc, buf) {
  crc = (crc ^ -1) >>> 0;
  for (let i = 0; i < buf.length; i++) crc = (CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  let year = date.getFullYear();
  if (year < 1980) year = 1980;
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | (date.getDate() & 0x1f);
  return { time, date: day };
}

// Zip names use forward slashes on every platform.
function zipName(name) {
  return String(name).replace(/\\/g, '/');
}

function abortError() {
  const e = new Error('zip write aborted');
  e.aborted = true;
  return e;
}

class ZipStoreWriter {
  // `out` is any writable stream (file stream, HTTP response, …). The writer
  // never ends it — the caller does, after writeAll() resolves.
  constructor(out) {
    this.out = out;
    this.offset = 0;
    this.central = [];
    this.aborted = false;
    this.outError = null;
    this.now = dosDateTime(new Date());
    try {
      out.on('error', err => { if (!this.outError) this.outError = err; });
    } catch {}
  }

  abort() {
    this.aborted = true;
  }

  _check() {
    if (this.aborted) throw abortError();
    if (this.outError) throw this.outError;
  }

  async _write(buf) {
    this._check();
    this.offset += buf.length;
    let ok = false;
    try {
      ok = this.out.write(buf);
    } catch (e) {
      throw e;
    }
    if (ok) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        try { this.out.removeListener('drain', onDrain); } catch {}
        try { this.out.removeListener('error', onError); } catch {}
        try { this.out.removeListener('close', onClose); } catch {}
      };
      const onDrain = () => { cleanup(); resolve(); };
      const onError = err => { cleanup(); reject(err); };
      const onClose = () => { cleanup(); reject(new Error('zip output closed')); };
      try {
        this.out.once('drain', onDrain);
        this.out.once('error', onError);
        this.out.once('close', onClose);
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    this._check();
  }

  _localHeader(nameBuf, flags, crc, compSize, uncompSize) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(SIG_LOCAL, 0);
    h.writeUInt16LE(NEED_EXTRACT, 4);
    h.writeUInt16LE(flags, 6);
    h.writeUInt16LE(METHOD_STORE, 8);
    h.writeUInt16LE(this.now.time, 10);
    h.writeUInt16LE(this.now.date, 12);
    h.writeUInt32LE(crc >>> 0, 14);
    h.writeUInt32LE(compSize >>> 0, 18);
    h.writeUInt32LE(uncompSize >>> 0, 22);
    h.writeUInt16LE(nameBuf.length, 26);
    h.writeUInt16LE(0, 28); // extra length
    return h;
  }

  async addDirectory(name) {
    let n = zipName(name);
    if (!n.endsWith('/')) n += '/';
    const nameBuf = Buffer.from(n, 'utf8');
    const headerOffset = this.offset;
    await this._write(this._localHeader(nameBuf, FLAG_UTF8, 0, 0, 0));
    await this._write(nameBuf);
    this.central.push({ nameBuf, flags: FLAG_UTF8, crc: 0, size: 0, offset: headerOffset, external: MODE_DIR });
  }

  async addFile(name, fullPath) {
    const n = zipName(name);
    const nameBuf = Buffer.from(n, 'utf8');
    const flags = FLAG_UTF8 | FLAG_DESCRIPTOR;
    const headerOffset = this.offset;
    // Sizes/CRC unknown until streamed → zeros here, real values follow in
    // the data descriptor after the file bytes.
    await this._write(this._localHeader(nameBuf, flags, 0, 0, 0));
    await this._write(nameBuf);
    let crc = 0;
    let size = 0;
    const rs = fs.createReadStream(fullPath);
    try {
      for await (const chunk of rs) {
        if (this.aborted) throw abortError();
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        crc = crc32Update(crc, buf);
        size += buf.length;
        await this._write(buf);
      }
    } catch (e) {
      try { rs.destroy(); } catch {}
      throw e;
    }
    const d = Buffer.alloc(16);
    d.writeUInt32LE(SIG_DESCRIPTOR, 0);
    d.writeUInt32LE(crc >>> 0, 4);
    d.writeUInt32LE(size >>> 0, 8);
    d.writeUInt32LE(size >>> 0, 12);
    await this._write(d);
    this.central.push({ nameBuf, flags, crc, size, offset: headerOffset, external: MODE_FILE });
  }

  async finish() {
    this._check();
    const cdOffset = this.offset;
    let cdSize = 0;
    for (const e of this.central) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(SIG_CENTRAL, 0);
      c.writeUInt16LE(MADE_BY, 4);
      c.writeUInt16LE(NEED_EXTRACT, 6);
      c.writeUInt16LE(e.flags, 8);
      c.writeUInt16LE(METHOD_STORE, 10);
      c.writeUInt16LE(this.now.time, 12);
      c.writeUInt16LE(this.now.date, 14);
      c.writeUInt32LE(e.crc >>> 0, 16);
      c.writeUInt32LE(e.size >>> 0, 20);
      c.writeUInt32LE(e.size >>> 0, 24);
      c.writeUInt16LE(e.nameBuf.length, 28);
      c.writeUInt16LE(0, 30); // extra length
      c.writeUInt16LE(0, 32); // comment length
      c.writeUInt16LE(0, 34); // disk number start
      c.writeUInt16LE(0, 36); // internal attributes
      c.writeUInt32LE(e.external >>> 0, 38);
      c.writeUInt32LE(e.offset >>> 0, 42);
      await this._write(c);
      await this._write(e.nameBuf);
      cdSize += 46 + e.nameBuf.length;
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(SIG_END, 0);
    end.writeUInt16LE(0, 4); // disk number
    end.writeUInt16LE(0, 6); // central-dir disk
    end.writeUInt16LE(this.central.length, 8);
    end.writeUInt16LE(this.central.length, 10);
    end.writeUInt32LE(cdSize >>> 0, 12);
    end.writeUInt32LE(cdOffset >>> 0, 16);
    end.writeUInt16LE(0, 20); // comment length
    await this._write(end);
  }

  // `items`: [{ type: 'dir', name } | { type: 'file', name, path }].
  // Resolves when the full archive (headers + central directory) is written.
  // Rejects on the first I/O error or abort(); the caller owns cleanup.
  async writeAll(items) {
    for (const it of items) {
      if (this.aborted) throw abortError();
      if (it.type === 'dir') await this.addDirectory(it.name);
      else await this.addFile(it.name, it.path);
    }
    await this.finish();
  }
}

module.exports = { ZipStoreWriter, zipName };
