/**
 * HTTP surface: route registration, the browser-facing envelope, staging
 * lifecycle, and protocol refusals.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { registerRestoreRoutes, SESSION_RESTORE_PATHS } from '../lib/routes.js';
import { SessionRestoreService } from '../lib/service.js';
import { Staging } from '../lib/staging.js';
import { buildZip, conversationLog, DEMO_CWD, headerLine, logText } from './helpers.mjs';

/** @type {string} */
let workspace;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-session-restore-http-'));
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** Minimal host context: service lookup plus synchronous effect capture. */
class FakeContext {
  constructor(services) {
    this.services = new Map(Object.entries(services));
    this.routes = new Map();
    this.provided = new Map();
  }

  get(key) {
    return this.services.get(key);
  }

  provide(key, value) {
    this.provided.set(key, value);
  }

  effect(callback) {
    return callback();
  }

  inject(_dependencies, callback) {
    callback(this);
  }
}

/** Minimal persistence backend over a map. */
class FakePersistence {
  constructor() {
    this.sessions = new Map();
  }

  async stat(id) {
    const record = this.sessions.get(id);
    return record === undefined ? undefined : { header: structuredClone(record.header), revision: 'rev' };
  }

  async list() {
    return [...this.sessions.values()].map((record) => ({ header: structuredClone(record.header), revision: 'rev' }));
  }

  async create(header) {
    if (this.sessions.has(header.id)) {
      const error = new Error('exists');
      error.name = 'SessionAlreadyExistsError';
      throw error;
    }
    const record = { header: structuredClone(header), events: [] };
    this.sessions.set(header.id, record);
    const persistence = this;
    return {
      header: record.header,
      inheritedEventCount: 0,
      async append(events) {
        record.events.push(...structuredClone(events));
      },
      async flush() {
        persistence.flushed = (persistence.flushed ?? 0) + 1;
      },
      async close() {},
    };
  }
}

/**
 * Wire a service with the restore routes registered.
 * @param {object} [archiveOptions] - log overrides.
 * @returns {Promise<{ ctx: FakeContext, persistence: FakePersistence, service: SessionRestoreService, zip: Buffer }>} the harness.
 */
async function harness(archiveOptions = {}) {
  const persistence = new FakePersistence();
  const ctx = new FakeContext({ sessionPersistence: persistence });
  const connection = {
    fetch: {
      register: (route) => {
        ctx.routes.set(route.path, route);
        return () => {};
      },
    },
  };
  ctx.services.set('connection', connection);
  const staging = new Staging({ root: join(workspace, `staging-${String(Math.random()).slice(2)}`) });
  const service = new SessionRestoreService({ ctx, staging });
  registerRestoreRoutes(ctx, service);
  const { header, events } = conversationLog(archiveOptions);
  const zip = buildZip([{ name: 'session.v4.jsonl', data: logText(header, events), deflate: true }]);
  return { ctx, persistence, service, zip };
}

/**
 * Call one registered route with a request.
 * @param {FakeContext} ctx - harness context.
 * @param {string} path - absolute route path.
 * @param {Request} request - request to dispatch.
 * @returns {Promise<Response>} the route response.
 */
async function dispatch(ctx, path, request) {
  const route = ctx.routes.get(path);
  assert.ok(route, `route ${path} is registered`);
  return route.fetch(request);
}

/**
 * One JSON POST request.
 * @param {string} url - absolute URL.
 * @param {object} payload - JSON body.
 * @returns {Request} the request.
 */
function jsonRequest(url, payload) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

test('all three routes are registered with the documented methods and body modes', async () => {
  const { ctx } = await harness();
  assert.deepEqual([...ctx.routes.keys()].sort(), Object.values(SESSION_RESTORE_PATHS).sort());
  assert.deepEqual(ctx.routes.get(SESSION_RESTORE_PATHS.preview).methods, ['POST']);
  assert.equal(ctx.routes.get(SESSION_RESTORE_PATHS.preview).requestBody, 'streaming');
  assert.equal(ctx.routes.get(SESSION_RESTORE_PATHS.commit).requestBody, 'buffered');
  assert.equal(ctx.routes.get(SESSION_RESTORE_PATHS.discard).requestBody, 'buffered');
});

test('preview stages an upload and describes it without writing Sessions', async () => {
  const { ctx, persistence, zip } = await harness();
  const response = await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}?name=dsh-session-x.zip`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
  ));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.match(payload.value.token, /^[0-9a-f-]{36}$/u);
  assert.equal(payload.value.fileName, 'dsh-session-x.zip');
  assert.equal(payload.value.root.title, '写一个插件');
  assert.equal(payload.value.root.events, 7);
  assert.deepEqual(payload.value.conflicts, []);
  assert.equal(payload.value.bytes, zip.byteLength);
  assert.equal(persistence.sessions.size, 0);
});

test('commit restores the staged archive and consumes it', async () => {
  const { ctx, persistence, zip } = await harness();
  const preview = await (await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
  ))).json();
  const response = await dispatch(ctx, SESSION_RESTORE_PATHS.commit, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { token: preview.value.token, mode: 'restore', importMedia: false },
  ));
  const payload = await response.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.value.rootId, preview.value.root.id);
  assert.equal(payload.value.sessions[0].status, 'restored');
  assert.equal(persistence.sessions.size, 1);
  const again = await dispatch(ctx, SESSION_RESTORE_PATHS.commit, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { token: preview.value.token },
  ));
  const second = await again.json();
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'staged-upload-missing');
});

test('discard drops a staged upload so it cannot be committed', async () => {
  const { ctx, zip } = await harness();
  const preview = await (await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
  ))).json();
  const discarded = await (await dispatch(ctx, SESSION_RESTORE_PATHS.discard, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.discard}`,
    { token: preview.value.token },
  ))).json();
  assert.deepEqual(discarded.value, { discarded: true });
  const commit = await (await dispatch(ctx, SESSION_RESTORE_PATHS.commit, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { token: preview.value.token },
  ))).json();
  assert.equal(commit.ok, false);
});

test('an archive this harness cannot read is refused with a stable code', async () => {
  const { ctx } = await harness({ header: { version: 3 } });
  const broken = buildZip([{ name: 'session.v4.jsonl', data: 'not json\n' }]);
  const response = await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: broken },
  ));
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'archive-invalid');
  assert.match(payload.error.message, /header is not JSON/u);
});

test('protocol violations answer with a status code, not the envelope', async () => {
  const { ctx, zip } = await harness();
  const wrongType = await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'text/plain' }, body: zip },
  ));
  assert.equal(wrongType.status, 415);
  const wrongBody = await dispatch(ctx, SESSION_RESTORE_PATHS.commit, new Request(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
  ));
  assert.equal(wrongBody.status, 400);
  const noToken = await dispatch(ctx, SESSION_RESTORE_PATHS.commit, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { mode: 'restore' },
  ));
  assert.equal(noToken.status, 400);
});

test('conflicting identities become a copy and are reported in the preview', async () => {
  const { header } = conversationLog();
  const { ctx, persistence, zip } = await harness();
  await persistence.create({ ...header, type: undefined });
  const preview = await (await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
  ))).json();
  assert.equal(preview.value.root.conflict, true);
  assert.deepEqual(preview.value.conflicts, [header.id]);
  const commit = await (await dispatch(ctx, SESSION_RESTORE_PATHS.commit, jsonRequest(
    `http://host${SESSION_RESTORE_PATHS.commit}`,
    { token: preview.value.token, mode: 'restore' },
  ))).json();
  assert.equal(commit.ok, true);
  assert.equal(commit.value.mode, 'copy');
  assert.notEqual(commit.value.rootId, header.id);
  assert.equal(persistence.sessions.size, 2);
});

test('the workspace list is derived from stored Sessions', async () => {
  const { ctx, persistence, zip } = await harness();
  await persistence.create({ ...headerLine({ id: 'session-99999999-9999-4999-8999-999999999999' }), type: undefined });
  const preview = await (await dispatch(ctx, SESSION_RESTORE_PATHS.preview, new Request(
    `http://host${SESSION_RESTORE_PATHS.preview}`,
    { method: 'POST', headers: { 'content-type': 'application/zip' }, body: zip },
  ))).json();
  assert.deepEqual(preview.value.workspaces.map((entry) => entry.cwd), [DEMO_CWD]);
  assert.equal(preview.value.workspaces[0].sessions, 1);
});
