/**
 * Minimal, dependency-free ZIP reader plus the legacy Zstandard frame decoder
 * used by pre-0.2 DSH session artifacts.
 *
 * The archive produced by `GET /api/session.export` is a plain deflate ZIP, but
 * a few hundred MB is normal, so nothing here ever holds the whole archive in
 * memory: the central directory is parsed once, and each entry is read from
 * disk on demand.
 * @module dsh-session-restore/zip
 */
import { open } from 'node:fs/promises';
import { inflateRawSync, zstdDecompressSync } from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const EOCD64_SIGNATURE = 0x06064b50;
const EOCD64_LOCATOR_SIGNATURE = 0x07064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const ZSTD_MAGIC = 0xfd2fb528;
const ZIP64_EXTRA_ID = 0x0001;
const MAX_EOCD_SEARCH = 66_000;

/** 0xFFFFFFFF sentinel meaning "the real value lives in the ZIP64 extra field". */
const ZIP64_SENTINEL = 0xffffffff;

/**
 * CRC-32 of one buffer, using the platform implementation when it exists.
 * @param {Buffer} buffer - bytes to checksum.
 * @returns {number} unsigned CRC-32.
 */
function crc32(buffer) {
  const table = CRC_TABLE ?? (CRC_TABLE = buildCrcTable());
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    value = table[(value ^ buffer[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

let CRC_TABLE;
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
}

/** One throwaway error type so callers can distinguish "bad archive" from I/O failure. */
export class ZipError extends Error {
  /** @param {string} message - what is wrong with the archive. */
  constructor(message) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * One central-directory record.
 * @typedef {object} ZipEntry
 * @property {string} name - UTF-8 entry path as stored in the archive.
 * @property {number} method - 0 (stored) or 8 (deflate).
 * @property {number} crc - recorded CRC-32.
 * @property {number} compressedSize - bytes stored in the archive.
 * @property {number} uncompressedSize - bytes after inflate.
 * @property {number} localOffset - offset of the local file header.
 * @property {boolean} directory - entry names a directory.
 */

/** A ZIP archive opened for random entry reads. */
export class ZipFile {
  /**
   * @param {import('node:fs/promises').FileHandle} handle - open archive handle.
   * @param {readonly ZipEntry[]} entries - parsed central directory.
   * @param {number} size - archive size in bytes.
   */
  constructor(handle, entries, size) {
    this.handle = handle;
    this.entries = entries;
    this.size = size;
  }

  /**
   * Open an archive and parse its central directory.
   * @param {string} path - archive path.
   * @returns {Promise<ZipFile>} the opened archive.
   * @throws {ZipError} when the file is not a readable ZIP archive.
   */
  static async open(path) {
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size < 22) throw new ZipError('archive is too small to be a ZIP file');
      const eocd = await findEocd(handle, size);
      const directory = await readCentralDirectory(handle, eocd);
      return new ZipFile(handle, directory, size);
    } catch (error) {
      await handle.close().catch(() => {});
      throw error;
    }
  }

  /** @returns {ZipEntry | undefined} the first entry with this exact name. */
  find(name) {
    return this.entries.find((entry) => entry.name === name);
  }

  /**
   * Read and verify one entry.
   * @param {ZipEntry} entry - central-directory record to read.
   * @param {{ maxBytes?: number }} [options] - uncompressed size ceiling.
   * @returns {Promise<Buffer>} the verified uncompressed bytes.
   * @throws {ZipError} on a truncated entry, an unsupported method, an
   *   oversized entry, or a CRC mismatch.
   */
  async read(entry, options = {}) {
    const maxBytes = options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    if (entry.uncompressedSize > maxBytes) {
      throw new ZipError(`archive entry "${entry.name}" is ${entry.uncompressedSize} bytes, above the ${maxBytes}-byte limit`);
    }
    const header = Buffer.alloc(30);
    await readExactly(this.handle, header, 0, entry.localOffset);
    if (header.readUInt32LE(0) !== LOCAL_SIGNATURE) {
      throw new ZipError(`archive entry "${entry.name}" has no local file header`);
    }
    const nameLength = header.readUInt16LE(26);
    const extraLength = header.readUInt16LE(28);
    const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
    if (dataOffset + entry.compressedSize > this.size) {
      throw new ZipError(`archive entry "${entry.name}" runs past the end of the archive`);
    }
    const raw = Buffer.alloc(entry.compressedSize);
    if (entry.compressedSize > 0) await readExactly(this.handle, raw, 0, dataOffset);
    let data;
    if (entry.method === 0) data = raw;
    else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
      } catch (error) {
        throw new ZipError(`archive entry "${entry.name}" failed to inflate: ${String(error.message ?? error)}`);
      }
    } else {
      throw new ZipError(`archive entry "${entry.name}" uses unsupported compression method ${entry.method}`);
    }
    if (data.length !== entry.uncompressedSize) {
      throw new ZipError(`archive entry "${entry.name}" inflated to ${data.length} bytes, expected ${entry.uncompressedSize}`);
    }
    if (entry.crc !== 0 && crc32(data) !== entry.crc) {
      throw new ZipError(`archive entry "${entry.name}" failed its CRC check`);
    }
    return data;
  }

  /** Close the underlying file handle. */
  async close() {
    await this.handle.close().catch(() => {});
  }
}

/**
 * Locate the end-of-central-directory record, following the ZIP64 locator when
 * the classic record is saturated.
 * @param {import('node:fs/promises').FileHandle} handle - open archive.
 * @param {number} size - archive size.
 * @returns {Promise<{ entryCount: number, directoryOffset: number, directorySize: number }>} directory coordinates.
 */
async function findEocd(handle, size) {
  const searchLength = Math.min(size, MAX_EOCD_SEARCH);
  const tail = Buffer.alloc(searchLength);
  await readExactly(handle, tail, 0, size - searchLength);
  let offset = -1;
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIGNATURE) {
      offset = index;
      break;
    }
  }
  if (offset < 0) throw new ZipError('archive has no end-of-central-directory record');
  const absolute = size - searchLength + offset;
  const classic = {
    entryCount: tail.readUInt16LE(offset + 10),
    directoryOffset: tail.readUInt32LE(offset + 16),
    directorySize: tail.readUInt32LE(offset + 12),
  };
  if (classic.entryCount !== 0xffff && classic.directoryOffset !== ZIP64_SENTINEL) return classic;
  if (absolute < 20) return classic;
  const locator = Buffer.alloc(20);
  await readExactly(handle, locator, 0, absolute - 20);
  if (locator.readUInt32LE(0) !== EOCD64_LOCATOR_SIGNATURE) return classic;
  const eocd64Offset = Number(locator.readBigUInt64LE(8));
  const record = Buffer.alloc(56);
  await readExactly(handle, record, 0, eocd64Offset);
  if (record.readUInt32LE(0) !== EOCD64_SIGNATURE) throw new ZipError('archive has a ZIP64 locator but no ZIP64 directory record');
  return {
    entryCount: Number(record.readBigUInt64LE(32)),
    directoryOffset: Number(record.readBigUInt64LE(48)),
    directorySize: Number(record.readBigUInt64LE(40)),
  };
}

/**
 * Parse every central-directory record.
 * @param {import('node:fs/promises').FileHandle} handle - open archive.
 * @param {{ entryCount: number, directoryOffset: number, directorySize: number }} eocd - directory coordinates.
 * @returns {Promise<ZipEntry[]>} parsed entries in archive order.
 */
async function readCentralDirectory(handle, eocd) {
  if (eocd.directoryOffset + eocd.directorySize > (await handle.stat()).size) {
    throw new ZipError('archive central directory runs past the end of the file');
  }
  const directory = Buffer.alloc(eocd.directorySize);
  if (directory.length > 0) await readExactly(handle, directory, 0, eocd.directoryOffset);
  const entries = [];
  let offset = 0;
  while (offset + 46 <= directory.length) {
    if (directory.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new ZipError(`archive central directory is malformed at byte ${offset}`);
    }
    const method = directory.readUInt16LE(offset + 10);
    const crc = directory.readUInt32LE(offset + 16);
    const compressedSize = directory.readUInt32LE(offset + 20);
    const uncompressedSize = directory.readUInt32LE(offset + 24);
    const nameLength = directory.readUInt16LE(offset + 28);
    const extraLength = directory.readUInt16LE(offset + 30);
    const commentLength = directory.readUInt16LE(offset + 32);
    const localOffset = directory.readUInt32LE(offset + 42);
    const name = directory.toString('utf8', offset + 46, offset + 46 + nameLength);
    const extra = directory.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength);
    const zip64 = readZip64Extra(extra, { uncompressedSize, compressedSize, localOffset });
    entries.push({
      name,
      method,
      crc,
      compressedSize: zip64.compressedSize,
      uncompressedSize: zip64.uncompressedSize,
      localOffset: zip64.localOffset,
      directory: name.endsWith('/'),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  if (entries.length === 0) throw new ZipError('archive contains no entries');
  return entries;
}

/**
 * Resolve saturated 32-bit fields from the ZIP64 extended-information field.
 * @param {Buffer} extra - raw extra field.
 * @param {{ uncompressedSize: number, compressedSize: number, localOffset: number }} fields - classic values.
 * @returns {{ uncompressedSize: number, compressedSize: number, localOffset: number }} resolved values.
 */
function readZip64Extra(extra, fields) {
  const resolved = { ...fields };
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const size = extra.readUInt16LE(offset + 2);
    const body = extra.subarray(offset + 4, offset + 4 + size);
    if (id === ZIP64_EXTRA_ID) {
      let cursor = 0;
      if (fields.uncompressedSize === ZIP64_SENTINEL && cursor + 8 <= body.length) {
        resolved.uncompressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (fields.compressedSize === ZIP64_SENTINEL && cursor + 8 <= body.length) {
        resolved.compressedSize = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
      if (fields.localOffset === ZIP64_SENTINEL && cursor + 8 <= body.length) {
        resolved.localOffset = Number(body.readBigUInt64LE(cursor));
        cursor += 8;
      }
    }
    offset += 4 + size;
  }
  return resolved;
}

/**
 * Read exactly `length` bytes at `position`.
 * @param {import('node:fs/promises').FileHandle} handle - open file.
 * @param {Buffer} target - destination buffer.
 * @param {number} offset - offset inside the destination.
 * @param {number} position - file position.
 */
async function readExactly(handle, target, offset, position) {
  let read = 0;
  while (read < target.length) {
    const { bytesRead } = await handle.read(target, offset + read, target.length - read, position + read);
    if (bytesRead === 0) throw new ZipError('archive is truncated');
    read += bytesRead;
  }
}

/**
 * Whether a buffer starts with the Zstandard frame magic.
 * @param {Buffer} buffer - candidate bytes.
 * @returns {boolean} true when the bytes are a Zstandard frame.
 */
export function isZstd(buffer) {
  return buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC;
}

/**
 * Decode a Zstandard artifact that concatenates one frame per persisted append
 * batch. Node's one-shot and stream decoders both stop after the first frame,
 * so frames are located by walking their block headers and decoded one at a
 * time; skippable frames are ignored.
 * @param {Buffer} buffer - concatenated Zstandard frames.
 * @returns {Buffer} the concatenated decoded frame contents.
 * @throws {ZipError} when a frame is truncated or uses a reserved block type.
 */
export function zstdDecompressFrames(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (buffer.length - offset < 4) {
      if (buffer.subarray(offset).every((byte) => byte === 0)) break;
      throw new ZipError('trailing bytes after the last Zstandard frame are not a frame');
    }
    const magic = buffer.readUInt32LE(offset);
    if ((magic & 0xfffffff0) === 0x184d2a50) {
      if (buffer.length - offset < 8) throw new ZipError('truncated Zstandard skippable frame');
      const size = buffer.readUInt32LE(offset + 4);
      offset += 8 + size;
      continue;
    }
    if (magic !== ZSTD_MAGIC) {
      if (offset === 0) throw new ZipError('artifact does not start with a Zstandard frame');
      break;
    }
    const end = zstdFrameEnd(buffer, offset);
    try {
      parts.push(zstdDecompressSync(buffer.subarray(offset, end)));
    } catch (error) {
      throw new ZipError(`failed to decompress a Zstandard frame: ${String(error.message ?? error)}`);
    }
    offset = end;
  }
  if (parts.length === 0) throw new ZipError('artifact contains no Zstandard frame');
  return Buffer.concat(parts);
}

/**
 * Byte length of one Zstandard frame starting at `start`.
 * @param {Buffer} buffer - frame bytes.
 * @param {number} start - frame offset.
 * @returns {number} offset just past the frame.
 */
function zstdFrameEnd(buffer, start) {
  let offset = start + 4;
  if (offset >= buffer.length) throw new ZipError('truncated Zstandard frame header');
  const descriptor = buffer[offset];
  offset += 1;
  const contentSizeFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const checksum = (descriptor >> 2) & 1;
  const dictionaryFlag = descriptor & 3;
  if (singleSegment === 0) offset += 1;
  offset += [0, 1, 2, 4][dictionaryFlag];
  let contentSizeBytes = [0, 2, 4, 8][contentSizeFlag];
  if (contentSizeFlag === 0 && singleSegment === 1) contentSizeBytes = 1;
  offset += contentSizeBytes;
  if (offset > buffer.length) throw new ZipError('truncated Zstandard frame header');
  for (;;) {
    if (offset + 3 > buffer.length) throw new ZipError('truncated Zstandard block header');
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
    offset += 3;
    const last = header & 1;
    const type = (header >> 1) & 3;
    const size = header >>> 3;
    if (type === 0) offset += size;
    else if (type === 1) offset += 1;
    else if (type === 2) offset += size;
    else throw new ZipError('Zstandard frame uses a reserved block type');
    if (offset > buffer.length) throw new ZipError('truncated Zstandard block');
    if (last === 1) break;
  }
  if (checksum === 1) offset += 4;
  if (offset > buffer.length) throw new ZipError('truncated Zstandard frame checksum');
  return offset;
}
