// OpenBoxAgentRTGovernance — the governance core for Agent-RT.
//
// Owns exactly ONE `OpenBoxRuntime` and exposes:
//   runScope(prompt, body)  -> WorkflowStarted -> SignalReceived (enforce)
//                              -> pre-screen (enforce) ... WorkflowCompleted/Failed
//   wrapProvider(p)         -> LLMStarted (enforce + redaction) -> model -> LLMCompleted
//   wrapToolRegistry(r)     -> ToolStarted (enforce) -> tool (scope) -> ToolCompleted
//   wrapToolExecutor(e)     -> same, for a plain `ToolExecutor`
//   governLoop(loop)        -> all of the above bundled around an `AgentLoop`

import type { GovernanceContext } from "./context.js";
import { GovernedAgentLoop } from "./loop.js";
import { wrapModelProvider } from "./model-provider.js";
import { runScope } from "./run-scope.js";
import type { RunState } from "./run-state.js";
import { wrapToolExecutor, wrapToolRegistry } from "./tool-governance.js";
import type { OpenBoxInstrumentationController } from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import type {
  AgentLoop,
  ModelProvider,
  ToolExecutor,
  ToolRegistry
} from "agent-rt";

export class OpenBoxAgentRTGovernance {
  constructor(
    private readonly ctx: GovernanceContext,
    readonly instrumentation: OpenBoxInstrumentationController | null = null
  ) {}

  get runtime(): OpenBoxRuntime {
    return this.ctx.runtime;
  }

  /** Bind a governed run for the duration of `body`; set `run.output` to report a result. */
  runScope<T>(prompt: string, body: (run: RunState) => Promise<T>): Promise<T> {
    return runScope(this.ctx, prompt, body);
  }

  wrapProvider<P extends ModelProvider>(provider: P): P {
    return wrapModelProvider(this.ctx, provider);
  }

  wrapToolRegistry(registry: ToolRegistry): ToolRegistry {
    return wrapToolRegistry(this.ctx, registry);
  }

  wrapToolExecutor<E extends ToolExecutor>(executor: E): E {
    return wrapToolExecutor(this.ctx, executor);
  }

  governLoop(loop: AgentLoop): GovernedAgentLoop {
    return new GovernedAgentLoop(this.ctx, loop);
  }

  /**
   * Idempotent: drains in-flight sync-fs completed telemetry (`flush()`), then
   * shuts down instrumentation (if any), then closes the runtime.
   */
  async close(): Promise<void> {
    await this.instrumentation?.flush();
    this.instrumentation?.shutdown();
    this.ctx.runtime.close();
  }
}
