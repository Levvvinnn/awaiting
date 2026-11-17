// Public API of @awaiting/core. Test fixtures live on the separate `@awaiting/core/fixtures` entry.
export { elapsedMs } from './time.js';

export {
  AWAITING_HOME_ENV,
  DATA_DIR_NAME,
  resolveDataDir,
  separatorForPlatform,
  type DataDirInput,
  type PathSeparator,
} from './paths.js';

export {
  ACTIONABLE_NOTIFICATION_TYPES,
  HOOK_EVENT_NAMES,
  TOOL_EVENT_NAMES,
  isActionableNotificationType,
  isHookEventName,
  isToolEventName,
  type ActionableNotificationType,
  type HookEventName,
  type ToolEventName,
} from './events/names.js';
export {
  EVENT_DATA_KEYS,
  INVALID_FIELDS_KEY,
  PARSE_ERROR_CODES,
  STRING_LIMITS,
  type JsonObject,
  type JsonValue,
  type NormalizedEvent,
  type ParseErrorCode,
  type ParseOptions,
  type ParseResult,
  type PromptFeatures,
  type SanitizeInput,
  type SanitizeResult,
  type ToolInputSummary,
} from './events/types.js';
export { parseHookEvent } from './events/parse.js';
export { promptFeatures } from './events/prompt-features.js';
export { sanitizeEventData } from './events/sanitize.js';
export { summarizeToolInput } from './events/tool-input.js';

export {
  DEFAULT_TURN_CONFIG,
  END_REASONS,
  MAX_INFLIGHT_TOOLS,
  MAX_KNOWN_SUBAGENTS,
  REOPENABLE_END_REASONS,
  TURN_STATUSES,
  type ClosedTurnStatus,
  type EndReason,
  type SessionTurnState,
  type TurnConfig,
  type TurnEffect,
  type TurnRef,
  type TurnStatus,
  type TurnStepResult,
} from './turns/types.js';
export { stepTurn, sweepInactive } from './turns/machine.js';

export {
  DEFAULT_REORDER_WINDOW_MS,
  takeReady,
  type Pending,
  type TakeReadyResult,
} from './ingest/reorder.js';
