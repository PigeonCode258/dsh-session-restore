/**
 * Reading one exported Session-log archive: entry classification, canonical
 * JSONL parsing, and the validation this build's persistence read path would
 * apply later.
 *
 * The exporter writes no manifest, so every entry is self-describing by its
 * own path: the root log at the archive root, subagent descendants under
 * `subagents/<id>/`, images under `media/<attachmentId>.<ext>`, and generic
 * files under `files/<xx>/<digest>/<name>`. Archives written by an older
 * harness keep the raw per-Session artifact instead (a `.jsonl.zstd` file of
 * concatenated Zstandard frames); both encodings are accepted here.
 * @module dsh-session-restore/archive
 */
import { isAbsolute, posix, win32 } from 'node:path';
import { isZstd, zstdDecompressFrames } from './zip.js';
import { KNOWN_SESSION_EVENT_TYPES, SESSION_FORMAT_VERSION } from './vocabulary.js';

/**
 * Whether a stored workspace path is absolute under either separator
 * convention. Archives travel between platforms, so a Windows log imported on
 * Linux must still parse; whether *this* host can store it is a separate
 * question, answered by {@link isUsableWorkspace}.
 * @param {unknown} value - candidate workspace path.
 * @returns {boolean} true when the path is absolute somewhere.
 */
export function isAbsoluteAnywhere(value) {
  if (typeof value !== 'string' || value === '') return false;
  return isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value);
}

/**
 * Whether this host can store a workspace path: the persistence backend
 * validates `cwd` with the running platform's own rule, so an archive from
 * another platform needs an explicit target workspace.
 * @param {unknown} value - candidate workspace path.
 * @returns {boolean} true when this platform treats the path as absolute.
 */
export function isUsableWorkspace(value) {
  return typeof value === 'string' && value !== '' && isAbsolute(value);
}

/** Media types the attachment store accepts, keyed by archive extension. */
const IMAGE_MEDIA_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]);

/** Canonical log basenames: `session.jsonl`, `session.v4.jsonl`, plus `.zstd`. */
const LOG_NAME_PATTERN = /^session(?:\.v([1-9][0-9]*))?\.jsonl(\.zstd)?$/u;

/** Header keys the physical v4 header line may carry. */
const HEADER_KEYS = new Set([
  'type',
  'version',
  'id',
  'createdAt',
  'isSeeded',
  'delegationDepth',
  'cwd',
  'parentSession',
  'origin',
  'agentPreset',
]);

/** One archive-level refusal the caller must show instead of importing. */
export class ArchiveError extends Error {
  /**
   * @param {string} message - what is wrong with the archive.
   * @param {string} [zipPath] - the offending entry, when one entry is at fault.
   */
  constructor(message, zipPath) {
    super(zipPath === undefined ? message : `${message} (archive entry ${zipPath})`);
    this.name = 'ArchiveError';
    this.zipPath = zipPath;
  }
}

/**
 * One Session log found in the archive.
 * @typedef {object} ArchivedLog
 * @property {string} zipPath - archive entry path.
 * @property {string} fileName - entry basename.
 * @property {'root' | 'subagent'} role - where the entry sat in the archive.
 * @property {object} header - validated logical session header.
 * @property {object[]} events - validated events in seq order.
 * @property {number} inheritedEventCount - decoded inheritance cut.
 * @property {boolean} legacy - decoded from a raw `.jsonl.zstd` artifact.
 * @property {string[]} warnings - non-fatal observations for this log.
 */

/**
 * Classify one archive entry by its path.
 * @param {string} name - archive entry path.
 * @returns {{ kind: 'log' | 'media' | 'file' | 'other', role?: 'root' | 'subagent', id?: string, attachmentId?: string, mediaType?: string, digest?: string, fileName?: string }} classification.
 */
export function classifyEntry(name) {
  const leaf = name.slice(name.lastIndexOf('/') + 1);
  const parent = name.slice(0, Math.max(name.lastIndexOf('/'), 0));
  const logMatch = LOG_NAME_PATTERN.exec(leaf);
  if (logMatch !== null) {
    if (parent === '') return { kind: 'log', role: 'root', fileName: leaf };
    const subagent = /^subagents\/(.+)$/u.exec(parent);
    if (subagent !== null) return { kind: 'log', role: 'subagent', id: subagent[1], fileName: leaf };
  }
  if (name.startsWith('media/') && parent === 'media') {
    const dot = leaf.lastIndexOf('.');
    if (dot > 0) {
      const extension = leaf.slice(dot + 1).toLowerCase();
      const mediaType = IMAGE_MEDIA_TYPES.get(extension);
      if (mediaType !== undefined) return { kind: 'media', attachmentId: leaf.slice(0, dot), mediaType, fileName: leaf };
    }
  }
  const file = /^files\/([^/]+)\/([^/]+)\/(.+)$/u.exec(name);
  if (file !== null) return { kind: 'file', digest: file[2], fileName: file[3] };
  return { kind: 'other' };
}

/**
 * Decode one log entry's bytes into text, transparently handling the raw
 * Zstandard artifacts an older harness exported.
 * @param {Buffer} bytes - entry bytes.
 * @returns {{ text: string, legacy: boolean }} decoded text.
 */
export function decodeLogBytes(bytes) {
  if (!isZstd(bytes)) return { text: bytes.toString('utf8'), legacy: false };
  return { text: zstdDecompressFrames(bytes).toString('utf8'), legacy: true };
}

/**
 * Parse and validate one canonical Session log.
 *
 * `SessionPersistence.create` deliberately performs no vocabulary or shape
 * validation, so everything a later read would refuse is refused here, while
 * the archive is still the only thing at risk.
 * @param {string} text - canonical JSONL text (header line, then one event per line).
 * @param {{ zipPath: string, legacy: boolean }} context - where the text came from.
 * @returns {ArchivedLog} the parsed log.
 * @throws {ArchiveError} when the log cannot be restored faithfully.
 */
export function parseSessionLog(text, context) {
  const warnings = [];
  const lines = text.split('\n');
  const records = [];
  for (const line of lines) {
    if (line.trim() !== '') records.push(line);
  }
  if (records.length === 0) throw new ArchiveError('session log is empty', context.zipPath);
  let rawHeader;
  try {
    rawHeader = JSON.parse(records[0]);
  } catch (error) {
    throw new ArchiveError(`session log header is not JSON: ${String(error.message ?? error)}`, context.zipPath);
  }
  if (rawHeader === null || typeof rawHeader !== 'object' || Array.isArray(rawHeader)) {
    throw new ArchiveError('session log header is not a JSON object', context.zipPath);
  }
  if (rawHeader.type !== undefined && rawHeader.type !== 'session') {
    throw new ArchiveError(`session log does not start with a session header (found "${String(rawHeader.type)}")`, context.zipPath);
  }
  const header = validateHeader(rawHeader, context);
  const events = [];
  for (let index = 1; index < records.length; index += 1) {
    let event;
    try {
      event = JSON.parse(records[index]);
    } catch (error) {
      throw new ArchiveError(`event ${index - 1} is not JSON: ${String(error.message ?? error)}`, context.zipPath);
    }
    events.push(event);
  }
  const inheritedEventCount = inheritCutOf(events, header, context, warnings);
  return {
    zipPath: context.zipPath,
    fileName: context.zipPath.slice(context.zipPath.lastIndexOf('/') + 1),
    role: 'root',
    header,
    events,
    inheritedEventCount,
    legacy: context.legacy,
    warnings,
  };
}

/**
 * Validate the logical header the persistence seam will store.
 * @param {object} raw - parsed header line.
 * @param {{ zipPath: string }} context - archive context for refusals.
 * @returns {object} logical header (without `type`).
 */
function validateHeader(raw, context) {
  // The generation gate comes first: an older log legitimately lacks fields
  // every current generation carries, and "upgrade the harness" is a far more
  // useful answer than "isSeeded is missing".
  if (raw.version !== SESSION_FORMAT_VERSION) {
    throw new ArchiveError(
      typeof raw.version === 'number' && raw.version > SESSION_FORMAT_VERSION
        ? `session log format v${String(raw.version)} is newer than this harness reads (v${SESSION_FORMAT_VERSION}): update DSH and import again`
        : `session log format v${String(raw.version)} predates the v${SESSION_FORMAT_VERSION} export this plugin restores: open that Session in a dsh build that reads it and export it again`,
      context.zipPath,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!HEADER_KEYS.has(key)) throw new ArchiveError(`session header carries unexpected field "${key}"`, context.zipPath);
  }
  if (typeof raw.id !== 'string' || raw.id === '') throw new ArchiveError('session header has no id', context.zipPath);
  if (!Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0) {
    throw new ArchiveError('session header createdAt is not a non-negative integer', context.zipPath);
  }
  if (typeof raw.isSeeded !== 'boolean') throw new ArchiveError('session header has no isSeeded flag', context.zipPath);
  if (!Number.isSafeInteger(raw.delegationDepth) || raw.delegationDepth < 0) {
    throw new ArchiveError('session header delegationDepth is not a non-negative integer', context.zipPath);
  }
  if (raw.cwd !== undefined && !isAbsoluteAnywhere(raw.cwd)) {
    throw new ArchiveError('session header cwd is not an absolute path', context.zipPath);
  }
  if (raw.origin !== undefined && raw.origin !== 'subagent') {
    throw new ArchiveError(`session header origin "${String(raw.origin)}" is not supported`, context.zipPath);
  }
  if (raw.parentSession !== undefined && typeof raw.parentSession !== 'string') {
    throw new ArchiveError('session header parentSession is not a string', context.zipPath);
  }
  if (raw.agentPreset !== undefined && typeof raw.agentPreset !== 'string') {
    throw new ArchiveError('session header agentPreset is not a string', context.zipPath);
  }
  const header = {
    version: raw.version,
    id: raw.id,
    createdAt: raw.createdAt,
    isSeeded: raw.isSeeded,
    delegationDepth: raw.delegationDepth,
    ...(raw.cwd === undefined ? {} : { cwd: raw.cwd }),
    ...(raw.parentSession === undefined ? {} : { parentSession: raw.parentSession }),
    ...(raw.origin === undefined ? {} : { origin: raw.origin }),
    ...(raw.agentPreset === undefined ? {} : { agentPreset: raw.agentPreset }),
  };
  return header;
}

/**
 * Validate the event log the way a later read would, then derive the seeded
 * inheritance cut the header line does not carry: a seeded Session inherits
 * everything up to and including its last `session/end-seed {inherited:true}`
 * marker, and the persistence seam requires that exact cut at `create` time.
 * @param {object[]} events - parsed events.
 * @param {object} header - logical header.
 * @param {{ zipPath: string }} context - archive context for refusals.
 * @param {string[]} warnings - collected non-fatal observations.
 * @returns {number} the inheritance cut (0 for unseeded logs).
 */
function inheritCutOf(events, header, context, warnings) {
  let lastInheritedMarker;
  for (const [index, event] of events.entries()) {
    if (event === null || typeof event !== 'object' || Array.isArray(event)) {
      throw new ArchiveError(`event ${index} is not a JSON object`, context.zipPath);
    }
    if (event.seq !== index) throw new ArchiveError(`event ${index} carries seq ${String(event.seq)}; the log must be dense from 0`, context.zipPath);
    if (typeof event.type !== 'string') throw new ArchiveError(`event ${index} carries no type`, context.zipPath);
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
      throw new ArchiveError(`event ${index} has type "${event.type}", unknown to this harness and not marked ignorable`, context.zipPath);
    }
    if (typeof event.time !== 'number') throw new ArchiveError(`event ${index} carries no time`, context.zipPath);
    if (event.type === 'session/end-seed' && isPlainObject(event.data) && event.data.inherited === true) lastInheritedMarker = index;
  }
  if (header.isSeeded) {
    if (lastInheritedMarker === undefined) {
      throw new ArchiveError('header is seeded but the log carries no inherited end-seed marker', context.zipPath);
    }
    return lastInheritedMarker;
  }
  if (lastInheritedMarker !== undefined) {
    throw new ArchiveError('unseeded session log carries an inherited end-seed marker', context.zipPath);
  }
  if (events.length === 0) warnings.push('the log carries a header only, with no events');
  return 0;
}

/**
 * Whether a value is a plain JSON object.
 * @param {unknown} value - candidate.
 * @returns {boolean} true for a non-array object.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an entire exported archive into the model the preview and the restore
 * engine need. Only one entry's bytes are held at a time beyond the parsed
 * logs themselves.
 * @param {import('./zip.js').ZipFile} zip - opened archive.
 * @param {{ maxEntryBytes?: number, signal?: AbortSignal }} [options] - read limits.
 * @returns {Promise<object>} the archive model.
 * @throws {ArchiveError} when no restorable root log exists.
 */
export async function readSessionArchive(zip, options = {}) {
  const { maxEntryBytes = 512 * 1024 * 1024, signal } = options;
  const rootEntries = [];
  const descendantEntries = [];
  const media = [];
  const files = [];
  const unknown = [];
  for (const entry of zip.entries) {
    if (entry.directory) continue;
    const classification = classifyEntry(entry.name);
    if (classification.kind === 'log') {
      if (classification.role === 'root') rootEntries.push(entry);
      else descendantEntries.push({ entry, id: classification.id });
    } else if (classification.kind === 'media') media.push({ entry, ...classification });
    else if (classification.kind === 'file') files.push({ entry, ...classification });
    else unknown.push(entry.name);
  }
  if (rootEntries.length === 0) {
    throw new ArchiveError('archive contains no root session log (expected a file named session.jsonl or session.v4.jsonl at the archive root)');
  }
  const warnings = [];
  if (rootEntries.length > 1) {
    warnings.push(`the archive holds ${rootEntries.length} root logs; only "${rootEntries[0].name}" is restored`);
  }
  const logs = [];
  const root = await readLog(zip, rootEntries[0], 'root', maxEntryBytes, signal);
  logs.push(root);
  for (const { entry, id } of descendantEntries) {
    try {
      logs.push(await readLog(zip, entry, 'subagent', maxEntryBytes, signal, id));
    } catch (error) {
      throw error instanceof ArchiveError ? error : new ArchiveError(String(error.message ?? error), entry.name);
    }
  }
  return { root, logs, media, files, unknown, warnings, rootEntry: { name: rootEntries[0].name } };
}

/**
 * Read one log entry and parse it.
 * @param {import('./zip.js').ZipFile} zip - opened archive.
 * @param {import('./zip.js').ZipEntry} entry - log entry.
 * @param {'root' | 'subagent'} role - archive position.
 * @param {number} maxEntryBytes - per-entry read ceiling.
 * @param {AbortSignal | undefined} signal - cancellation.
 * @param {string} [expectedId] - subagent directory id.
 * @returns {Promise<ArchivedLog>} the parsed log.
 */
async function readLog(zip, entry, role, maxEntryBytes, signal, expectedId) {
  signal?.throwIfAborted();
  const bytes = await zip.read(entry, { maxBytes: maxEntryBytes });
  const { text, legacy } = decodeLogBytes(bytes);
  const log = parseSessionLog(text, { zipPath: entry.name, legacy });
  log.role = role;
  if (expectedId !== undefined && expectedId !== log.header.id) {
    log.warnings.push(`subagent directory "${expectedId}" disagrees with the log header id "${log.header.id}"; the header wins`);
  }
  return log;
}

/**
 * Every attachment reference one event carries, across the carriers the
 * exporter scans. Returns the mutable block objects so a caller can rewrite
 * their references in place.
 * @param {object} event - one event.
 * @returns {object[]} attachment blocks (`{ type: 'image' | 'file', attachment }`).
 */
export function attachmentBlocksOfEvent(event) {
  const blocks = [];
  const visit = (value, depth) => {
    if (value === null || typeof value !== 'object' || depth > 12) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if ((value.type === 'image' || value.type === 'file') && isPlainObject(value.attachment) && typeof value.attachment.attachmentId === 'string') {
      blocks.push(value);
    }
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(event, 0);
  return blocks;
}

/**
 * The set of attachment ids every log in the archive references.
 * @param {ArchivedLog[]} logs - parsed logs.
 * @returns {{ images: Set<string>, files: Set<string> }} referenced ids.
 */
export function referencedAttachmentIds(logs) {
  const images = new Set();
  const files = new Set();
  for (const log of logs) {
    for (const event of log.events) {
      for (const block of attachmentBlocksOfEvent(event)) {
        if (block.type === 'image') images.add(block.attachment.attachmentId);
        else files.add(block.attachment.attachmentId);
      }
    }
  }
  return { images, files };
}

/**
 * The title a Session's own log records, if it has one.
 * @param {ArchivedLog} log - parsed log.
 * @returns {string | undefined} latest recorded title.
 */
export function sessionTitleOf(log) {
  for (let index = log.events.length - 1; index >= 0; index -= 1) {
    const event = log.events[index];
    if (event.type === 'session/title' && isPlainObject(event.data) && typeof event.data.title === 'string') return event.data.title;
  }
  return undefined;
}

/**
 * A short preview of the first user message, for the import dialog.
 * @param {ArchivedLog} log - parsed log.
 * @param {number} [limit] - maximum characters.
 * @returns {string | undefined} the excerpt.
 */
export function firstUserTextOf(log, limit = 160) {
  for (const event of log.events) {
    if (event.type !== 'user/message' || !isPlainObject(event.data)) continue;
    const content = event.data.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => isPlainObject(block) && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .replace(/\s+/gu, ' ')
      .trim();
    if (text !== '') return text.length > limit ? `${text.slice(0, limit)}…` : text;
  }
  return undefined;
}
