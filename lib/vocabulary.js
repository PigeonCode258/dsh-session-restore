/**
 * The session-event vocabulary this build understands, used to refuse an
 * archive that this harness could not read back.
 *
 * `SessionPersistence.validateStoredEvents` refuses an unknown event type
 * unless the event carries `ignorable: true`, and `create()` deliberately does
 * not run that validation — so an import that skipped this check could publish
 * a log that no later read can open. The list mirrors
 * `@deepseek-ai/dsh-session`'s generated `KNOWN_SESSION_EVENT_TYPES` for
 * session format v4.
 * @module dsh-session-restore/known-event-types
 */
export const KNOWN_SESSION_EVENT_TYPES = new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'assistant/message',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'developer/message',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/call',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'tool/result',
  'turn/end',
  'turn/start',
  'user/message',
  'web/deepseek-search-llm-request',
  'workspace/changes',
]);

/** The session log format this build reads and writes. */
export const SESSION_FORMAT_VERSION = 4;

/**
 * The events that carry a Session's permission posture. dsh folds them and
 * resolves the preset from the resulting knobs, so a restore that wants to
 * control the preset has to write through these same three events.
 */
export const KNOWN_PERMISSION_EVENT_TYPES = new Set(['permission/preset', 'sandbox/mode', 'approval/policy']);
