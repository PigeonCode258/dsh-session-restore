/**
 * Project membership: the harness groups a Session by its workspace record,
 * not by its cwd, so a restore has to register what it wrote.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ATTACH_SKIP, attachSessionToWorkspace } from '../lib/workspace.js';
import { DEMO_CWD, FakeWorkspaceRegistry } from './helpers.mjs';

/** A workspace directory that really exists, since the library stats it. */
let workspacePath;
/** A second real directory. */
let otherPath;

before(async () => {
  workspacePath = await mkdtemp(join(tmpdir(), 'dsh-session-restore-ws-'));
  otherPath = await mkdtemp(join(tmpdir(), 'dsh-session-restore-ws2-'));
});

after(async () => {
  await rm(workspacePath, { recursive: true, force: true });
  await rm(otherPath, { recursive: true, force: true });
});

test('a Session joins the project that already owns its workspace', async () => {
  const registry = new FakeWorkspaceRegistry({
    projects: [{ id: 'workspace-existing', path: workspacePath, title: 'demo' }],
  });
  const outcome = await attachSessionToWorkspace({ workspaceRegistry: registry }, { id: 'session-1', cwd: workspacePath });
  assert.equal(outcome.attached, true);
  assert.equal(outcome.created, false);
  assert.deepEqual(outcome.workspace, { id: 'workspace-existing', path: workspacePath, title: 'demo' });
  assert.deepEqual(registry.created, []);
  assert.deepEqual(registry.attached, [{ workspace: 'workspace-existing', path: workspacePath, sessionId: 'session-1' }]);
});

test('a workspace without a project gets one', async () => {
  const registry = new FakeWorkspaceRegistry();
  const outcome = await attachSessionToWorkspace({ workspaceRegistry: registry }, { id: 'session-2', cwd: otherPath });
  assert.equal(outcome.attached, true);
  assert.equal(outcome.created, true);
  assert.deepEqual(registry.created, [otherPath]);
  assert.equal(registry.projects[0].sessionIds.includes('session-2'), true);
});

test('a workspace that is not on this host is never registered', async () => {
  const registry = new FakeWorkspaceRegistry();
  const outcome = await attachSessionToWorkspace({ workspaceRegistry: registry }, { id: 'session-3', cwd: DEMO_CWD });
  assert.deepEqual(outcome, { attached: false, reason: ATTACH_SKIP.missingDirectory });
  assert.deepEqual(registry.created, []);
  assert.deepEqual(registry.attached, []);
});

test('subagents are never listed as projects own sessions', async () => {
  const registry = new FakeWorkspaceRegistry();
  const outcome = await attachSessionToWorkspace(
    { workspaceRegistry: registry },
    { id: 'child-1', cwd: workspacePath, origin: 'subagent' },
  );
  assert.deepEqual(outcome, { attached: false, reason: ATTACH_SKIP.subagent });
  assert.deepEqual(registry.attached, []);
});

test('a Session without a workspace and a deployment without a registry are both reported', async () => {
  const registry = new FakeWorkspaceRegistry();
  assert.deepEqual(
    await attachSessionToWorkspace({ workspaceRegistry: registry }, { id: 'session-4' }),
    { attached: false, reason: ATTACH_SKIP.noCwd },
  );
  assert.deepEqual(
    await attachSessionToWorkspace({}, { id: 'session-5', cwd: workspacePath }),
    { attached: false, reason: ATTACH_SKIP.noRegistry },
  );
});

test('an attach refusal propagates so the caller can report it', async () => {
  const registry = new FakeWorkspaceRegistry({
    projects: [{ id: 'workspace-existing', path: workspacePath }],
    attachFails: true,
  });
  await assert.rejects(
    () => attachSessionToWorkspace({ workspaceRegistry: registry }, { id: 'session-6', cwd: workspacePath }),
    /cannot attach session/u,
  );
});
