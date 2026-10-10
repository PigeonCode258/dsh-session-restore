/**
 * Browser half: the hand-written lazy-CJS bundle registers itself, mounts
 * exactly one Session-header entry, and renders every dialog phase without
 * throwing.
 *
 * The bundle is loaded the way the real module loader loads it — a classic
 * script calling `window.__ModuleLoader__.load` — and rendered with a minimal
 * React stand-in, so a typo in a render branch fails here instead of in the
 * page.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(here, '..', 'lib', 'client.js');
const PACKAGE_ID = 'dsh-session-restore';

/** Minimal React stand-in: elements are plain trees, hooks are inert. */
const React = {
  Fragment: Symbol('react.fragment'),
  createElement(type, props, ...children) {
    const next = { ...(props ?? {}) };
    // React only overwrites `children` when child arguments are passed.
    if (children.length === 1) next.children = children[0];
    else if (children.length > 1) next.children = children;
    return { type, props: next };
  },
  useRef(initial) {
    return { current: initial ?? null };
  },
  useState(initial) {
    return [initial, () => {}];
  },
};

/** Primitive stand-ins that keep the rendered tree inspectable. */
const primitives = {
  Button: 'Button',
  Modal: 'Modal',
  Input: 'Input',
  Checkbox: 'Checkbox',
  SegmentedControl: 'SegmentedControl',
  Tag: 'Tag',
  IconUnarchiveOutlineRegular: 'IconUnarchiveOutlineRegular',
};

/** A snapshot store with the same surface as the real client store. */
function createSnapshotStore(initial) {
  let state = structuredClone(initial);
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    set: (next) => {
      state = structuredClone(next);
      for (const listener of listeners) listener();
    },
    update: (mutator) => {
      const draft = structuredClone(state);
      mutator(draft);
      state = draft;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * Load the browser bundle and return its exports plus the captured registration.
 * @returns {Promise<{ exports: object, registrations: object[], load: (require: Function) => object }>} the loaded bundle.
 */
async function loadBundle() {
  const source = await readFile(BUNDLE, 'utf8');
  const registrations = [];
  const context = {
    window: {
      __ModuleLoader__: {
        load: (registration) => {
          registrations.push(registration);
        },
      },
    },
    // Browser globals the bundle legitimately uses; they are host objects, not
    // intrinsics, so a vm context has to be handed them explicitly.
    AbortController,
    URLSearchParams,
    fetch: () => Promise.reject(new Error('the bundle must use its injected fetcher')),
    console,
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  new vm.Script(source, { filename: 'client.js' }).runInContext(context);
  assert.equal(registrations.length, 1, 'the bundle registers exactly one module');
  const registration = registrations[0];
  assert.equal(registration.id, PACKAGE_ID);
  const load = (require) => registration.factory(require);
  return {
    registrations,
    load,
    exports: load((specifier) => {
      if (specifier === 'react') return React;
      if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
      if (specifier === '@deepseek-ai/dsh-client-store') return { createSnapshotStore };
      throw new Error(`the bundle requested an undeclared module: ${specifier}`);
    }),
  };
}

/**
 * Mount the browser half on a stand-in client context.
 * @returns {Promise<{ controller: object, entries: object[], header: object, footer: object }>} the mounted entries.
 */
async function mount() {
  const loaded = await loadBundle();
  const captured = { controller: null, entries: [] };
  let pending = null;
  const ctx = {
    effect: (callback) => callback(),
    on: () => {},
    inject: (_deps, callback) => callback(ctx),
    get: () => undefined,
    provide: (key, value) => {
      if (key === 'sessionRestore') captured.controller = value;
    },
    locale: { register: () => () => {} },
    slots: {
      inject: (key, callback) => {
        pending = key;
        callback();
      },
      register: (options, component) => {
        captured.entries.push({ key: pending, options, component });
        return () => {};
      },
    },
  };
  loaded.exports.apply(ctx);
  // The renderer turns an entry's `hooks` compartment into `use<Name>` selector
  // props; mirror that here so the components see the real prop shape.
  for (const entry of captured.entries) {
    const { hooks, ...rest } = entry.options.inject('session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const props = { ...rest };
    for (const [name, source] of Object.entries(hooks ?? {})) {
      props[`use${name[0].toUpperCase()}${name.slice(1)}`] = (selector) => selector(source.getSnapshot());
    }
    entry.props = {
      ...props,
      sessionId: 'session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      wide: true,
      t: (key, params) => (params === undefined ? key : `${key}(${JSON.stringify(params)})`),
    };
  }
  const byKey = (key) => captured.entries.find((entry) => entry.key === key);
  return {
    ...captured,
    exports: loaded.exports,
    header: byKey('conversation.session.header.utilities'),
    footer: byKey('sidebar.footer.action'),
  };
}

/**
 * Flatten one rendered tree into its string leaves, invoking function
 * components the way React would and visiting every prop that carries copy
 * (`children`, `title`, `description`, `footer`, `label`).
 * @param {unknown} node - rendered node.
 * @param {string[]} out - accumulator.
 * @returns {string[]} the strings in render order.
 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node === 'function') return out;
  if (Array.isArray(node)) {
    for (const item of node) textsOf(item, out);
    return out;
  }
  if (typeof node.type === 'function') return textsOf(node.type({ ...node.props }), out);
  for (const value of Object.values(node.props ?? {})) textsOf(value, out);
  return out;
}

test('the bundle registers its package id and exports apply/inject', async () => {
  const loaded = await loadBundle();
  assert.equal(typeof loaded.exports.apply, 'function');
  assert.deepEqual([...loaded.exports.inject], ['slots', 'locale']);
});

test('mounting adds one Session-header trigger and one sidebar entry', async () => {
  const mounted = await mount();
  assert.equal(mounted.entries.length, 2);
  assert.equal(mounted.header.key, 'conversation.session.header.utilities');
  assert.equal(mounted.header.options.name, 'conversation.session.header.utilities');
  assert.equal(mounted.header.options.id, 'session-restore');
  assert.equal(mounted.header.options.locale, 'session-restore');
  assert.equal(typeof mounted.header.component, 'function');
  assert.equal(mounted.footer.key, 'sidebar.footer.action');
  assert.equal(mounted.footer.options.id, 'session-restore');
  assert.equal(typeof mounted.footer.component, 'function');
  for (const entry of mounted.entries) {
    assert.equal(typeof entry.props.useSessionRestore, 'function');
    assert.equal(typeof entry.props.openSession, 'function');
    assert.equal(typeof entry.props.select, 'function');
  }
  assert.equal(typeof mounted.controller.open, 'function');
});

test('the header entry is a compact trigger and renders no dialog', async () => {
  const mounted = await mount();
  const rendered = mounted.header.component(mounted.header.props);
  assert.equal(rendered.type, 'Button');
  assert.equal(rendered.props['aria-label'], 'action.label');
  assert.equal(rendered.props.children, undefined, 'the trigger is icon-only');
  mounted.controller.open('session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const withDialogOpen = textsOf(mounted.header.component(mounted.header.props));
  assert.equal(withDialogOpen.includes('dialog.title'), false, 'the dialog lives in the sidebar, not the header');
});

/**
 * The visible text of every Button in a rendered tree.
 * @param {unknown} node - rendered node.
 * @returns {string[]} the button labels.
 */
function buttonLabels(node) {
  const found = [];
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (current.type === 'Button') {
      found.push(...textsOf(current.props.children));
      return;
    }
    if (typeof current.type === 'function') {
      walk(current.type({ ...current.props }));
      return;
    }
    for (const value of Object.values(current.props ?? {})) walk(value);
  };
  walk(node);
  return found;
}

test('the sidebar entry renders a label only when the rail is wide', async () => {
  const mounted = await mount();
  assert.ok(buttonLabels(mounted.footer.component(mounted.footer.props)).includes('action.label'));
  assert.equal(buttonLabels(mounted.footer.component({ ...mounted.footer.props, wide: false })).includes('action.label'), false);
  assert.equal(
    textsOf(mounted.footer.component(mounted.footer.props)).includes('pick.title'),
    false,
    'no dialog copy while closed',
  );
});

test('the pick phase offers a drop target and a file input', async () => {
  const mounted = await mount();
  mounted.controller.open('session-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const rendered = mounted.footer.component(mounted.footer.props);
  const texts = textsOf(rendered);
  assert.ok(texts.includes('pick.title'));
  assert.ok(texts.includes('pick.hint'));
  assert.ok(texts.includes('pick.choose'));
});

test('the preview phase renders the archive, its options, and the commit action', async () => {
  const mounted = await mount();
  mounted.controller.store.set({
    ...mounted.controller.store.getSnapshot(),
    open: true,
    phase: 'preview',
    token: 'token-1',
    preview: {
      fileName: 'dsh-session-x.zip',
      root: {
        id: 'session-root',
        role: 'root',
        root: true,
        title: '归档中的会话',
        excerpt: '你好',
        createdAt: 1_700_000_000_000,
        cwd: 'C:\\work\\demo',
        cwdExists: false,
        conflict: false,
        isSeeded: false,
        legacy: false,
        events: 7,
        agentPreset: 'standard',
      },
      descendants: [{
        id: 'session-child',
        role: 'subagent',
        root: false,
        events: 3,
        conflict: true,
        cwd: '/home/dev/project',
        cwdExists: false,
        cwdUsable: false,
      }],
      attachments: { images: 2, files: 1, missingImages: 1, missingFiles: 0, storeAvailable: true },
      warnings: ['a warning'],
      suggestedCwd: 'C:\\work\\demo',
      conflicts: [],
    },
  });
  const rendered = mounted.footer.component(mounted.footer.props);
  const texts = textsOf(rendered);
  for (const expected of [
    'preview.heading',
    'preview.root',
    'preview.subagent',
    'preview.conflict',
    'preview.cwdMissing',
    'options.mode',
    'options.cwd',
    'options.media',
    'commit',
    'cancel',
    'a warning',
    '归档中的会话',
    'session-root',
  ]) {
    assert.ok(texts.some((text) => text.includes(expected)), `expected the preview to render ${expected}`);
  }
  assert.ok(texts.some((text) => text.includes('preview.attachments')), 'attachment counts are shown');
  assert.ok(texts.some((text) => text.includes('preview.attachmentsMissing')), 'missing attachments are reported');
  assert.ok(texts.some((text) => text.includes('preview.cwdUnusable')), 'a foreign-platform workspace is called out');
});

test('the result phase renders every outcome and offers to open the root', async () => {
  const mounted = await mount();
  mounted.controller.store.set({
    ...mounted.controller.store.getSnapshot(),
    open: true,
    phase: 'done',
    result: {
      mode: 'copy',
      rootId: 'session-root-new',
      sessions: [
        { id: 'session-root-new', originalId: 'session-root', role: 'root', status: 'restored', events: 7, title: 'T' },
        { id: 'session-child', originalId: 'session-child', role: 'subagent', status: 'failed', events: 0, error: 'disk full' },
      ],
      media: { restored: 3 },
      warnings: ['a note'],
    },
  });
  const rendered = mounted.footer.component(mounted.footer.props);
  const texts = textsOf(rendered);
  assert.ok(texts.includes('done.heading'));
  assert.ok(texts.some((text) => text.includes('session-root-new')));
  assert.ok(texts.some((text) => text.includes('disk full')));
  assert.ok(texts.some((text) => text.includes('done.attachments')));
  assert.ok(texts.includes('done.open'));
  assert.ok(texts.includes('done.finish'));
});

test('the failure phase shows the reason and offers to choose again', async () => {
  const mounted = await mount();
  mounted.controller.store.set({
    ...mounted.controller.store.getSnapshot(),
    open: true,
    phase: 'failed',
    error: 'archive-invalid: header is not JSON',
  });
  const rendered = mounted.footer.component(mounted.footer.props);
  const texts = textsOf(rendered);
  assert.ok(texts.includes('error.heading'));
  assert.ok(texts.some((text) => text.includes('header is not JSON')));
  assert.ok(texts.includes('pick.choose'));
});

test('closing the dialog abandons the upload and resets the state', async () => {
  const mounted = await mount();
  const discarded = [];
  const controller = mounted.controller;
  controller.open('session-x');
  controller.publish({ phase: 'preview', token: 'token-2' });
  controller.discard = (token) => {
    discarded.push(token);
    return Promise.resolve(true);
  };
  controller.close();
  assert.deepEqual(discarded, ['token-2']);
  const state = controller.store.getSnapshot();
  assert.equal(state.open, false);
  assert.equal(state.phase, 'idle');
  assert.equal(state.token, null);
});

/**
 * Drive one upload with a scripted transport.
 * @param {object} controller - mounted controller.
 * @param {(url: string, init: object) => Promise<object>} respond - transport.
 * @returns {{ calls: Array<{ url: string, init: object }> }} the recorded calls.
 */
function transport(controller, respond) {
  const calls = [];
  controller.fetcher = (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { calls };
}

/**
 * One fetch-like response carrying a JSON envelope.
 * @param {object} payload - envelope.
 * @returns {Promise<object>} the response.
 */
async function envelope(payload) {
  return {
    status: 200,
    ok: true,
    text: async () => JSON.stringify(payload),
  };
}

test('upload posts the archive to the preview route and stores the token', async () => {
  const mounted = await mount();
  const { calls } = transport(mounted.controller, () =>
    envelope({
      ok: true,
      value: {
        token: 'token-3',
        fileName: 'x.zip',
        root: { id: 'session-root', events: 1, cwdExists: false },
        descendants: [],
        attachments: { images: 0, files: 0, missingImages: 0, missingFiles: 0, storeAvailable: false },
        warnings: [],
        conflicts: ['session-root'],
        suggestedCwd: 'C:\\work\\demo',
      },
    }));
  mounted.controller.open('session-9');
  await mounted.controller.upload({ name: 'x.zip' }, 'session-9');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^api\/session\.restore\.preview\?/u);
  assert.match(calls[0].url, /name=x\.zip/u);
  assert.match(calls[0].url, /sessionId=session-9/u);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['content-type'], 'application/zip');
  const state = mounted.controller.store.getSnapshot();
  assert.equal(state.phase, 'preview');
  assert.equal(state.token, 'token-3');
  assert.equal(state.mode, 'copy', 'a conflicting archive defaults to copy mode');
  assert.equal(state.useCwd, true, 'a missing workspace pre-selects the suggested one');
  assert.equal(state.cwd, 'C:\\work\\demo');
  assert.equal(state.importMedia, false, 'no attachment store disables media restore');
});

test('commit posts the chosen options and records the result', async () => {
  const mounted = await mount();
  const { calls } = transport(mounted.controller, () =>
    envelope({ ok: true, value: { mode: 'restore', rootId: 'session-root', sessions: [], media: { restored: 0 }, warnings: [] } }));
  mounted.controller.publish({ phase: 'preview', token: 'token-4', mode: 'restore', cwd: 'C:\\work\\x', useCwd: true, importMedia: true });
  await mounted.controller.commit();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'api/session.restore.commit');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    token: 'token-4',
    mode: 'restore',
    cwd: 'C:\\work\\x',
    importMedia: true,
  });
  const state = mounted.controller.store.getSnapshot();
  assert.equal(state.phase, 'done');
  assert.equal(state.token, null);
  assert.equal(state.result.rootId, 'session-root');
});

test('a refused envelope becomes an operator-readable failure', async () => {
  const mounted = await mount();
  transport(mounted.controller, () =>
    envelope({ ok: false, error: { code: 'archive-invalid', message: 'session log header is not JSON' } }));
  await mounted.controller.upload({ name: 'broken.zip' }, 'session-9');
  const state = mounted.controller.store.getSnapshot();
  assert.equal(state.phase, 'failed');
  assert.match(state.error, /header is not JSON/u);
  assert.match(state.error, /archive-invalid/u);
});

test('a transport failure is reported instead of throwing', async () => {
  const mounted = await mount();
  transport(mounted.controller, () => Promise.reject(new Error('network down')));
  mounted.controller.publish({ phase: 'preview', token: 'token-5' });
  await mounted.controller.commit();
  const state = mounted.controller.store.getSnapshot();
  assert.equal(state.phase, 'failed');
  assert.match(state.error, /network down/u);
});
