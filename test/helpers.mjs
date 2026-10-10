/**
 * Test-only ZIP writer and Session-log builders.
 *
 * The plugin ships a ZIP reader and deliberately no writer, so the fixtures
 * build archives here: stored and deflated entries, a real central directory,
 * and a real end-of-central-directory record, so the reader is exercised
 * against the format rather than against a stub.
 * @module test/helpers
 */
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * The platform the suite is being run *as*. `test/simulate-posix/run.mjs`
 * overrides it so a Windows machine can exercise the POSIX branches;
 * everywhere else it is simply the host platform.
 */
export const PLATFORM = process.env.DSH_SESSION_RESTORE_TEST_PLATFORM ?? process.platform;

/**
 * A workspace path this platform treats as absolute, so a fixture is valid on
 * every OS the suite runs on.
 */
export const DEMO_CWD = PLATFORM === 'win32' ? 'C:\\work\\demo' : '/work/demo';

/** A second workspace, absolute on this platform. */
export const OTHER_CWD = PLATFORM === 'win32' ? 'C:\\work\\other' : '/work/other';

/** A workspace written in the other platform's convention. */
export const FOREIGN_CWD = PLATFORM === 'win32' ? '/home/dev/project' : 'D:\\dev\\project';

/**
 * Build one ZIP archive in memory.
 * @param {Array<{ name: string, data?: Buffer | string, deflate?: boolean, crc?: number, truncate?: boolean }>} entries - entries to write.
 * @returns {Buffer} the archive bytes.
 */
export function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const data = entry.data === undefined ? Buffer.alloc(0) : Buffer.from(entry.data);
    const name = Buffer.from(entry.name, 'utf8');
    const stored = entry.deflate === true ? deflateRawSync(data) : data;
    const method = entry.deflate === true ? 8 : 0;
    const checksum = entry.crc ?? crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, stored);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(stored.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += local.length + name.length + stored.length;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, eocd]);
}

/**
 * A minimal but valid Session header line.
 * @param {object} [overrides] - header fields to override.
 * @returns {object} the header line record.
 */
export function headerLine(overrides = {}) {
  return {
    type: 'session',
    version: 4,
    id: 'session-11111111-1111-4111-8111-111111111111',
    createdAt: 1_700_000_000_000,
    cwd: DEMO_CWD,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  };
}

/**
 * One event with a dense sequence number.
 * @param {number} seq - event sequence.
 * @param {string} type - event type.
 * @param {object} data - event payload.
 * @returns {object} the event.
 */
export function event(seq, type, data) {
  return { type, seq, time: 1_700_000_000_000 + seq, data };
}

/**
 * A short conversation log: one turn with a user message and an answer.
 * @param {object} [options] - id and extra events.
 * @returns {{ header: object, events: object[] }} the log.
 */
export function conversationLog(options = {}) {
  const header = headerLine(options.header);
  const events = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'user/message', { content: [{ type: 'text', text: '你好，帮我写一个插件' }] }),
    event(2, 'step/start', { turn: 1, step: 1 }),
    event(3, 'assistant/message', {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '好的。' }] },
      stream: [],
    }),
    event(4, 'step/end', { turn: 1, step: 1 }),
    event(5, 'turn/end', { turn: 1, reason: 'completed' }),
    event(6, 'session/title', { title: '写一个插件', messageSeqs: [1], source: 'first-prompt' }),
  ];
  if (options.extraEvents !== undefined) events.push(...options.extraEvents);
  return { header, events };
}

/**
 * Render one log as canonical JSONL text.
 * @param {object} header - header line record.
 * @param {object[]} events - events in seq order.
 * @returns {string} the JSONL text.
 */
export function logText(header, events) {
  return `${[header, ...events].map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/**
 * An image block referencing one attachment.
 * @param {string} attachmentId - referenced image id.
 * @param {number} [bytes] - recorded byte length.
 * @returns {object} the content block.
 */
export function imageBlock(attachmentId, bytes = 3) {
  return {
    type: 'image',
    attachment: { attachmentId, mediaType: 'image/png', bytes, width: 1, height: 1 },
  };
}

/**
 * A file block referencing one attachment.
 * @param {string} attachmentId - referenced file id.
 * @param {string} name - stored file name.
 * @param {number} bytes - recorded byte length.
 * @returns {object} the content block.
 */
export function fileBlock(attachmentId, name, bytes) {
  return { type: 'file', attachment: { attachmentId, name, bytes } };
}
