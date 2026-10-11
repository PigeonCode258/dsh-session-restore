/**
 * Grouping a restored Session into a project.
 *
 * A Session belongs to a workspace only when that workspace's recorded
 * `sessionIds` accounts for it — the address book is the source of truth, and
 * a cwd alone leaves the Session in the sidebar's Ungrouped bucket. The
 * harness registers its own Sessions this way
 * (`dsh-api-session-controller`: `cwd = workspace.path`, then
 * `workspace.attachSession(sessionId)`), so a restore has to do the same or
 * the Session it just wrote will not appear where the person chose to put it.
 * @module dsh-session-restore/workspace
 */
import { statSync } from 'node:fs';

/** Why one Session was not attached, when it was not. */
export const ATTACH_SKIP = {
  noRegistry: 'no-workspace-registry',
  noCwd: 'no-cwd',
  subagent: 'subagent',
  missingDirectory: 'workspace-directory-missing',
};

/**
 * Register one restored Session with the project its workspace sits in,
 * creating the project record when the directory is not one yet.
 * @param {object} services - host services (`workspaceRegistry`).
 * @param {{ id: string, cwd?: string, origin?: string }} session - the restored Session.
 * @returns {Promise<{ attached: boolean, reason?: string, created?: boolean, workspace?: { id: string, path: string, title: string } }>} the outcome.
 */
export async function attachSessionToWorkspace(services, session) {
  const registry = services.workspaceRegistry;
  if (registry === undefined) return { attached: false, reason: ATTACH_SKIP.noRegistry };
  if (session.origin === 'subagent') return { attached: false, reason: ATTACH_SKIP.subagent };
  if (session.cwd === undefined || session.cwd === '') return { attached: false, reason: ATTACH_SKIP.noCwd };
  // A project is a directory: registering or attaching to a path that is not
  // there would either throw or create a project pointing at nothing.
  if (!directoryExists(session.cwd)) return { attached: false, reason: ATTACH_SKIP.missingDirectory };
  let workspace;
  let created = false;
  try {
    workspace = await registry.resolveByPath(session.cwd);
  } catch {
    // `resolveByPath` rejects when the path itself cannot be canonicalized;
    // `create` below is the fallback that reports the real problem.
    workspace = undefined;
  }
  if (workspace === undefined) {
    workspace = await registry.create(session.cwd);
    created = true;
  }
  await workspace.attachSession(session.id);
  return {
    attached: true,
    created,
    workspace: {
      id: String(workspace.id),
      path: String(workspace.path),
      title: String(workspace.title ?? ''),
    },
  };
}

/**
 * Whether a path exists and is a directory.
 * @param {string} path - candidate workspace directory.
 * @returns {boolean} true when the directory exists.
 */
function directoryExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
