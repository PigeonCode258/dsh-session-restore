/**
 * Permission facts: reading what an archive recorded, resolving it against
 * this deployment's catalog, and writing the normalizing override.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CUSTOM_PRESET,
  KEEP_ARCHIVE_PERMISSIONS,
  MACHINE_DEFAULT_PERMISSIONS,
  defaultPresetName,
  describePermissions,
  permissionOverride,
  presetNames,
  readPermissionFacts,
} from '../lib/permissions.js';
import { FakePermissionPresets, conversationLog, event } from './helpers.mjs';

/** This deployment's catalog, as the profile configures it. */
const presets = new FakePermissionPresets();

/**
 * The three events dsh writes to pin a permission posture.
 * @param {number} startSeq - first sequence number.
 * @param {{ preset: string | null, sandbox: string, approval: string }} posture - the posture.
 * @returns {object[]} the events.
 */
function permissionEvents(startSeq, posture) {
  const events = [];
  let seq = startSeq;
  if (posture.preset !== null) events.push(event(seq, 'permission/preset', { preset: posture.preset }));
  if (posture.preset !== null) seq += 1;
  events.push(event(seq, 'sandbox/mode', { mode: posture.sandbox }));
  events.push(event(seq + 1, 'approval/policy', { policy: posture.approval }));
  return events;
}

test('readPermissionFacts folds the last value of each fact', () => {
  const { events } = conversationLog({ extraEvents: [
    ...permissionEvents(7, { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }),
    { type: 'approval/policy', seq: 10, time: 1, data: { policy: 'never' } },
  ] });
  const facts = readPermissionFacts(events);
  assert.deepEqual(facts, { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never' });
});

test('describePermissions matches the catalog by knobs, not by the recorded label', () => {
  const services = { permissionPresets: presets, shell: { sandboxMode: 'workspace-write' }, approval: { config: { policy: 'ask' } } };
  assert.equal(describePermissions(services, { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'ask' }).label, 'workspace-write');
  // The combination this machine has no entry for is what an import usually hits.
  const mismatched = describePermissions(services, { preset: 'workspace-write', sandbox: 'workspace-write', approval: 'never' });
  assert.equal(mismatched.label, CUSTOM_PRESET);
  assert.equal(mismatched.custom, true);
  // A stale label that no longer matches its own knobs is not trusted either.
  assert.equal(describePermissions(services, { preset: 'danger-full-access', sandbox: 'workspace-write', approval: 'ask' }).label, 'workspace-write');
  // Missing facts fall back to the deployment's effective knobs.
  assert.equal(describePermissions(services, { preset: null, sandbox: null, approval: null }).label, 'workspace-write');
});

test('describePermissions without a catalog reports the raw facts', () => {
  const described = describePermissions({}, { preset: null, sandbox: 'workspace-write', approval: 'never' });
  assert.equal(described.label, CUSTOM_PRESET);
  assert.equal(described.sandbox, 'workspace-write');
  assert.equal(described.approval, 'never');
  assert.deepEqual(presetNames(undefined), []);
  assert.equal(defaultPresetName(undefined), undefined);
});

test('permissionOverride writes exactly the events the harness writes', () => {
  const override = permissionOverride({ permissionPresets: presets }, MACHINE_DEFAULT_PERMISSIONS);
  assert.equal(override.name, 'workspace-write');
  assert.deepEqual(override.events, [
    { type: 'permission/preset', data: { preset: 'workspace-write' } },
    { type: 'sandbox/mode', data: { mode: 'workspace-write' } },
    { type: 'approval/policy', data: { policy: 'ask' } },
  ]);
  const named = permissionOverride({ permissionPresets: presets }, 'read-only');
  assert.equal(named.name, 'read-only');
  assert.deepEqual(named.events[1], { type: 'sandbox/mode', data: { mode: 'read-only' } });
});

test('permissionOverride refuses names this deployment does not offer', () => {
  assert.throws(() => permissionOverride({ permissionPresets: presets }, 'auto'), /not offered here/u);
  assert.throws(() => permissionOverride({}, MACHINE_DEFAULT_PERMISSIONS), /mounts no permission presets/u);
});

test('the default choice is not the archive-keeping constant', () => {
  assert.notEqual(MACHINE_DEFAULT_PERMISSIONS, KEEP_ARCHIVE_PERMISSIONS);
});
