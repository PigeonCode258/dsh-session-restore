/**
 * Session archive restore — import a Session-log ZIP exported by DSH and put
 * the conversation back.
 *
 * The host half owns everything durable: it stages the uploaded archive,
 * previews what the archive contains, and restores each log through
 * `ctx.sessionPersistence` so the restored Sessions are ordinary stored
 * Sessions — they list in the sidebar, open in the Conversation view, and
 * resume with their full history. It also registers the `/import` command for
 * archives that already sit on this host, and provides `sessionRestore` so
 * another plugin can drive the same machinery.
 *
 * The browser half contributes the import dialog and lives in `lib/client.js`.
 * @module dsh-session-restore
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { statSync } from 'node:fs';
import { SessionRestoreService } from './service.js';
import { KEEP_ARCHIVE_PERMISSIONS } from './permissions.js';
import { Staging } from './staging.js';
import { registerRestoreRoutes } from './routes.js';

export const name = 'session-restore';

/** The connection service carries the restore routes; everything else is optional. */
export const inject = ['connection'];

/** Usage text for the host command. */
const COMMAND_USAGE = [
  '用法：/import <zip 路径> [--copy] [--no-media] [--cwd <工作区路径>] [--permission <预设> | --keep-permissions]',
  '  默认恢复到你当前会话所在的工作区，并登记到该项目；权限默认取本机默认预设。',
].join('\n');

/**
 * Register the restore service, its HTTP routes, and the `/import` command.
 * @param {object} ctx - host context.
 * @param {{ stagingTtlMs?: number, maxUploadBytes?: number, maxEntryBytes?: number }} [config] - deployment policy.
 */
export function apply(ctx, config = {}) {
  const staging = new Staging({
    root: join(resolveDshHome(), 'session-restore', 'staging'),
    ...(config.stagingTtlMs === undefined ? {} : { ttlMs: config.stagingTtlMs }),
  });
  const service = new SessionRestoreService({
    ctx,
    staging,
    config: { ...(config.maxEntryBytes === undefined ? {} : { maxEntryBytes: config.maxEntryBytes }) },
  });
  ctx.provide('sessionRestore', service);
  void staging.sweep().catch(() => {});
  registerRestoreRoutes(ctx, service, {
    ...(config.maxUploadBytes === undefined ? {} : { maxUploadBytes: config.maxUploadBytes }),
  });
  ctx.inject(['commands'], (scope) => {
    scope.effect(() => scope.commands.register({
      name: 'import',
      description: 'Restore Sessions from a Session-log ZIP exported by DSH',
      handler: (invocation) => importCommand(service, invocation),
    }), 'session-restore: /import command');
  });
}

/**
 * The `/import` command: restore one archive that already exists on this host.
 * @param {SessionRestoreService} service - restore service.
 * @param {object} invocation - command invocation carrying the raw input and agent.
 * @returns {Promise<{ kind: 'success', text: string } | { kind: 'error', text: string }>} the command result.
 */
async function importCommand(service, invocation) {
  const parsed = parseCommandInput(invocation.rawInput);
  if (parsed === undefined) return { kind: 'error', text: COMMAND_USAGE };
  const filePath = resolve(parsed.path);
  if (!isFile(filePath)) return { kind: 'error', text: `找不到文件：${filePath}` };
  try {
    const { result } = await service.importFile(filePath, {
      mode: parsed.copy ? 'copy' : undefined,
      cwd: parsed.cwd === undefined ? undefined : resolve(parsed.cwd),
      importMedia: !parsed.noMedia,
      ...(parsed.permissions === undefined ? {} : { permissions: parsed.permissions }),
      sessionId: invocation.agent?.id,
      signal: invocation.signal,
    });
    return { kind: 'success', text: summarize(result) };
  } catch (error) {
    return { kind: 'error', text: `导入失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Parse the command's raw input into a path plus options.
 * @param {string} rawInput - everything after the command name.
 * @returns {{ path: string, copy: boolean, noMedia: boolean, cwd?: string, permissions?: string } | undefined} the parsed input, or undefined when nothing usable was typed.
 */
function parseCommandInput(rawInput) {
  const tokens = tokenize(rawInput);
  if (tokens.length === 0) return undefined;
  let path;
  let copy = false;
  let noMedia = false;
  let cwd;
  let permissions;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--copy' || token === '-c') copy = true;
    else if (token === '--no-media') noMedia = true;
    else if (token === '--keep-permissions') permissions = KEEP_ARCHIVE_PERMISSIONS;
    else if (token === '--permission') {
      permissions = tokens[index + 1];
      index += 1;
      if (permissions === undefined) return undefined;
    } else if (token.startsWith('--permission=')) permissions = token.slice('--permission='.length);
    else if (token === '--cwd') {
      cwd = tokens[index + 1];
      index += 1;
      if (cwd === undefined) return undefined;
    } else if (token.startsWith('--cwd=')) cwd = token.slice('--cwd='.length);
    else if (path === undefined) path = token;
    else return undefined;
  }
  if (path === undefined) return undefined;
  return { path, copy, noMedia, ...(cwd === undefined ? {} : { cwd }), ...(permissions === undefined ? {} : { permissions }) };
}

/**
 * Split command input on whitespace, honoring single and double quotes.
 * @param {string} input - raw command input.
 * @returns {string[]} the tokens.
 */
function tokenize(input) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/gu;
  let match;
  while ((match = pattern.exec(input)) !== null) tokens.push(match[1] ?? match[2] ?? match[3]);
  return tokens;
}

/**
 * Whether a path names an existing regular file.
 * @param {string} path - candidate path.
 * @returns {boolean} true when the path is a readable file.
 */
function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * A one-line summary of a completed restore.
 * @param {object} result - restore result.
 * @returns {string} the summary text.
 */
function summarize(result) {
  const restored = result.sessions.filter((session) => session.status === 'restored');
  const failed = result.sessions.filter((session) => session.status === 'failed');
  const root = restored.find((session) => session.role === 'root');
  const lines = [
    `已恢复 ${restored.length} 个会话（${result.mode === 'copy' ? '副本模式，使用新会话 ID' : '原样恢复，保留原会话 ID'}）：`,
  ];
  for (const session of restored) {
    const label = session.title === undefined ? '' : ` · ${session.title}`;
    lines.push(`- ${session.role === 'root' ? '根会话' : '子会话'} ${session.id}（${session.events} 条事件）${label}`);
  }
  if (result.media.restored > 0) lines.push(`- 附件：恢复 ${result.media.restored} 个`);
  if (root !== undefined) {
    lines.push(root.attachment?.attached === true
      ? `- 工作区：已归入项目「${root.attachment.workspace?.title ?? ''}」（${root.attachment.workspace?.path ?? ''}）${root.attachment.created === true ? '，该项目为本次新建' : ''}`
      : '- 工作区：未登记到项目（见下方提示），会话会出现在未分组里');
    const archivedPermissions = root.permissions?.archived;
    const applied = root.permissions?.applied;
    if (archivedPermissions !== undefined) {
      lines.push(applied === null || applied === undefined
        ? `- 权限：沿用归档（${archivedPermissions}）`
        : `- 权限：归档为 ${archivedPermissions}，已设为 ${applied}`);
    }
  }
  if (failed.length > 0) {
    lines.push(`失败 ${failed.length} 个：`);
    for (const session of failed) lines.push(`- ${session.originalId}：${session.error ?? '未知错误'}`);
  }
  if (result.warnings.length > 0) {
    lines.push('提示：');
    for (const warning of result.warnings.slice(0, 6)) lines.push(`- ${warning}`);
  }
  if (root !== undefined) lines.push(`在左侧会话列表中打开：${root.id}`);
  return lines.join('\n');
}

/**
 * Resolve the harness home directory the way the harness itself does.
 * @returns {string} the absolute `DSH_HOME`.
 */
function resolveDshHome() {
  const configured = process.env.DSH_HOME;
  if (typeof configured === 'string' && configured.trim() !== '') return resolve(configured.trim());
  return join(homedir(), '.dsh');
}
