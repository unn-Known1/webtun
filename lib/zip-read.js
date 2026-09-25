'use strict';
// Minimal ZIP reader — stored + deflated entries, Node stdlib only.
//
// Replaces `yauzl` for POST /api/files/unzip. Portable by construction: pure
// JS + `fs`/`zlib`, no native modules, no shell-outs, identical behavior on
// Linux, macOS and Windows.
//
// Scope (matches yauzl's effective support, and the server's 1GB/1000-entry
// caps make anything bigger unreachable anyway):
// - methods 0 (stored) and 8 (deflated) only; anything else is rejected,
//   exactly like yauzl — exotic methods (bzip2/LZMA/Zstd) never extracted.
// - No Zip64, no multi-disk: rejected with a clear error, like yauzl.
// - Encrypted entries are detected via the flag and rejected outright.
//   (yauzl does not decrypt, so this turns silent garbage into a clean error.)
// - Filenames decode as UTF-8 (yauzl parity); backslash/absolute/`..`
//   sanitizing stays the caller's job (server.js does it per entry).
// - CRC + size are validated on the decompressed stream, like yauzl.

const fs = require('fs');
const fsp = fs.promises;
const zlib = require('zlib');
const { Transform } = require('stream');
const { crc32Update } = require('./zip-store');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DESCRIPTOR = 0x0008;
const EOCD_MIN = 22;
const EOCD_SEARCH_MAX = 65535 + EOCD_MIN; // EOCD + largest possible comment
const MAX_CD_BYTES = 64 * 1024 * 1024; // sanity cap on central-directory size
const MAX_OPEN_ENTRY_STREAMS = 32; // fd cap for parallel entry consumers

function zipError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

async function readAt(fh, length, position) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead < length) throw zipError('CORRUPT', 'Unexpected end of zip file');
  return buf;
}

// Locate the end-of-central-directory by scanning the file tail backwards.
// Every candidate is validated (offsets inside the file, sane counts) so a
// signature hiding in the comment can't mislead us.
async function findEocd(fh, fileSize, maxEntries) {
  if (fileSize < EOCD_MIN) throw zipError('NOT_ZIP', 'Not a zip file (too small)');
  const tailLen = Math.min(fileSize, EOCD_SEARCH_MAX);
  const tail = await readAt(fh, tailLen, fileSize - tailLen);
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== SIG_END) continue;
    const disk = tail.readUInt16LE(i + 4);
    const cdDisk = tail.readUInt16LE(i + 6);
    const entriesDisk = tail.readUInt16LE(i + 8);
    const entriesTotal = tail.readUInt16LE(i + 10);
    const cdSize = tail.readUInt32LE(i + 12);
    const cdOffset = tail.readUInt32LE(i + 16);
    const commentLen = tail.readUInt16LE(i + 20);
    if (i + EOCD_MIN + commentLen !== tail.length) continue; // must end the file
    if (disk !== 0 || cdDisk !== 0) throw zipError('MULTI_DISK', 'Multi-disk zips are not supported');
    if (entriesDisk === 0xffff || entriesTotal === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw zipError('ZIP64', 'Zip64 archives are not supported');
    }
    if (entriesTotal !== entriesDisk) throw zipError('CORRUPT', 'Mismatched zip entry counts');
    if (cdOffset + cdSize > fileSize) continue; // points outside — keep looking
    if (entriesTotal > maxEntries) throw zipError('ENTRY_LIMIT', 'Too many entries in zip');
    return { entriesTotal, cdSize, cdOffset };
  }
  throw zipError('NOT_ZIP', 'Not a zip file (no end-of-central-directory)');
}

function parseCentralDirectory(buf, count) {
  const entries = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length) throw zipError('CORRUPT', 'Truncated zip central directory');
    if (buf.readUInt32LE(pos) !== SIG_CENTRAL) throw zipError('CORRUPT', 'Bad zip central directory entry');
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compSize = buf.readUInt32LE(pos + 20);
    const uncompSize = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const externalAttrs = buf.readUInt32LE(pos + 38);
    pos += 46;
    if (pos + nameLen + extraLen + commentLen > buf.length) throw zipError('CORRUPT', 'Truncated zip central directory entry');
    const fileName = buf.subarray(pos, pos + nameLen).toString('utf8');
    pos += nameLen + extraLen + commentLen;
    entries.push({ fileName, method, flags, crc, compressedSize: compSize, uncompressedSize: uncompSize, localOffset, externalAttrs });
  }
  return entries;
}

// Extraction guard: normalize an archive entry name and refuse anything that
// could escape the destination (.., absolute/drive paths, tilde-relative,
// percent-encoded traversal, NULs). `..foo` is harmless and allowed — only a
// full `..` segment escapes. Callers must join the RETURNED name — never the
// raw fileName — onto the destination.
function safeZipEntryName(fileName) {
  const entryName = String(fileName).replace(/\\/g, '/');
  // Drive prefixes (incl. drive-relative `C:foo`) are meaningless to
  // path.normalize on POSIX — reject up front.
  if (/^[A-Za-z]:(\/|$)/.test(entryName) || /^[A-Za-z]:[^/]/.test(entryName) || entryName.includes('\0')) {
    throw zipError('UNSAFE_NAME', 'Invalid zip entry: ' + fileName);
  }
  if (entryName.startsWith('~') || /%2e/i.test(entryName)) {
    throw zipError('UNSAFE_NAME', 'Invalid zip entry: ' + fileName);
  }
  const entryPath = require('path').normalize(entryName);
  if (entryPath === '..' || entryPath.startsWith('../') || entryPath.startsWith('..\\') ||
      require('path').isAbsolute(entryPath)) {
    throw zipError('UNSAFE_NAME', 'Invalid zip entry: ' + fileName);
  }
  return entryPath;
}

// Pass-through that validates size + CRC of the decompressed bytes, like
// yauzl does. Entries whose central-directory sizes are zeroed (descriptor
// flag set, broken writer) skip per-entry validation — there is nothing to
// check them against, and rejecting them would break zips yauzl accepts — but
// they are still bounded by MAX_DESCRIPTOR_ENTRY_BYTES so a malicious entry
// can't stream unbounded (previously only the outer liveTotal counter bound
// them, not per-entry integrity).
const MAX_DESCRIPTOR_ENTRY_BYTES = 1 * 1024 * 1024 * 1024;
function validatingStream(entry) {
  const check = !(entry.uncompressedSize === 0 && (entry.flags & FLAG_DESCRIPTOR));
  let size = 0;
  let crc = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      if (size > MAX_DESCRIPTOR_ENTRY_BYTES) return cb(zipError('CORRUPT', `Entry too large in zip entry ${entry.fileName}`));
      crc = crc32Update(crc, chunk);
      cb(null, chunk);
    },
    flush(cb) {
      if (!check) return cb();
      if (size !== entry.uncompressedSize) return cb(zipError('CORRUPT', `Size mismatch in zip entry ${entry.fileName}`));
      if ((crc >>> 0) !== (entry.crc >>> 0)) return cb(zipError('CRC_MISMATCH', `CRC mismatch in zip entry ${entry.fileName} (corrupt)`));
      cb();
    }
  });
}

class ZipArchiveReader {
  constructor(zipPath, fileSize, entries) {
    this.zipPath = zipPath;
    this.fileSize = fileSize;
    this.entries = entries;
    this._openStreams = 0;
  }

  static async open(zipPath, opts = {}) {
    const maxEntries = opts.maxEntries || 1000;
    let fh;
    try {
      fh = await fsp.open(zipPath, 'r');
      const { size } = await fh.stat();
      const eocd = await findEocd(fh, size, maxEntries);
      if (eocd.cdSize > MAX_CD_BYTES) throw zipError('CORRUPT', 'Zip central directory too large');
      const cd = eocd.cdSize ? await readAt(fh, eocd.cdSize, eocd.cdOffset) : Buffer.alloc(0);
      const entries = parseCentralDirectory(cd, eocd.entriesTotal);
      return new ZipArchiveReader(zipPath, size, entries);
    } finally {
      try { await fh.close(); } catch {}
    }
  }

  // Resolves to a readable stream of the entry's uncompressed bytes.
  // Throws ENCRYPTED / BAD_METHOD / CORRUPT for entries we won't touch.
  async openEntryStream(entry) {
    if (entry.flags & FLAG_ENCRYPTED) throw zipError('ENCRYPTED', `Encrypted zip entry not supported: ${entry.fileName}`);
    if (entry.method !== METHOD_STORE && entry.method !== METHOD_DEFLATE) {
      throw zipError('BAD_METHOD', `Unsupported compression method in zip entry: ${entry.fileName}`);
    }
    // Bound fd lifetime: a parallel caller must not hold unlimited handles.
    // The counter is claimed BEFORE the open: two callers racing past the
    // check must not both open past MAX_OPEN_ENTRY_STREAMS.
    if (this._openStreams >= MAX_OPEN_ENTRY_STREAMS) {
      throw zipError('BUSY', `Too many open zip entries in: ${entry.fileName}`);
    }
    this._openStreams++;
    let fh;
    try {
      fh = await fsp.open(this.zipPath, 'r');
    } catch (e) {
      this._openStreams--;
      throw e;
    }
    let fhClosed = false;
    const closeFh = () => {
      if (fhClosed) return;
      fhClosed = true;
      this._openStreams--;
      // Never a floating rejection: an unobserved fh.close() failure would
      // otherwise surface as an unhandled rejection in the host process.
      try { Promise.resolve(fh.close()).catch(() => {}); } catch {}
    };
    try {
      // Bounds-check BEFORE reading: entry offsets past EOF are corrupt
      // without touching the filesystem.
      if (entry.localOffset + 30 > this.fileSize) throw zipError('CORRUPT', `Bad local header in zip entry: ${entry.fileName}`);
      const lh = await readAt(fh, 30, entry.localOffset).catch(() => {
        throw zipError('CORRUPT', `Bad local header in zip entry: ${entry.fileName}`);
      });
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw zipError('CORRUPT', `Bad local header in zip entry: ${entry.fileName}`);
      const nameLen = lh.readUInt16LE(26);
      const extraLen = lh.readUInt16LE(28);
      const dataStart = entry.localOffset + 30 + nameLen + extraLen;
      if (dataStart + entry.compressedSize > this.fileSize) throw zipError('CORRUPT', `Truncated data in zip entry: ${entry.fileName}`);
      const validate = validatingStream(entry);
      validate.on('close', closeFh);
      if (entry.compressedSize === 0) {
        closeFh();
        const empty = require('stream').Readable.from([]);
        return empty.pipe(validate);
      }
      const raw = fs.createReadStream(this.zipPath, { start: dataStart, end: dataStart + entry.compressedSize - 1 });
      raw.on('error', closeFh);
      if (entry.method === METHOD_STORE) return raw.pipe(validate);
      const inflate = zlib.createInflateRaw();
      inflate.on('error', closeFh);
      return raw.pipe(inflate).pipe(validate);
    } catch (e) {
      closeFh();
      throw e;
    }
  }
}

module.exports = { ZipArchiveReader, safeZipEntryName, openZip: (p, o) => ZipArchiveReader.open(p, o) };
