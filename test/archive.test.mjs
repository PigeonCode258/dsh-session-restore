/**
 * Archive reading: entry classification, ZIP decoding, canonical JSONL
 * validation, and the legacy Zstandard artifact path.
 */
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { classifyEntry, decodeLogBytes, isAbsoluteAnywhere, isUsableWorkspace, parseSessionLog, readSessionArchive } from '../lib/archive.js';
import { ZipError, ZipFile, zstdDecompressFrames } from '../lib/zip.js';
import { buildZip, conversationLog, event, FOREIGN_CWD, headerLine, imageBlock, logText, PLATFORM } from './helpers.mjs';

/** @type {string} */
let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-session-restore-test-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/**
 * Write one archive to the fixture directory.
 * @param {string} name - file name.
 * @param {Buffer} bytes - archive bytes.
 * @returns {Promise<string>} the written path.
 */
async function writeArchive(name, bytes) {
  const path = join(workspace, name);
  await writeFile(path, bytes);
  return path;
}

test('classifyEntry recognizes every exporter layout', () => {
  assert.deepEqual(classifyEntry('session.v4.jsonl'), { kind: 'log', role: 'root', fileName: 'session.v4.jsonl' });
  assert.deepEqual(classifyEntry('session.jsonl'), { kind: 'log', role: 'root', fileName: 'session.jsonl' });
  assert.deepEqual(classifyEntry('session.v4.jsonl.zstd'), { kind: 'log', role: 'root', fileName: 'session.v4.jsonl.zstd' });
  assert.deepEqual(classifyEntry('subagents/session-2/session.v4.jsonl'), {
    kind: 'log',
    role: 'subagent',
    id: 'session-2',
    fileName: 'session.v4.jsonl',
  });
  assert.equal(classifyEntry('media/sha256:abc.png').mediaType, 'image/png');
  assert.equal(classifyEntry('media/sha256:abc.webp').attachmentId, 'sha256:abc');
  assert.equal(classifyEntry('files/ab/abcdef/notes.txt').digest, 'abcdef');
  assert.equal(classifyEntry('files/ab/abcdef/notes.txt').fileName, 'notes.txt');
  assert.equal(classifyEntry('README.md').kind, 'other');
  assert.equal(classifyEntry('nested/session.v4.jsonl').kind, 'other');
});

test('ZipFile reads stored and deflated entries and verifies CRCs', async () => {
  const path = await writeArchive('plain.zip', buildZip([
    { name: 'session.v4.jsonl', data: 'hello\n' },
    { name: 'media/sha256:aa.png', data: Buffer.from([1, 2, 3, 4]), deflate: true },
  ]));
  const zip = await ZipFile.open(path);
  try {
    const log = zip.find('session.v4.jsonl');
    assert.ok(log);
    assert.equal((await zip.read(log)).toString('utf8'), 'hello\n');
    const image = zip.find('media/sha256:aa.png');
    assert.ok(image);
    assert.deepEqual([...(await zip.read(image))], [1, 2, 3, 4]);
  } finally {
    await zip.close();
  }
});

test('ZipFile refuses a corrupted entry', async () => {
  const path = await writeArchive('bad-crc.zip', buildZip([{ name: 'session.v4.jsonl', data: 'hello\n', crc: 12345 }]));
  const zip = await ZipFile.open(path);
  try {
    await assert.rejects(() => zip.read(zip.find('session.v4.jsonl')), ZipError);
  } finally {
    await zip.close();
  }
});

test('ZipFile refuses a file that is not an archive', async () => {
  const path = await writeArchive('not-a-zip.zip', Buffer.from('definitely not a zip archive'));
  await assert.rejects(() => ZipFile.open(path), ZipError);
});

test('parseSessionLog accepts a canonical log and derives its identity', () => {
  const { header, events } = conversationLog();
  const log = parseSessionLog(logText(header, events), { zipPath: 'session.v4.jsonl', legacy: false });
  assert.equal(log.header.id, header.id);
  assert.equal(log.header.version, 4);
  assert.equal(log.events.length, events.length);
  assert.equal(log.inheritedEventCount, 0);
  assert.equal(log.legacy, false);
});

test('parseSessionLog refuses formats this harness cannot read', () => {
  const { header, events } = conversationLog();
  const older = { ...header, version: 3 };
  assert.throws(() => parseSessionLog(logText(older, events), { zipPath: 'x', legacy: false }), /predates/u);
  const newer = { ...header, version: 5 };
  assert.throws(() => parseSessionLog(logText(newer, events), { zipPath: 'x', legacy: false }), /update DSH/u);
});

test('parseSessionLog refuses a log that is not dense from seq 0', () => {
  const { header, events } = conversationLog();
  const broken = events.map((item) => (item.seq === 3 ? { ...item, seq: 9 } : item));
  assert.throws(() => parseSessionLog(logText(header, broken), { zipPath: 'x', legacy: false }), /dense/u);
});

test('parseSessionLog refuses an event type this build does not know', () => {
  const { header, events } = conversationLog();
  const extra = event(events.length, 'future/thing', {});
  assert.throws(
    () => parseSessionLog(logText(header, [...events, extra]), { zipPath: 'x', legacy: false }),
    /unknown to this harness/u,
  );
  const ignorable = { ...event(events.length, 'future/thing', {}), ignorable: true };
  const log = parseSessionLog(logText(header, [...events, ignorable]), { zipPath: 'x', legacy: false });
  assert.equal(log.events.length, events.length + 1);
});

test('parseSessionLog refuses unexpected header fields and bad heritage', () => {
  const { header, events } = conversationLog();
  assert.throws(
    () => parseSessionLog(logText({ ...header, sandboxMode: 'x' }, events), { zipPath: 'x', legacy: false }),
    /unexpected field/u,
  );
  assert.throws(
    () => parseSessionLog(logText({ ...header, cwd: 'relative/path' }, events), { zipPath: 'x', legacy: false }),
    /cwd is not an absolute path/u,
  );
  assert.throws(
    () => parseSessionLog(logText({ ...header, isSeeded: true }, events), { zipPath: 'x', legacy: false }),
    /no inherited end-seed marker/u,
  );
  const seeded = conversationLog({
    header: { isSeeded: true },
    extraEvents: [event(7, 'session/end-seed', { inherited: true })],
  });
  const log = parseSessionLog(logText(seeded.header, seeded.events), { zipPath: 'x', legacy: false });
  assert.equal(log.inheritedEventCount, 7);
  assert.throws(
    () => parseSessionLog(logText(header, [...events, event(events.length, 'session/end-seed', { inherited: true })]), { zipPath: 'x', legacy: false }),
    /unseeded session log carries an inherited end-seed marker/u,
  );
});

test('workspace paths are portable across platforms', () => {
  // A path is accepted when it is absolute under either convention, because
  // archives travel; it is *usable* only when this platform can store it.
  assert.equal(isAbsoluteAnywhere('C:\\work\\demo'), true);
  assert.equal(isAbsoluteAnywhere('/work/demo'), true);
  assert.equal(isAbsoluteAnywhere('work/demo'), false);
  assert.equal(isAbsoluteAnywhere(''), false);
  assert.equal(isAbsoluteAnywhere(42), false);
  assert.equal(isUsableWorkspace(FOREIGN_CWD), PLATFORM === 'win32');
  const { header, events } = conversationLog({ header: { cwd: FOREIGN_CWD } });
  const log = parseSessionLog(logText(header, events), { zipPath: 'x', legacy: false });
  assert.equal(log.header.cwd, FOREIGN_CWD, 'a foreign platform workspace still parses');
});

test('decodeLogBytes decodes a concatenated-frame artifact', () => {
  const { header, events } = conversationLog();
  const frames = Buffer.concat([
    zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8')),
    zstdCompressSync(Buffer.from(`${events.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8')),
  ]);
  const decoded = zstdDecompressFrames(frames).toString('utf8');
  assert.match(decoded, /"type":"session"/u);
  assert.match(decoded, /"type":"turn\/end"/u);
  const viaDecode = decodeLogBytes(frames);
  assert.equal(viaDecode.legacy, true);
  const log = parseSessionLog(viaDecode.text, { zipPath: 'session.v4.jsonl.zstd', legacy: true });
  assert.equal(log.events.length, events.length);
});

test('readSessionArchive models a full export', async () => {
  const root = conversationLog();
  const child = conversationLog({
    header: {
      id: 'session-22222222-2222-4222-8222-222222222222',
      parentSession: root.header.id,
      origin: 'subagent',
      delegationDepth: 1,
      cwd: undefined,
    },
  });
  const image = Buffer.from([9, 8, 7]);
  const path = await writeArchive('export.zip', buildZip([
    { name: 'session.v4.jsonl', data: logText(root.header, root.events), deflate: true },
    { name: 'subagents/session-22222222-2222-4222-8222-222222222222/session.v4.jsonl', data: logText(child.header, child.events) },
    { name: 'media/sha256:aa.png', data: image },
    { name: 'files/ab/abcdef/report.txt', data: Buffer.from('report') },
    { name: 'stray.txt', data: 'ignored' },
  ]));
  const zip = await ZipFile.open(path);
  try {
    const archive = await readSessionArchive(zip);
    assert.equal(archive.root.header.id, root.header.id);
    assert.equal(archive.logs.length, 2);
    assert.equal(archive.logs[1].role, 'subagent');
    assert.equal(archive.media.length, 1);
    assert.equal(archive.files.length, 1);
    assert.deepEqual(archive.unknown, ['stray.txt']);
  } finally {
    await zip.close();
  }
});

test('readSessionArchive refuses an archive without a root log', async () => {
  const path = await writeArchive('no-root.zip', buildZip([{ name: 'media/sha256:aa.png', data: Buffer.from([1]) }]));
  const zip = await ZipFile.open(path);
  try {
    await assert.rejects(() => readSessionArchive(zip), /no root session log/u);
  } finally {
    await zip.close();
  }
});

test('attachment references are discovered across carriers', async () => {
  const { header, events } = conversationLog();
  const withImage = [
    ...events,
    event(events.length, 'user/message', { content: [imageBlock('sha256:aa')] }),
  ];
  const path = await writeArchive('refs.zip', buildZip([
    { name: 'session.v4.jsonl', data: logText(header, withImage) },
    { name: 'media/sha256:aa.png', data: Buffer.from([1, 2, 3]) },
  ]));
  const zip = await ZipFile.open(path);
  try {
    const archive = await readSessionArchive(zip);
    const { referencedAttachmentIds } = await import('../lib/archive.js');
    const referenced = referencedAttachmentIds(archive.logs);
    assert.deepEqual([...referenced.images], ['sha256:aa']);
  } finally {
    await zip.close();
  }
});
