/**
 * Plugin entry: what one `apply` mounts, and the `/import` command end to end
 * through a staged host file.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { apply, inject, name } from '../lib/index.js';
import { buildZip, conversationLog, logText } from './helpers.mjs';

/** @type {string} */
let workspace;
/** @type {string} */
let previousHome;

before(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'dsh-session-restore-plugin-'));
  previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = join(workspace, 'home');
});

after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(workspace, { recursive: true, force: true });
});

/** Stand-in host context that records what a plugin contributed. */
class FakeContext {
  constructor(services) {
    this.services = new Map(Object.entries(services));
    this.routes = new Map();
    this.commandDefinitions = new Map();
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

  inject(dependencies, callback) {
    if (dependencies.every((key) => this.services.has(key))) callback(this);
  }
}

/** Persistence stand-in that records the stored logs. */
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
    this.sessions.set(header.id, { header: structuredClone(header), events: [] });
    const record = this.sessions.get(header.id);
    return {
      header: record.header,
      inheritedEventCount: 0,
      async append(events) {
        record.events.push(...structuredClone(events));
      },
      async flush() {},
      async close() {},
    };
  }
}

/**
 * Mount the plugin on a stand-in host.
 * @returns {{ ctx: FakeContext, persistence: FakePersistence }} the mounted host.
 */
function mount() {
  const persistence = new FakePersistence();
  const ctx = new FakeContext({ sessionPersistence: persistence });
  // A Cordis context exposes services as properties too; `scope.commands` and
  // `ctx.connection` are property reads in the plugin.
  ctx.connection = {
    fetch: {
      register: (route) => {
        ctx.routes.set(route.path, route);
        return () => {};
      },
    },
  };
  ctx.commands = {
    register: (definition) => {
      ctx.commandDefinitions.set(definition.name, definition);
      return () => {};
    },
  };
  ctx.services.set('connection', ctx.connection);
  ctx.services.set('commands', ctx.commands);
  apply(ctx);
  return { ctx, persistence };
}

test('the plugin declares its name and the one service it cannot work without', () => {
  assert.equal(name, 'session-restore');
  assert.deepEqual([...inject], ['connection']);
});

test('apply provides the service, the routes, and the /import command', () => {
  const { ctx } = mount();
  assert.equal(typeof ctx.provided.get('sessionRestore').commit, 'function');
  assert.deepEqual([...ctx.routes.keys()].sort(), [
    '/api/session.restore.commit',
    '/api/session.restore.discard',
    '/api/session.restore.preview',
  ]);
  const command = ctx.commandDefinitions.get('import');
  assert.ok(command);
  assert.equal(typeof command.handler, 'function');
});

test('/import without a path answers with its usage', async () => {
  const { ctx } = mount();
  const result = await ctx.commandDefinitions.get('import').handler({ rawInput: '  ', agent: { id: 'session-x' } });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法/u);
});

test('/import refuses a path that does not exist', async () => {
  const { ctx } = mount();
  const result = await ctx.commandDefinitions.get('import').handler({
    rawInput: join(workspace, 'missing.zip'),
    agent: { id: 'session-x' },
  });
  assert.equal(result.kind, 'error');
  assert.match(result.text, /找不到文件/u);
});

test('/import restores a real archive and reports every Session', async () => {
  const { header, events } = conversationLog();
  const archive = join(workspace, 'dsh-session-demo.zip');
  await writeFile(archive, buildZip([{ name: 'session.v4.jsonl', data: logText(header, events), deflate: true }]));
  const { ctx, persistence } = mount();
  const result = await ctx.commandDefinitions.get('import').handler({ rawInput: `"${archive}"`, agent: { id: 'session-x' } });
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /已恢复 1 个会话/u);
  assert.match(result.text, new RegExp(header.id, 'u'));
  assert.equal(persistence.sessions.get(header.id).events.length, events.length);
});

test('/import --copy mints a new identity', async () => {
  const { header, events } = conversationLog();
  const archive = join(workspace, 'dsh-session-copy.zip');
  await writeFile(archive, buildZip([{ name: 'session.v4.jsonl', data: logText(header, events) }]));
  const { ctx, persistence } = mount();
  const result = await ctx.commandDefinitions.get('import').handler({
    rawInput: `${archive} --copy --no-media`,
    agent: { id: 'session-x' },
  });
  assert.equal(result.kind, 'success', result.text);
  assert.equal(persistence.sessions.has(header.id), false);
  assert.equal(persistence.sessions.size, 1);
  assert.match([...persistence.sessions.keys()][0], /^session-[0-9a-f-]{36}$/u);
});
