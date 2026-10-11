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
import { statSync } from 'node:fs';

/**
 * The platform the suite is being run *as*. `test/simulate-posix/run.mjs`
 * overrides it so a Windows machine can exercise the POSIX branches;
 * everywhere else it is simply the host platform.
 */
export const PLATFORM = process.env.DSH_SESSION_RESTORE_TEST_PLATFORM ?? process.platform;

/**
 * True when this run simulates a POSIX host on Windows: the simulator switches
 * the path rules, but a real temp directory keeps the host's spelling, so a
 * fixture that needs one cannot be absolute in both worlds. A run on a real
 * POSIX host has no such conflict.
 */
export const SIMULATED_POSIX_ON_WINDOWS = process.platform === 'win32' && PLATFORM !== 'win32';

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

/**
 * A stand-in for the host workspace registry, recording what a restore asked
 * of it. Mirrors the three calls the harness itself makes: resolve a path,
 * create a project, attach a Session.
 */
export class FakeWorkspaceRegistry {
  /**
   * @param {{ projects?: Array<{ id: string, path: string, title?: string }>, directoryExists?: (path: string) => boolean, attachFails?: boolean }} [options] - initial projects and failure injection.
   */
  constructor(options = {}) {
    this.projects = (options.projects ?? []).map((project) => ({
      id: project.id,
      path: project.path,
      title: project.title ?? project.path,
      sessionIds: [],
    }));
    // The real filesystem by default: the library checks the directory itself
    // before it registers anything, so a fixture that lies about it would only
    // test the fixture.
    this.directoryExists = options.directoryExists ?? ((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });
    this.attachFails = options.attachFails ?? false;
    this.created = [];
    this.attached = [];
    this.resolved = [];
  }

  /**
   * Find a project by path, as the harness does.
   * @param {string} path - candidate directory.
   * @returns {Promise<object | undefined>} the entity, when one owns the path.
   */
  async resolveByPath(path) {
    this.resolved.push(path);
    if (!this.directoryExists(path)) throw new Error(`ENOENT: ${path}`);
    const project = this.projects.find((candidate) => candidate.path === path);
    return project === undefined ? undefined : this.entity(project);
  }

  /**
   * Create a project for a directory, as the harness does.
   * @param {string} path - directory the project owns.
   * @param {string} [title] - display title.
   * @returns {Promise<object>} the new entity.
   */
  async create(path, title) {
    this.created.push(path);
    if (!this.directoryExists(path)) throw new Error(`cannot create a workspace at '${path}': path is not a directory`);
    const project = { id: `workspace-${this.projects.length + 1}`, path, title: title ?? path, sessionIds: [] };
    this.projects.push(project);
    return this.entity(project);
  }

  /**
   * The registry's own listing.
   * @returns {object[]} project entities.
   */
  list() {
    return this.projects.map((project) => this.entity(project));
  }

  /**
   * Wrap one record as an entity with the harness's attach behaviour.
   * @param {object} project - the record.
   * @returns {object} the entity.
   */
  entity(project) {
    const registry = this;
    return {
      id: project.id,
      path: project.path,
      title: project.title,
      get sessionIds() {
        return [...project.sessionIds];
      },
      async attachSession(sessionId) {
        if (registry.attachFails) throw new Error(`cannot attach session '${sessionId}' to workspace '${project.path}'`);
        registry.attached.push({ workspace: project.id, path: project.path, sessionId });
        if (!project.sessionIds.includes(sessionId)) project.sessionIds.unshift(sessionId);
      },
    };
  }
}

/**
 * A stand-in for `dsh-permission-presets`, using the deployment catalog this
 * machine runs with.
 */
export class FakePermissionPresets {
  /** @param {object} [presets] - preset table. */
  constructor(presets) {
    this.presets = presets ?? {
      'read-only': { sandbox: 'read-only', approval: 'ask' },
      'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
      'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
    };
    this.defaultPreset = 'workspace-write';
  }

  /** @returns {string[]} advertised preset names. */
  get names() {
    return Object.keys(this.presets);
  }

  /**
   * Resolve one preset's knob bundle.
   * @param {string} name - preset name.
   * @returns {{ sandbox: string, approval: string } | undefined} the knobs.
   */
  specOf(name) {
    return this.presets[name];
  }

  /**
   * Resolve one preset, throwing for unknown names the way the service does.
   * @param {string} name - preset name.
   * @returns {{ sandbox: string, approval: string }} the knobs.
   */
  resolve(name) {
    const spec = this.presets[name];
    if (spec === undefined) throw new Error(`permission: unknown preset "${name}"`);
    return spec;
  }
}
