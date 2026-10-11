/**
 * The permission facts an archive carries, and the ones a restored Session
 * should actually run under.
 *
 * dsh does not store a preset *label*: it folds `permission/preset`,
 * `sandbox/mode`, and `approval/policy` events and then looks the resulting
 * `(sandbox, approval)` pair up in the deployment's preset table. An archive
 * therefore carries the *other* machine's posture, and a pair this deployment
 * has no entry for resolves to `custom` — which is how an imported Session
 * silently loses "workspace write" even though it never lost a write path.
 *
 * This module reads those facts out of an archived log and writes a
 * normalizing override using exactly the events the harness itself appends.
 * @module dsh-session-restore/permissions
 */
import { KNOWN_PERMISSION_EVENT_TYPES } from './vocabulary.js';

/** The choice that keeps whatever the archive recorded. */
export const KEEP_ARCHIVE_PERMISSIONS = 'keep-archive';

/** The choice that adopts this deployment's default preset. */
export const MACHINE_DEFAULT_PERMISSIONS = 'machine-default';

/** The label reported when no available preset matches the recorded knobs. */
export const CUSTOM_PRESET = 'custom';

/**
 * Fold the durable permission facts out of an event log.
 * @param {object[]} events - events in seq order.
 * @returns {{ preset: string | null, sandbox: string | null, approval: string | null }} the last recorded value of each fact.
 */
export function readPermissionFacts(events) {
  let preset = null;
  let sandbox = null;
  let approval = null;
  for (const event of events) {
    if (KNOWN_PERMISSION_EVENT_TYPES.has(event?.type) !== true) continue;
    const data = event.data;
    if (data === null || typeof data !== 'object') continue;
    if (event.type === 'permission/preset' && typeof data.preset === 'string') preset = data.preset;
    else if (event.type === 'sandbox/mode' && typeof data.mode === 'string') sandbox = data.mode;
    else if (event.type === 'approval/policy' && typeof data.policy === 'string') approval = data.policy;
  }
  return { preset, sandbox, approval };
}

/**
 * Resolve a set of facts to a preset on this deployment, the way
 * `dsh-permission-presets` derives the effective preset for a Session.
 * @param {object} services - host services (`permissionPresets`, `shell`, `approval`).
 * @param {{ preset: string | null, sandbox: string | null, approval: string | null }} facts - folded facts.
 * @returns {{ label: string, custom: boolean, preset: string | null, sandbox: string | null, approval: string | null }} the resolved description.
 */
export function describePermissions(services, facts) {
  const presets = services.permissionPresets;
  const sandbox = facts.sandbox ?? services.shell?.sandboxMode ?? null;
  const approval = facts.approval ?? services.approval?.config?.policy ?? 'ask';
  const resolve = resolver(presets);
  const matches = (name) => {
    const spec = resolve(name);
    return spec !== undefined && spec.sandbox === sandbox && spec.approval === approval;
  };
  let label = null;
  if (typeof facts.preset === 'string' && matches(facts.preset)) label = facts.preset;
  if (label === null) label = presetNames(presets).find((name) => matches(name)) ?? null;
  return {
    label: label ?? CUSTOM_PRESET,
    custom: label === null,
    preset: facts.preset ?? null,
    sandbox,
    approval,
  };
}

/**
 * The presets this deployment offers, in catalog order.
 * @param {object | undefined} presets - the mounted `permissionPresets` service.
 * @returns {string[]} the preset names.
 */
export function presetNames(presets) {
  const names = presets?.names;
  return Array.isArray(names) ? [...names] : [];
}

/**
 * The preset a fresh Session on this deployment would start with.
 * @param {object | undefined} presets - the mounted `permissionPresets` service.
 * @returns {string | undefined} the default preset name.
 */
export function defaultPresetName(presets) {
  const name = presets?.defaultPreset;
  return typeof name === 'string' ? name : undefined;
}

/**
 * The events that pin one preset, exactly as `dsh-permission-presets` appends
 * them (`permission/preset`, then the sandbox mode, then the approval policy).
 * @param {object} services - host services (`permissionPresets`).
 * @param {string} choice - a preset name, or {@link MACHINE_DEFAULT_PERMISSIONS}.
 * @returns {{ name: string, events: Array<{ type: string, data: object }> }} the override.
 * @throws {Error} when the choice names no preset this deployment offers.
 */
export function permissionOverride(services, choice) {
  const presets = services.permissionPresets;
  if (presets === undefined) throw new Error('this deployment mounts no permission presets, so the import cannot normalize them');
  const name = choice === MACHINE_DEFAULT_PERMISSIONS ? defaultPresetName(presets) : choice;
  if (name === undefined) throw new Error('this deployment advertises no default permission preset');
  const spec = resolver(presets)(name);
  if (spec === undefined || typeof spec.sandbox !== 'string' || typeof spec.approval !== 'string') {
    throw new Error(`permission preset "${name}" is not offered here (available: ${presetNames(presets).join(', ')})`);
  }
  return {
    name,
    events: [
      { type: 'permission/preset', data: { preset: name } },
      { type: 'sandbox/mode', data: { mode: spec.sandbox } },
      { type: 'approval/policy', data: { policy: spec.approval } },
    ],
  };
}

/**
 * A name-to-knobs resolver that never throws.
 * @param {object | undefined} presets - the mounted `permissionPresets` service.
 * @returns {(name: string) => { sandbox?: string, approval?: string } | undefined} the resolver.
 */
function resolver(presets) {
  return (name) => {
    if (presets === undefined || typeof name !== 'string') return undefined;
    try {
      const spec = presets.specOf?.(name) ?? presets.resolve?.(name);
      return spec === null || typeof spec !== 'object' ? undefined : spec;
    } catch {
      return undefined;
    }
  };
}
