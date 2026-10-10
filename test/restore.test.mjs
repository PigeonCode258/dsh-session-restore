/**
 * Restore engine: writing logs through the persistence seam, identity
 * handling, conflict escalation, sub-session lineage, and attachment rewrite.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { readSessionArchive } from '../lib/archive.js';
import { ZipFile } from '../lib/zip.js';
import { RestoreError, restoreArchive } from '../lib/restore.js';
import { buildZip, conversationLog, DEMO_CWD, event, fileBlock, FOREIGN_CWD, imageBlock, logText, OTHER_CWD, PLATFORM } from './helpers.mjs';

/** @type {string} */
let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-session-restore-restore-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** In-memory stand-in for the JSONL persistence backend. */
class FakePersistence {
  constructor() {
    this.sessions = new Map();
    this.appends = [];
  }

  async stat(id) {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : { header: structuredClone(record.header), revision: 'rev-1' };
  }

  async list() {
    return [...this.sessions.values()].map((record) => ({ header: structuredClone(record.header), revision: 'rev-1' }));
  }

  async create(header, options = {}) {
    if (this.sessions.has(header.id)) {
      const error = new Error(`session "${header.id}" already exists`);
      error.name = 'SessionAlreadyExistsError';
      throw error;
    }
    const record = { header: structuredClone(header), events: [], inheritedEventCount: options.inheritedEventCount ?? 0 };
    this.sessions.set(header.id, record);
    return this.handleFor(record);
  }

  handleFor(record) {
    const persistence = this;
    return {
      header: record.header,
      get inheritedEventCount() {
        return record.inheritedEventCount;
      },
      async append(events) {
        for (const [index, item] of events.entries()) {
          const expected = record.events.length + index;
          if (item.seq !== expected) throw new Error(`append seq mismatch: expected ${expected}, got ${item.seq}`);
        }
        persistence.appends.push(events.length);
        record.events.push(...structuredClone(events));
      },
      async flush() {
        record.materialized = true;
      },
      async close() {
        record.closed = true;
      },
    };
  }
}

/** In-memory stand-in for the attachment store; images intentionally re-identify. */
class FakeAttachments {
  constructor() {
    this.images = new Map();
    this.files = new Map();
  }

  async saveImage(input) {
    const digest = createHash('sha256').update(input.data).digest('hex');
    const id = `sha256:${digest}`;
    const ref = { attachmentId: id, mediaType: input.mediaType, bytes: input.data.byteLength, width: 1, height: 1 };
    this.images.set(id, ref);
    return ref;
  }

  async saveFileStream(input) {
    const chunks = [];
    for await (const chunk of input.data) chunks.push(Buffer.from(chunk));
    const data = Buffer.concat(chunks);
    const id = `sha256:${createHash('sha256').update(data).digest('hex')}`;
    const ref = { attachmentId: id, name: input.name ?? 'file', bytes: data.byteLength };
    this.files.set(id, ref);
    return ref;
  }
}

/** An image store that always mints a different identity, to exercise remapping. */
class RenamingAttachments extends FakeAttachments {
  async saveImage(input) {
    const stored = await super.saveImage(input);
    const renamed = { ...stored, attachmentId: `sha256:${'f'.repeat(64)}` };
    this.images.set(renamed.attachmentId, renamed);
    return renamed;
  }
}

/**
 * Write one archive and open it.
 * @param {string} name - fixture name.
 * @param {Array<object>} entries - archive entries.
 * @returns {Promise<{ zip: ZipFile, archive: object }>} the opened archive.
 */
async function openArchive(name, entries) {
  const path = join(workspace, name);
  await writeFile(path, buildZip(entries));
  const zip = await ZipFile.open(path);
  return { zip, archive: await readSessionArchive(zip) };
}

test('restore keeps the archived identity and writes every event', async () => {
  const { header, events } = conversationLog();
  const { zip, archive } = await openArchive('restore.zip', [
    { name: 'session.v4.jsonl', data: logText(header, events) },
  ]);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    assert.equal(result.mode, 'restore');
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].status, 'restored');
    assert.equal(result.sessions[0].id, header.id);
    assert.equal(result.sessions[0].title, '写一个插件');
    const stored = persistence.sessions.get(header.id);
    assert.equal(stored.events.length, events.length);
    assert.deepEqual(stored.events.map((item) => item.type), events.map((item) => item.type));
    assert.equal(stored.header.cwd, header.cwd);
    assert.equal(stored.closed, true);
    assert.equal(stored.materialized, true);
  } finally {
    await zip.close();
  }
});

test('restore imports a sub-session with its lineage and a seeded cut', async () => {
  const root = conversationLog();
  const childEvents = [
    event(0, 'turn/start', { turn: 1 }),
    event(1, 'session/end-seed', { inherited: true }),
    event(2, 'turn/start', { turn: 2 }),
  ];
  const childHeader = {
    type: 'session',
    version: 4,
    id: 'session-33333333-3333-4333-8333-333333333333',
    createdAt: 1_700_000_001_000,
    isSeeded: true,
    delegationDepth: 1,
    origin: 'subagent',
    parentSession: root.header.id,
    cwd: root.header.cwd,
  };
  const { zip, archive } = await openArchive('child.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, root.events) },
    { name: `subagents/${childHeader.id}/session.v4.jsonl`, data: logText(childHeader, childEvents) },
  ]);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    assert.equal(result.sessions.length, 2);
    const stored = persistence.sessions.get(childHeader.id);
    assert.equal(stored.header.parentSession, root.header.id);
    assert.equal(stored.header.delegationDepth, 1);
    assert.equal(stored.inheritedEventCount, 1);
  } finally {
    await zip.close();
  }
});

test('existing identities escalate the whole import to copy mode', async () => {
  const root = conversationLog();
  const childHeader = {
    type: 'session',
    version: 4,
    id: 'session-44444444-4444-4444-8444-444444444444',
    createdAt: 1_700_000_002_000,
    isSeeded: false,
    delegationDepth: 1,
    origin: 'subagent',
    parentSession: root.header.id,
    cwd: root.header.cwd,
  };
  const path = join(workspace, 'copy.zip');
  await writeFile(path, buildZip([
    { name: 'session.v4.jsonl', data: logText(root.header, root.events) },
    { name: `subagents/${childHeader.id}/session.v4.jsonl`, data: logText(childHeader, [event(0, 'turn/start', { turn: 1 })]) },
  ]));
  const zip = await ZipFile.open(path);
  const archive = await readSessionArchive(zip);
  const persistence = new FakePersistence();
  try {
    await persistence.create({ ...root.header, type: undefined });
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    assert.equal(result.mode, 'copy');
    assert.equal(result.sessions.length, 2);
    const restoredRoot = result.sessions.find((session) => session.role === 'root');
    const restoredChild = result.sessions.find((session) => session.role === 'subagent');
    assert.notEqual(restoredRoot.id, root.header.id);
    assert.match(restoredRoot.id, /^session-[0-9a-f-]{36}$/u);
    const storedChild = persistence.sessions.get(restoredChild.id);
    assert.equal(storedChild.header.parentSession, restoredRoot.id);
    assert.ok(result.warnings.some((warning) => warning.includes('copy')));
  } finally {
    await zip.close();
  }
});

test('copy mode rewrites session references, including JSON text carriers', async () => {
  const root = conversationLog();
  const referencing = [
    ...root.events,
    event(root.events.length, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'call-1',
      name: 'subagent',
      arguments: JSON.stringify({ prompt: 'go', sessionId: root.header.id }),
    }),
    event(root.events.length + 1, 'tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', content: [{ type: 'text', text: root.header.id }] },
    }),
  ];
  const path = join(workspace, 'refs-copy.zip');
  await writeFile(path, buildZip([{ name: 'session.v4.jsonl', data: logText(root.header, referencing) }]));
  const zip = await ZipFile.open(path);
  const archive = await readSessionArchive(zip);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, { mode: 'copy' });
    const newId = result.sessions[0].id;
    assert.notEqual(newId, root.header.id);
    const stored = persistence.sessions.get(newId).events;
    assert.equal(stored.length, referencing.length);
    assert.equal(JSON.parse(stored.at(-2).data.arguments).sessionId, newId);
    assert.equal(stored.at(-1).data.message.content[0].text, newId);
    assert.equal(stored.at(-2).data.callId, 'call-1');
  } finally {
    await zip.close();
  }
});

test('restore rewrites image references the store re-identifies and keeps file names', async () => {
  const image = Buffer.from([1, 2, 3, 4]);
  const file = Buffer.from('report body');
  const fileId = `sha256:${createHash('sha256').update(file).digest('hex')}`;
  const root = conversationLog();
  const events = [
    ...root.events,
    event(root.events.length, 'user/message', { content: [imageBlock('sha256:old'), fileBlock(fileId, 'report.txt', file.byteLength)] }),
  ];
  const { zip, archive } = await openArchive('media.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, events) },
    { name: 'media/sha256:old.png', data: image },
    { name: `files/${fileId.slice(7, 9)}/${fileId.slice(7)}/report.txt`, data: file },
  ]);
  const persistence = new FakePersistence();
  const attachments = new RenamingAttachments();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, attachments, archive, zip }, {});
    assert.equal(result.media.images, 1);
    assert.equal(result.media.files, 1);
    assert.equal(result.media.restored, 2);
    const stored = persistence.sessions.get(root.header.id).events;
    const block = stored.at(-1).data.content;
    assert.equal(block[0].attachment.attachmentId, `sha256:${'f'.repeat(64)}`);
    assert.equal(block[1].attachment.attachmentId, fileId);
    assert.equal(block[1].attachment.name, 'report.txt');
    assert.ok(result.warnings.some((warning) => warning.includes('re-normalized')));
  } finally {
    await zip.close();
  }
});

test('a missing attachment leaves the reference untouched and is reported', async () => {
  const root = conversationLog();
  const events = [...root.events, event(root.events.length, 'user/message', { content: [imageBlock('sha256:missing')] })];
  const { zip, archive } = await openArchive('missing-media.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, events) },
  ]);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, attachments: new FakeAttachments(), archive, zip }, {});
    assert.equal(result.media.images, 0);
    assert.deepEqual(result.media.missingImages, ['sha256:missing']);
    assert.ok(result.warnings.some((warning) => warning.includes('does not carry every referenced attachment')));
  } finally {
    await zip.close();
  }
});

test('a workspace override moves every log and is reported', async () => {
  const { header, events } = conversationLog();
  const { zip, archive } = await openArchive('cwd.zip', [
    { name: 'session.v4.jsonl', data: logText(header, events) },
  ]);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, { cwd: OTHER_CWD });
    assert.equal(persistence.sessions.get(header.id).header.cwd, OTHER_CWD);
    assert.equal(result.sessions[0].cwd, OTHER_CWD);
    assert.ok(result.warnings.some((warning) => warning.includes('moves from')));
  } finally {
    await zip.close();
  }
});

test('a workspace from another platform needs an explicit target', async () => {
  const { header, events } = conversationLog({ header: { cwd: FOREIGN_CWD } });
  const { zip, archive } = await openArchive('foreign-cwd.zip', [
    { name: 'session.v4.jsonl', data: logText(header, events) },
  ]);
  const persistence = new FakePersistence();
  try {
    // The archive parses — it is a valid absolute path somewhere — but this
    // host may not be able to store it. When it cannot, every log fails, and a
    // restore that wrote nothing is a refusal: it throws with the reason rather
    // than reporting a result nobody could use.
    const outcome = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {}).then(
      (result) => ({ result }),
      (error) => ({ error }),
    );
    if (PLATFORM === 'win32') {
      // Windows accepts both conventions, so this is the usable-workspace path.
      assert.equal(outcome.result?.sessions[0].status, 'restored');
    } else {
      assert.ok(outcome.error instanceof RestoreError, 'a refusal, not a result');
      assert.match(outcome.error.message, /not an absolute path on this platform/u);
      assert.match(outcome.error.message, /choose a target workspace/u);
      assert.equal(persistence.sessions.size, 0, 'nothing was written');
    }
  } finally {
    await zip.close();
  }

  const retry = await openArchive('foreign-cwd-target.zip', [
    { name: 'session.v4.jsonl', data: logText(header, events) },
  ]);
  try {
    // A fresh store, so the retry is the "first import with a chosen target"
    // case on every platform.
    const restored = await restoreArchive(
      { sessionPersistence: new FakePersistence(), archive: retry.archive, zip: retry.zip },
      { cwd: DEMO_CWD },
    );
    assert.equal(restored.sessions[0].status, 'restored');
    assert.equal(restored.sessions[0].cwd, DEMO_CWD);
  } finally {
    await retry.zip.close();
  }
});

test('a workspace that only some logs can use is reported per session', async () => {
  // A mixed archive is where the per-session report, rather than a refusal,
  // has to carry the foreign workspace: the root is fine, the descendant is not.
  const root = conversationLog();
  const childHeader = {
    type: 'session',
    version: 4,
    id: 'session-66666666-6666-4666-8666-666666666666',
    createdAt: 1_700_000_004_000,
    isSeeded: false,
    delegationDepth: 1,
    parentSession: root.header.id,
    cwd: FOREIGN_CWD,
  };
  const { zip, archive } = await openArchive('mixed-cwd.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, root.events) },
    { name: `subagents/${childHeader.id}/session.v4.jsonl`, data: logText(childHeader, [event(0, 'turn/start', { turn: 1 })]) },
  ]);
  const persistence = new FakePersistence();
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    const rootSession = result.sessions.find((session) => session.role === 'root');
    const childSession = result.sessions.find((session) => session.role === 'subagent');
    assert.equal(rootSession.status, 'restored');
    if (PLATFORM === 'win32') {
      assert.equal(childSession.status, 'restored');
    } else {
      assert.equal(childSession.status, 'failed');
      assert.match(childSession.error, /choose a target workspace/u);
      assert.ok(result.warnings.some((warning) => warning.includes('not an absolute path on this platform')));
    }
  } finally {
    await zip.close();
  }
});

test('a failing log does not stop the others and is reported per session', async () => {
  const root = conversationLog();
  const childHeader = {
    type: 'session',
    version: 4,
    id: 'session-55555555-5555-4555-8555-555555555555',
    createdAt: 1_700_000_003_000,
    isSeeded: false,
    delegationDepth: 1,
    parentSession: root.header.id,
    cwd: root.header.cwd,
  };
  const { zip, archive } = await openArchive('partial.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, root.events) },
    { name: `subagents/${childHeader.id}/session.v4.jsonl`, data: logText(childHeader, [event(0, 'turn/start', { turn: 1 })]) },
  ]);
  const persistence = new FakePersistence();
  const original = persistence.create.bind(persistence);
  persistence.create = async (header, options) => {
    if (header.id === childHeader.id) throw new Error('disk full');
    return original(header, options);
  };
  try {
    const result = await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    assert.equal(result.sessions.filter((session) => session.status === 'restored').length, 1);
    const failed = result.sessions.find((session) => session.status === 'failed');
    assert.match(failed.error, /disk full/u);
  } finally {
    await zip.close();
  }
});

test('a partial log is appended in contiguous batches', async () => {
  const root = conversationLog();
  const many = Array.from({ length: 1200 }, (_, index) => event(index, 'turn/start', { turn: index + 1 }));
  const { zip, archive } = await openArchive('batched.zip', [
    { name: 'session.v4.jsonl', data: logText(root.header, many) },
  ]);
  const persistence = new FakePersistence();
  try {
    await restoreArchive({ sessionPersistence: persistence, archive, zip }, {});
    assert.equal(persistence.sessions.get(root.header.id).events.length, 1200);
    assert.ok(persistence.appends.length > 1, 'expected more than one append batch');
    assert.equal(persistence.appends.reduce((total, count) => total + count, 0), 1200);
  } finally {
    await zip.close();
  }
});
