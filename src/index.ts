// Root entry point — MUST stay import-light.
//
// Only pure, side-effect-free symbols are re-exported here: SDK identity
// constants and the lifecycle/message helpers. This module MUST NOT statically
// import `agent-rt` (type-only peer), base-SDK instrumentation, network, or
// crypto — the runtime-bound surface lives behind the `./governance` subpath.
// `scripts/check-root-import-light.mjs` and `test/package-boundaries.test.ts`
// both enforce this.

export { SDK_VERSION } from "./version.js";
export {
  SDK_ENGINE,
  SDK_LANGUAGE,
  SDK_PACKAGE_VERSION
} from "./sdk-metadata.js";

// Lifecycle event helpers — envelope builders (snake_case session/agent
// injection). Pure; base-SDK factories only.
export {
  buildActivityCompleted,
  buildActivityStarted,
  buildSignalReceived,
  buildWorkflowCompleted,
  buildWorkflowFailed,
  buildWorkflowStarted,
  mergeSessionExtra
} from "./lifecycle-events.js";
export type {
  ActivityCompletedBuild,
  ActivityStartedBuild,
  LifecycleEventIdentity,
  SignalReceivedBuild,
  WorkflowFailedBuild
} from "./lifecycle-events.js";

// Structured-error normalization — turns anything thrown into the
// `{type, message, stack_trace?}` object Core requires (pure).
export { toErrorInfo } from "./error-info.js";

export { enrichActivityInput } from "./activity-input.js";
export {
  applyRedaction,
  coerceRedactedText,
  extractLastUserText,
  extractResponseMetadata,
  messageText
} from "./message-extraction.js";

// Non-enforcing best-effort telemetry evaluator (post-work sends).
export { evaluateLifecycleTelemetryOnly } from "./lifecycle-telemetry.js";
export type {
  Logger,
  TelemetryEvaluateOptions
} from "./lifecycle-telemetry.js";
