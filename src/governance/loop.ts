// GovernedAgentLoop — an `AgentLoop` whose provider, registry, and executor are governed.

import { extractLastUserText, messageText } from "../message-extraction.js";
import type { GovernanceContext } from "./context.js";
import { wrapModelProvider } from "./model-provider.js";
import { runScope } from "./run-scope.js";
import { wrapToolExecutor, wrapToolRegistry } from "./tool-governance.js";
import type { AgentLoop, AgentRunResult } from "agent-rt";

type RunArgs = Parameters<AgentLoop["run"]>;
type RunStreamingArgs = Parameters<AgentLoop["runStreaming"]>;

/**
 * Shallow-clone an `AgentLoop` with governed seams. The original loop is not
 * mutated; the clone keeps the prototype (so every method works) and shadows
 * `provider` / `toolRegistry` / `toolExecutor` with their wrapped versions.
 */
function cloneWithGovernedSeams(
  ctx: GovernanceContext,
  loop: AgentLoop
): AgentLoop {
  const seams = loop as unknown as Record<string, unknown>;
  const clone = Object.assign(
    Object.create(Object.getPrototypeOf(loop) as object),
    loop
  ) as Record<string, unknown>;
  clone.provider = wrapModelProvider(
    ctx,
    seams.provider as Parameters<typeof wrapModelProvider>[1]
  );
  if (seams.toolRegistry) {
    clone.toolRegistry = wrapToolRegistry(
      ctx,
      seams.toolRegistry as Parameters<typeof wrapToolRegistry>[1]
    );
  }
  if (seams.toolExecutor) {
    clone.toolExecutor = wrapToolExecutor(
      ctx,
      seams.toolExecutor as Parameters<typeof wrapToolExecutor>[1]
    );
  }
  return clone as unknown as AgentLoop;
}

function summarize(result: AgentRunResult): Record<string, unknown> {
  return {
    result: result.finalResponse
      ? messageText(result.finalResponse.message)
      : null,
    termination_reason: result.terminationReason,
    turns: result.turns,
    tool_calls: result.toolCalls,
    total_tokens: result.totalTokens
  };
}

export class GovernedAgentLoop {
  private readonly loop: AgentLoop;

  constructor(
    private readonly ctx: GovernanceContext,
    loop: AgentLoop
  ) {
    this.loop = cloneWithGovernedSeams(ctx, loop);
  }

  /** Same signature as `AgentLoop.run`, executed inside a governed run scope. */
  run(...args: RunArgs): Promise<AgentRunResult> {
    return runScope(this.ctx, extractLastUserText(args[1]), async (run) => {
      const result = await this.loop.run(...args);
      run.output = summarize(result);
      return result;
    });
  }

  /** Same signature as `AgentLoop.runStreaming`, executed inside a governed run scope. */
  runStreaming(...args: RunStreamingArgs): Promise<AgentRunResult> {
    return runScope(this.ctx, extractLastUserText(args[1]), async (run) => {
      const result = await this.loop.runStreaming(...args);
      run.output = summarize(result);
      return result;
    });
  }
}
