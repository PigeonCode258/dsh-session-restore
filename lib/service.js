/**
 * The programmatic restore surface shared by the `/import` command, the HTTP
 * routes, and any other plugin that asks for `sessionRestore`.
 *
 * Preview and commit are deliberately separate: preview reads an archive and
 * reports exactly what a restore would produce without touching the session
 * store, and commit re-reads the same staged archive and writes it. Nothing is
 * cached between the two, so a stale preview can never become a wrong write.
 * @module dsh-session-restore/service
 */
import { createReadStream, statSync } from 'node:fs';
import {
  firstUserTextOf,
  isUsableWorkspace,
  readSessionArchive,
  referencedAttachmentIds,
  sessionTitleOf,
} from './archive.js';
import { ZipFile } from './zip.js';
import { RestoreError, restoreArchive } from './restore.js';
import { planAttachments } from './media.js';

/** Workspaces offered in the import dialog. */
const WORKSPACE_SAMPLE_LIMIT = 20;

/** Sessions sampled when building the workspace list. */
const WORKSPACE_SCAN_LIMIT = 2000;

/** One archive refusal that a caller cannot fix by retrying. */
export { RestoreError };

/** Session archive restore: preview, commit, discard. */
export class SessionRestoreService {
  /**
   * @param {object} options - service wiring.
   * @param {object} options.ctx - host context carrying the Session services.
   * @param {import('./staging.js').Staging} options.staging - staged upload store.
   * @param {{ maxEntryBytes?: number }} [options.config] - read limits.
   */
  constructor(options) {
    this.ctx = options.ctx;
    this.staging = options.staging;
    this.maxEntryBytes = options.config?.maxEntryBytes ?? 512 * 1024 * 1024;
  }

  /**
   * Read one archive and describe what restoring it would do.
   * @param {string} filePath - archive path on the host.
   * @param {{ sessionId?: string, fileName?: string, signal?: AbortSignal }} [options] - dialog context.
   * @returns {Promise<object>} the preview payload.
   * @throws {RestoreError} when the archive cannot be restored at all.
   */
  async preview(filePath, options = {}) {
    const { sessionId, fileName, signal } = options;
    const persistence = this.persistence();
    const zip = await ZipFile.open(filePath);
    try {
      const archive = await readSessionArchive(zip, { maxEntryBytes: this.maxEntryBytes, signal });
      const referenced = referencedAttachmentIds(archive.logs);
      const attachmentPlan = planAttachments(archive, referenced);
      const conflicts = [];
      for (const log of archive.logs) {
        const snapshot = await persistence.stat(log.header.id, signal === undefined ? {} : { signal });
        if (snapshot !== undefined) conflicts.push(log.header.id);
      }
      const workspaces = await this.listWorkspaces(signal);
      const rootCwd = archive.root.header.cwd;
      // A workspace is only a candidate when this platform could store it and
      // the directory is actually here; otherwise the dialog offers a target
      // this host already uses.
      const suggestedCwd = rootCwd !== undefined && isUsableWorkspace(rootCwd) && directoryExists(rootCwd)
        ? rootCwd
        : (await this.workspaceOf(sessionId, signal)) ?? workspaces[0]?.cwd;
      return {
        fileName: fileName ?? baseNameOf(filePath),
        root: this.describe(archive.root, { conflicts, root: true }),
        descendants: archive.logs.slice(1).map((log) => this.describe(log, { conflicts })),
        attachments: {
          images: attachmentPlan.images.length,
          files: attachmentPlan.files.length,
          missingImages: attachmentPlan.missingImages.length,
          missingFiles: attachmentPlan.missingFiles.length,
          unreferencedImages: attachmentPlan.unreferencedImages,
          unreferencedFiles: attachmentPlan.unreferencedFiles,
          storeAvailable: this.attachments() !== undefined,
        },
        unknownEntries: archive.unknown.length,
        workspaces,
        suggestedCwd: suggestedCwd ?? null,
        conflicts,
        warnings: [...archive.warnings, ...archive.logs.flatMap((log) => log.warnings)],
      };
    } finally {
      await zip.close();
    }
  }

  /**
   * Restore a staged archive.
   * @param {{ token: string, mode?: 'restore' | 'copy', cwd?: string, importMedia?: boolean, signal?: AbortSignal }} request - commit request.
   * @returns {Promise<object>} the restore result, including the restored root id.
   * @throws {RestoreError} when the staged archive is gone or nothing could be restored.
   */
  async commit(request) {
    const path = await this.staging.resolve(request.token);
    if (path === undefined) {
      throw new RestoreError('staged-upload-missing', 'the uploaded archive is no longer staged; choose the file again');
    }
    const zip = await ZipFile.open(path);
    try {
      const archive = await readSessionArchive(zip, { maxEntryBytes: this.maxEntryBytes, signal: request.signal });
      const result = await restoreArchive(
        { sessionPersistence: this.persistence(), attachments: this.attachments(), archive, zip },
        {
          mode: request.mode === 'copy' ? 'copy' : 'restore',
          ...(request.cwd === undefined || request.cwd === '' ? {} : { cwd: request.cwd }),
          importMedia: request.importMedia !== false,
          signal: request.signal,
        },
      );
      const root = result.sessions.find((session) => session.role === 'root' && session.status === 'restored');
      return { ...result, rootId: root?.id ?? null };
    } finally {
      await zip.close();
      await this.staging.discard(request.token);
    }
  }

  /**
   * Drop one staged upload without restoring it.
   * @param {unknown} token - staging token.
   * @returns {Promise<boolean>} whether a staged file was removed.
   */
  async discard(token) {
    return this.staging.discard(token);
  }

  /**
   * Restore one host-side archive in a single call — the `/import` command's
   * path, where there is no browser dialog to confirm a preview.
   * @param {string} filePath - archive path on the host.
   * @param {{ mode?: 'restore' | 'copy', cwd?: string, importMedia?: boolean, sessionId?: string, signal?: AbortSignal }} [options] - restore policy.
   * @returns {Promise<{ preview: object, result: object }>} the preview and the restore result.
   */
  async importFile(filePath, options = {}) {
    const preview = await this.preview(filePath, { sessionId: options.sessionId, signal: options.signal });
    const staged = await this.stagePath(filePath);
    try {
      const result = await this.commit({
        token: staged.token,
        mode: options.mode ?? (preview.conflicts.length > 0 ? 'copy' : 'restore'),
        cwd: options.cwd ?? this.defaultCwd(preview),
        importMedia: options.importMedia,
        signal: options.signal,
      });
      return { preview, result };
    } finally {
      await this.staging.discard(staged.token);
    }
  }

  /**
   * Stage an existing host file so the commit path has a single source shape.
   * The file is streamed through the same staging writer the upload route
   * uses, so a large archive is never held in memory.
   * @param {string} filePath - archive path.
   * @returns {Promise<{ token: string }>} the staging token.
   */
  async stagePath(filePath) {
    const staged = await this.staging.stage(createReadStream(filePath));
    return { token: staged.token };
  }

  /**
   * The workspace a command-line import should target: the archive's own
   * workspace when it exists here, otherwise the invoking Session's.
   * @param {object} preview - preview payload.
   * @returns {string | undefined} the workspace to restore into.
   */
  defaultCwd(preview) {
    if (preview.root.cwd !== undefined && preview.root.cwdExists && preview.root.cwdUsable) return preview.root.cwd;
    return preview.suggestedCwd ?? undefined;
  }

  /**
   * The stored workspace of one Session, when it has one.
   * @param {string | undefined} sessionId - Session to look up.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<string | undefined>} that Session's workspace.
   */
  async workspaceOf(sessionId, signal) {
    if (sessionId === undefined || sessionId === '') return undefined;
    const snapshot = await this.persistence().stat(sessionId, signal === undefined ? {} : { signal });
    return snapshot?.header.cwd;
  }

  /**
   * Workspaces this harness already stores Sessions under, newest first.
   * @param {AbortSignal} [signal] - cancellation.
   * @returns {Promise<Array<{ cwd: string, sessions: number, lastCreatedAt: number }>>} the workspace list.
   */
  async listWorkspaces(signal) {
    let snapshots;
    try {
      snapshots = await this.persistence().list(signal === undefined ? {} : { signal });
    } catch {
      return [];
    }
    const byCwd = new Map();
    for (const snapshot of snapshots.slice(0, WORKSPACE_SCAN_LIMIT)) {
      const cwd = snapshot.header.cwd;
      if (cwd === undefined) continue;
      const entry = byCwd.get(cwd) ?? { cwd, sessions: 0, lastCreatedAt: 0 };
      entry.sessions += 1;
      entry.lastCreatedAt = Math.max(entry.lastCreatedAt, snapshot.header.createdAt);
      byCwd.set(cwd, entry);
    }
    return [...byCwd.values()]
      .sort((left, right) => right.lastCreatedAt - left.lastCreatedAt)
      .slice(0, WORKSPACE_SAMPLE_LIMIT);
  }

  /**
   * One log as the dialog needs it.
   * @param {object} log - parsed log.
   * @param {{ conflicts: string[], root?: boolean }} context - preview context.
   * @returns {object} the log summary.
   */
  describe(log, context) {
    return {
      id: log.header.id,
      role: log.role,
      root: context.root === true,
      title: sessionTitleOf(log) ?? null,
      excerpt: firstUserTextOf(log) ?? null,
      createdAt: log.header.createdAt,
      cwd: log.header.cwd ?? null,
      cwdExists: log.header.cwd === undefined ? false : directoryExists(log.header.cwd),
      cwdUsable: log.header.cwd === undefined ? true : isUsableWorkspace(log.header.cwd),
      parentSession: log.header.parentSession ?? null,
      origin: log.header.origin ?? null,
      agentPreset: log.header.agentPreset ?? null,
      isSeeded: log.header.isSeeded,
      delegationDepth: log.header.delegationDepth,
      events: log.events.length,
      legacy: log.legacy,
      conflict: context.conflicts.includes(log.header.id),
    };
  }

  /**
   * The mounted persistence service.
   * @returns {object} the service.
   * @throws {RestoreError} when the deployment does not mount persistence.
   */
  persistence() {
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new RestoreError('persistence-unavailable', 'this deployment mounts no session persistence, so Sessions cannot be restored');
    }
    return persistence;
  }

  /**
   * The mounted attachment service, when the deployment has one.
   * @returns {object | undefined} the service.
   */
  attachments() {
    return this.ctx.get('attachments');
  }
}

/**
 * The base name of a host path, on either separator convention.
 * @param {string} path - host path.
 * @returns {string} the final path segment.
 */
function baseNameOf(path) {
  return path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
}

/**
 * Whether a path exists and is a directory.
 * @param {string} path - candidate workspace.
 * @returns {boolean} true when the path is an existing directory.
 */
function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
