/**
 * The HTTP surface of Session archive restore.
 *
 * Three exact routes on the host's authenticated Fetch registry: a streaming
 * upload that stages an archive and answers with a preview, a buffered commit
 * that restores a staged archive, and a buffered discard that throws a staged
 * upload away. The browser addresses them document-relative (`api/...`).
 *
 * Everything after protocol validation answers HTTP 200 with either
 * `{ ok: true, value }` or `{ ok: false, error: { code, message } }`, the
 * envelope this harness already uses for browser-facing operations; a status
 * code therefore always means "the request itself was malformed".
 * @module dsh-session-restore/routes
 */
import { ArchiveError } from './archive.js';
import { RestoreError } from './restore.js';
import { ZipError } from './zip.js';

/** Absolute registration paths; the browser strips the leading slash. */
export const SESSION_RESTORE_PATHS = {
  preview: '/api/session.restore.preview',
  commit: '/api/session.restore.commit',
  discard: '/api/session.restore.discard',
};

/**
 * Register every restore route on the host connection.
 * @param {object} ctx - host context carrying `connection`.
 * @param {import('./service.js').SessionRestoreService} service - restore service.
 * @param {{ maxUploadBytes?: number }} [config] - upload ceiling.
 */
export function registerRestoreRoutes(ctx, service, config = {}) {
  const connection = ctx.get('connection') ?? Reflect.get(ctx, 'connection');
  if (connection === undefined) throw new Error('session-restore: the connection service is required for the restore routes');
  const maxUploadBytes = config.maxUploadBytes ?? 2 * 1024 * 1024 * 1024;
  ctx.effect(() => connection.fetch.register({
    path: SESSION_RESTORE_PATHS.preview,
    methods: ['POST'],
    requestBody: 'streaming',
    fetch: (request) => handlePreview(service, request, maxUploadBytes),
  }), 'session-restore: preview route');
  ctx.effect(() => connection.fetch.register({
    path: SESSION_RESTORE_PATHS.commit,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleCommit(service, request),
  }), 'session-restore: commit route');
  ctx.effect(() => connection.fetch.register({
    path: SESSION_RESTORE_PATHS.discard,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: (request) => handleDiscard(service, request),
  }), 'session-restore: discard route');
}

/**
 * Stage an uploaded archive and answer with its preview.
 * @param {import('./service.js').SessionRestoreService} service - restore service.
 * @param {Request} request - upload request.
 * @param {number} maxUploadBytes - upload ceiling.
 * @returns {Promise<Response>} the preview response.
 */
async function handlePreview(service, request, maxUploadBytes) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  const mediaType = contentTypeOf(request);
  if (mediaType !== 'application/zip' && mediaType !== 'application/x-zip-compressed' && mediaType !== 'application/octet-stream') {
    return new Response('content type must be application/zip', { status: 415 });
  }
  const query = new URL(request.url).searchParams;
  let staged;
  try {
    staged = await service.staging.stage(requestBodyChunks(request.body), {
      signal: request.signal,
      maxBytes: maxUploadBytes,
    });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return failure('upload-failed', describe(error));
  }
  try {
    const preview = await service.preview(staged.path, {
      sessionId: query.get('sessionId') ?? undefined,
      fileName: query.get('name') ?? undefined,
      signal: request.signal,
    });
    return ok({ ...preview, token: staged.token, bytes: staged.bytes });
  } catch (error) {
    await service.discard(staged.token);
    return failureOf(error);
  }
}

/**
 * Restore a staged archive.
 * @param {import('./service.js').SessionRestoreService} service - restore service.
 * @param {Request} request - commit request carrying a JSON body.
 * @returns {Promise<Response>} the restore response.
 */
async function handleCommit(service, request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('request body must be JSON', { status: 400 });
  }
  if (body === null || typeof body !== 'object' || typeof body.token !== 'string') {
    return new Response('request body must carry a staging token', { status: 400 });
  }
  try {
    const result = await service.commit({
      token: body.token,
      mode: body.mode === 'copy' ? 'copy' : 'restore',
      ...(typeof body.cwd === 'string' && body.cwd !== '' ? { cwd: body.cwd } : {}),
      importMedia: body.importMedia !== false,
      signal: request.signal,
    });
    return ok(result);
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return failureOf(error);
  }
}

/**
 * Drop a staged archive.
 * @param {import('./service.js').SessionRestoreService} service - restore service.
 * @param {Request} request - discard request carrying a JSON body.
 * @returns {Promise<Response>} the discard response.
 */
async function handleDiscard(service, request) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response('request body must be JSON', { status: 400 });
  }
  if (body === null || typeof body !== 'object' || typeof body.token !== 'string') {
    return new Response('request body must carry a staging token', { status: 400 });
  }
  return ok({ discarded: await service.discard(body.token) });
}

/**
 * The request's media type, without parameters.
 * @param {Request} request - request to inspect.
 * @returns {string} the lowercased media type.
 */
function contentTypeOf(request) {
  return request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

/**
 * One `{ ok: true, value }` response.
 * @param {unknown} value - payload.
 * @returns {Response} the response.
 */
function ok(value) {
  return json({ ok: true, value });
}

/**
 * One `{ ok: false, error }` response.
 * @param {string} code - stable failure code.
 * @param {string} message - operator-facing description.
 * @returns {Response} the response.
 */
function failure(code, message) {
  return json({ ok: false, error: { code, message } });
}

/**
 * Turn a caught failure into the browser-facing envelope.
 * @param {unknown} error - caught value.
 * @returns {Response} the response.
 */
function failureOf(error) {
  if (error instanceof ArchiveError) return failure('archive-invalid', error.message);
  if (error instanceof RestoreError) return failure(error.code, error.message);
  if (error instanceof ZipError) return failure('archive-invalid', error.message);
  return failure('restore-failed', describe(error));
}

/**
 * Serialize one JSON envelope.
 * @param {object} payload - envelope.
 * @returns {Response} the response.
 */
function json(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * A one-line description of a caught value.
 * @param {unknown} error - caught value.
 * @returns {string} the description.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Iterate one WHATWG request body as byte chunks.
 * @param {ReadableStream<Uint8Array> | null} body - request body.
 * @returns {AsyncGenerator<Uint8Array>} the chunks.
 */
export async function* requestBodyChunks(body) {
  if (body === null) return;
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) return;
      yield chunk.value;
    }
  } finally {
    reader.releaseLock();
  }
}
