// Per-run state for governed Agent-RT runs.
//
// Run identity lives in an `AsyncLocalStorage` bound by `runScope` — never on the
// governance instance — so concurrent `AgentLoop.run` calls on one instance
// cannot cross-contaminate. ALS propagates through every await and into
// concurrent tool calls, so the governed provider and tool wrappers see the run
// that spawned them.

import { AsyncLocalStorage } from "node:async_hooks";

/** Serializable summary of the pre-screen verdict, reused by the first model call. */
export interface PreScreenSummary {
  activityId: string;
  /** The prompt the pre-screen evaluated; only a model call for this same prompt reuses it. */
  prompt: string;
  /** The coerced redacted-input string to splice into the first model request, or null. */
  redactedInput: string | null;
}

export interface RunState {
  workflowId: string;
  runId: string;
  preScreen: PreScreenSummary | null;
  /** True once the first model call consumed the pre-screen verdict. */
  preScreenUsed: boolean;
  /** Set by whichever enforcing gate closed the workflow, so `runScope` does not double-close. */
  workflowClosed: boolean;
  /** Workflow result reported on WorkflowCompleted. */
  output: unknown;
  /**
   * Activity rows opened in this run and not yet closed (activity id -> type).
   * A promise cannot be cancelled, so an `AgentLoop` deadline or abort can
   * abandon a governed call mid-flight; `runScope` closes whatever is still
   * open here before it closes the workflow, and a late completion is dropped.
   */
  openActivities: Map<string, string>;
}

const storage = new AsyncLocalStorage<RunState>();

export function runWithState<T>(state: RunState, fn: () => T): T {
  return storage.run(state, fn);
}

export function currentRun(): RunState | undefined {
  return storage.getStore();
}

/** Fail closed: governed calls outside a run scope are a wiring bug. */
export function requireRun(): RunState {
  const run = storage.getStore();
  if (run === undefined) {
    throw new Error(
      "OpenBox governance: no active run — execute the agent through " +
        "governance.runScope(...) or a GovernedAgentLoop"
    );
  }
  return run;
}

/** Mint a fresh workflow/run identity. The random suffix guarantees uniqueness. */
export function mintRunState(prefix: string): RunState {
  const token = globalThis.crypto.randomUUID().replaceAll("-", "");
  return {
    workflowId: `${prefix}-${token.slice(0, 16)}`,
    runId: `${prefix}-run-${token.slice(16, 32)}`,
    preScreen: null,
    preScreenUsed: false,
    workflowClosed: false,
    output: null,
    openActivities: new Map()
  };
}
