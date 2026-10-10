/**
 * Restoring an exported archive as durable Sessions.
 *
 * Every log is written through the persistence seam exactly as the harness
 * writes its own: `create(header)` takes write ownership under the identity
 * the log already carries, `append` stores the events in contiguous batches,
 * and `flush` is the durability barrier that finally materializes the
 * artifact. Nothing is written to the session store behind the seam's back, so
 * a restored Session is indistinguishable from one this harness produced —
 * it lists, opens, and resumes through the ordinary paths.
 *
 * The seam refuses to overwrite: `create` rejects an identity that already
 * exists and this build ships no delete API. A conflicting archive is
 * therefore re-identified as a copy (new ids everywhere, every reference
 * rewritten) instead of being silently dropped or half-written.
 * @module dsh-session-restore/restore
 */
import { randomUUID } from 'node:crypto';
import { remapAttachmentRefs, planAttachments, restoreAttachments } from './media.js';
import { isUsableWorkspace, referencedAttachmentIds, sessionTitleOf } from './archive.js';

/** Events per append batch: bounds the JSON snapshot one batch materializes. */
const APPEND_BATCH_EVENTS = 250;

/** Approximate JSON bytes per append batch, so a few huge events still batch sanely. */
const APPEND_BATCH_BYTES = 4 * 1024 * 1024;

/** One refusal to restore a particular log. */
export class RestoreError extends Error {
  /**
   * @param {string} code - stable failure code.
   * @param {string} message - operator-facing description.
   */
  constructor(code, message) {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

/**
 * What one restored Session looks like in the result.
 * @typedef {object} RestoredSession
 * @property {string} originalId - identity the archive carried.
 * @property {string} id - identity the Session now has.
 * @property {'root' | 'subagent'} role - archive position.
 * @property {'restored' | 'failed'} status - outcome.
 * @property {number} events - events written.
 * @property {string} [title] - title recorded by the log.
 * @property {string} [cwd] - workspace the Session was restored into.
 * @property {string} [error] - failure description when `status` is failed.
 */

/**
 * Restore an archive into durable Sessions.
 * @param {object} context - host services and archive.
 * @param {object} context.sessionPersistence - mounted persistence service.
 * @param {object} [context.attachments] - mounted attachment service, when present.
 * @param {object} context.archive - archive model from `readSessionArchive`.
 * @param {import('./zip.js').ZipFile} context.zip - opened archive.
 * @param {object} [options] - restore policy.
 * @param {'restore' | 'copy'} [options.mode] - keep the archive identities, or mint new ones.
 * @param {string} [options.cwd] - workspace to restore every log into; defaults to each log's own cwd.
 * @param {boolean} [options.importMedia] - restore referenced images and files.
 * @param {boolean} [options.autoCopyOnConflict] - switch to copy mode when an identity already exists.
 * @param {AbortSignal} [options.signal] - cancellation.
 * @param {(done: number, total: number) => void} [options.onProgress] - attachment progress.
 * @returns {Promise<object>} the restore result.
 */
export async function restoreArchive(context, options = {}) {
  const { sessionPersistence, attachments, archive, zip } = context;
  const {
    cwd,
    importMedia = true,
    autoCopyOnConflict = true,
    signal,
    onProgress,
  } = options;
  const warnings = [...archive.warnings];
  for (const log of archive.logs) warnings.push(...log.warnings);

  const conflicts = await findConflicts(sessionPersistence, archive.logs, signal);
  let mode = options.mode ?? 'restore';
  if (mode === 'restore' && conflicts.length > 0) {
    if (!autoCopyOnConflict) {
      throw new RestoreError(
        'conflict',
        `these Sessions already exist here: ${conflicts.join(', ')} — restore them as copies instead`,
      );
    }
    mode = 'copy';
    warnings.push(`identities already present, so the archive was imported as a copy: ${conflicts.join(', ')}`);
  }

  const idMap = identityMap(archive.logs, mode);
  const plans = archive.logs.map((log) => {
    const id = idMap.get(log.header.id);
    const targetCwd = cwd ?? log.header.cwd;
    const header = {
      ...log.header,
      id,
      ...(targetCwd === undefined ? {} : { cwd: targetCwd }),
      ...(log.header.parentSession === undefined ? {} : { parentSession: idMap.get(log.header.parentSession) ?? log.header.parentSession }),
    };
    return { log, id, header, events: remapIds(log.events, idMap), title: sessionTitleOf(log) };
  });
  if (cwd !== undefined) {
    for (const plan of plans) {
      if (plan.log.header.cwd !== undefined && plan.log.header.cwd !== cwd) {
        warnings.push(`session ${plan.log.header.id} moves from "${plan.log.header.cwd}" to "${cwd}"`);
      }
    }
  }
  for (const plan of plans) {
    if (plan.header.cwd === undefined) {
      warnings.push(`session ${plan.id} has no workspace, so it will not appear in the Session list until one is set`);
    } else if (!isUsableWorkspace(plan.header.cwd)) {
      warnings.push(
        `workspace "${plan.header.cwd}" is not an absolute path on this platform, so every Session from this archive needs an explicit target workspace`,
      );
    }
    if (plan.header.parentSession !== undefined && !plans.some((candidate) => candidate.id === plan.header.parentSession)) {
      warnings.push(`session ${plan.id} records parent ${plan.header.parentSession}, which is not part of this archive`);
    }
  }

  const media = await importMedia_(attachments, zip, archive, plans, { importMedia, signal, onProgress, warnings });

  const sessions = [];
  for (const plan of plans) {
    signal?.throwIfAborted();
    if (plan.header.cwd !== undefined && !isUsableWorkspace(plan.header.cwd)) {
      sessions.push({
        originalId: plan.log.header.id,
        id: plan.id,
        role: plan.log.role,
        status: 'failed',
        events: 0,
        ...(plan.title === undefined ? {} : { title: plan.title }),
        error: `workspace "${plan.header.cwd}" is not an absolute path on this platform — choose a target workspace and import again`,
      });
      continue;
    }
    try {
      const written = await writeLog(sessionPersistence, plan, signal);
      sessions.push({
        originalId: plan.log.header.id,
        id: plan.id,
        role: plan.log.role,
        status: 'restored',
        events: written,
        ...(plan.title === undefined ? {} : { title: plan.title }),
        ...(plan.header.cwd === undefined ? {} : { cwd: plan.header.cwd }),
      });
    } catch (error) {
      sessions.push({
        originalId: plan.log.header.id,
        id: plan.id,
        role: plan.log.role,
        status: 'failed',
        events: 0,
        ...(plan.title === undefined ? {} : { title: plan.title }),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const restored = sessions.filter((session) => session.status === 'restored');
  if (restored.length === 0) {
    throw new RestoreError('failed', `no Session could be restored: ${sessions.map((session) => session.error).join('; ')}`);
  }
  return { mode, sessions, media, warnings };
}

/**
 * Which archive identities are already durable in this store.
 * @param {object} sessionPersistence - mounted persistence service.
 * @param {object[]} logs - parsed logs.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<string[]>} conflicting identities.
 */
async function findConflicts(sessionPersistence, logs, signal) {
  const conflicts = [];
  for (const log of logs) {
    const snapshot = await sessionPersistence.stat(log.header.id, signal === undefined ? {} : { signal });
    if (snapshot !== undefined) conflicts.push(log.header.id);
  }
  return conflicts;
}

/**
 * The identity rewrite for every log in the archive. A copied identity keeps
 * the archived id's shape: ordinary Sessions are `session-<uuid>` and subagent
 * Sessions are bare UUIDs, and nothing downstream should have to relearn that.
 * @param {object[]} logs - parsed logs.
 * @param {'restore' | 'copy'} mode - restore policy.
 * @returns {Map<string, string>} archive id to stored id, including identity entries.
 */
function identityMap(logs, mode) {
  const map = new Map();
  for (const log of logs) {
    map.set(log.header.id, mode === 'copy' ? mintIdLike(log.header.id) : log.header.id);
  }
  return map;
}

/**
 * Mint a fresh Session identity with the same shape as an archived one.
 * @param {string} id - archived identity.
 * @returns {string} the fresh identity.
 */
function mintIdLike(id) {
  return id.startsWith('session-') ? `session-${randomUUID()}` : randomUUID();
}

/**
 * Replace every occurrence of an archived identity with its stored identity.
 *
 * Session ids are UUID-shaped, so a full-string match anywhere in an event is a
 * reference to that Session and nothing else. A few carriers — most notably
 * `tool/call.arguments` — hold JSON *text* rather than JSON structure, so a
 * string that parses as JSON is rewritten too when it mentions an archived id;
 * a string that mentions none is returned byte-identical.
 * @param {unknown} value - JSON value to rewrite.
 * @param {Map<string, string>} idMap - identity rewrite.
 * @returns {unknown} the rewritten value.
 */
function remapIds(value, idMap) {
  if (typeof value === 'string') {
    const direct = idMap.get(value);
    if (direct !== undefined) return direct;
    return remapJsonText(value, idMap);
  }
  if (Array.isArray(value)) return value.map((item) => remapIds(item, idMap));
  if (value !== null && typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value)) result[key] = remapIds(item, idMap);
    return result;
  }
  return value;
}

/**
 * Rewrite an archived identity that appears inside a JSON string field.
 * @param {string} text - candidate JSON text.
 * @param {Map<string, string>} idMap - identity rewrite.
 * @returns {string} the rewritten text, or the original when it is not JSON carrying an archived id.
 */
function remapJsonText(text, idMap) {
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return text;
  let mentions = false;
  for (const id of idMap.keys()) {
    if (text.includes(id)) {
      mentions = true;
      break;
    }
  }
  if (!mentions) return text;
  try {
    const parsed = JSON.parse(text);
    const rewritten = remapIds(parsed, idMap);
    return JSON.stringify(rewritten);
  } catch {
    return text;
  }
}

/**
 * Restore the attachments every restored log references.
 * @param {object | undefined} attachments - mounted attachment service.
 * @param {import('./zip.js').ZipFile} zip - opened archive.
 * @param {object} archive - archive model.
 * @param {object[]} plans - restore plans (event references are rewritten in place).
 * @param {{ importMedia: boolean, signal?: AbortSignal, onProgress?: Function, warnings: string[] }} options - media policy.
 * @returns {Promise<object>} media summary.
 */
async function importMedia_(attachments, zip, archive, plans, options) {
  const { importMedia, signal, onProgress, warnings } = options;
  const referenced = referencedAttachmentIds(plans.map((plan) => ({ events: plan.events })));
  const plan = planAttachments(archive, referenced);
  const summary = {
    images: plan.images.length,
    files: plan.files.length,
    restored: 0,
    missingImages: plan.missingImages,
    missingFiles: plan.missingFiles,
  };
  if (plan.missingImages.length > 0 || plan.missingFiles.length > 0) {
    warnings.push(
      `the archive does not carry every referenced attachment (${plan.missingImages.length} images, ${plan.missingFiles.length} files missing)`,
    );
  }
  if (!importMedia || attachments === undefined || summary.images + summary.files === 0) {
    if (importMedia && attachments === undefined) warnings.push('no attachment store is mounted, so images and files were not restored');
    return summary;
  }
  const restored = await restoreAttachments(attachments, zip, plan, { signal, onProgress });
  warnings.push(...restored.warnings);
  remapAttachmentRefs(plans.map((entry) => ({ events: entry.events })), { images: restored.images, files: restored.files });
  summary.restored = restored.restored;
  return summary;
}

/**
 * Write one log through the persistence seam.
 * @param {object} sessionPersistence - mounted persistence service.
 * @param {{ id: string, header: object, events: object[], log: object }} plan - restore plan.
 * @param {AbortSignal} [signal] - cancellation.
 * @returns {Promise<number>} events written.
 */
async function writeLog(sessionPersistence, plan, signal) {
  const { log, header, events } = plan;
  const createOptions = {
    ...(signal === undefined ? {} : { signal }),
    ...(header.isSeeded ? { inheritedEventCount: log.inheritedEventCount } : {}),
  };
  let handle;
  try {
    handle = await sessionPersistence.create(header, createOptions);
  } catch (error) {
    throw new RestoreError('create-failed', `could not create session "${plan.id}": ${describe(error)}`);
  }
  try {
    for (const batch of batches(events)) {
      signal?.throwIfAborted();
      await handle.append(batch, signal === undefined ? {} : { signal });
    }
    await handle.flush(signal === undefined ? {} : { signal });
  } finally {
    await handle.close().catch(() => {});
  }
  return events.length;
}

/**
 * Split a log into append batches bounded by count and approximate size.
 * @param {object[]} events - the full event log.
 * @returns {Generator<object[]>} batches in seq order.
 */
function* batches(events) {
  let batch = [];
  let bytes = 0;
  for (const event of events) {
    const size = JSON.stringify(event)?.length ?? 0;
    if (batch.length > 0 && (batch.length >= APPEND_BATCH_EVENTS || bytes + size > APPEND_BATCH_BYTES)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(event);
    bytes += size;
  }
  if (batch.length > 0) yield batch;
}

/**
 * A one-line description of a caught value.
 * @param {unknown} error - caught value.
 * @returns {string} the description.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error);
}
