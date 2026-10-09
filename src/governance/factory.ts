// createOpenBoxAgentRT — the SOLE entry point for Agent-RT governance.
//
// Builds one runtime (client -> ApprovalPoller -> CoreAdapter -> OpenBoxRuntime),
// validates the API key, installs base instrumentation (default-ON, collision-
// safe), and returns the governance object whose wrappers fail closed by
// throwing before the governed call runs.

import {
  initOpenBoxInstrumentation,
  OpenBoxInstrumentationError,
  type InitOpenBoxInstrumentationOptions,
  type OpenBoxInstrumentationController
} from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { GovernanceContext } from "./context.js";
import { OpenBoxAgentRTGovernance } from "./governance.js";
import {
  resolveGovernanceOptions,
  type AgentRTGovernanceOptions
} from "./options.js";
import { buildGovernanceRuntime } from "./runtime-builder.js";

export async function createOpenBoxAgentRT(
  options: AgentRTGovernanceOptions = {}
): Promise<OpenBoxAgentRTGovernance> {
  // Resolve behavior options before allocating a runtime or installing hooks.
  const resolved = resolveGovernanceOptions(options);
  const runtime = options.runtime ?? buildGovernanceRuntime(options);

  let instrumentation: OpenBoxInstrumentationController | null;
  try {
    // Fast-fail on a bad API key, signing key, or workload identity: Core
    // validates every request anyway.
    if (options.validate ?? true) await runtime.client.validateApiKey();
    instrumentation = installInstrumentation(runtime, options);
  } catch (error) {
    // Release a runtime we built; an injected runtime stays the caller's.
    if (options.runtime === undefined) runtime.close();
    throw error;
  }
  const ctx: GovernanceContext = {
    runtime,
    options: resolved,
    workflowType: options.agentName ?? "AgentRTRun"
  };
  return new OpenBoxAgentRTGovernance(ctx, instrumentation);
}

/** Install base instrumentation, tolerating a second active runtime in the process. */
function installInstrumentation(
  runtime: OpenBoxRuntime,
  options: AgentRTGovernanceOptions
): OpenBoxInstrumentationController | null {
  if (options.installInstrumentation === false) return null;
  const strict = options.instrumentationStrict ?? false;
  const initOptions: InitOpenBoxInstrumentationOptions = options.databases
    ? { runtime, strict, databases: options.databases }
    : { runtime, strict };
  try {
    return initOpenBoxInstrumentation(initOptions);
  } catch (error) {
    if (error instanceof OpenBoxInstrumentationError) {
      options.logger?.warn(
        "another OpenBox runtime already instruments this process; continuing " +
          "WITHOUT instrumentation for this agent — governance is still enforced, " +
          "but HTTP/DB/file hook spans for this agent are not captured"
      );
      return null;
    }
    throw error;
  }
}
