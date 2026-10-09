// Runtime-bound entry point (`@openbox-ai/openbox-agentrt-governance/governance`).
//
// Unlike the package root, this surface imports the base-SDK runtime and
// instrumentation; it is the only module graph that does.

export { createOpenBoxAgentRT } from "./factory.js";
export { OpenBoxAgentRTGovernance } from "./governance.js";
export { GovernedAgentLoop } from "./loop.js";
export { wrapModelProvider } from "./model-provider.js";
export {
  DEFAULT_APPROVAL_MAX_WAIT_MS,
  resolveGovernanceOptions
} from "./options.js";
export type {
  AgentRTGovernanceOptions,
  ResolvedGovernanceOptions
} from "./options.js";
export { runScope } from "./run-scope.js";
export { currentRun, requireRun } from "./run-state.js";
export type { PreScreenSummary, RunState } from "./run-state.js";
export {
  governToolCall,
  wrapToolExecutor,
  wrapToolRegistry
} from "./tool-governance.js";
export type { GovernanceContext } from "./context.js";
