// Governed tool execution: ToolStarted (enforce) -> tool (activity scope) -> ToolCompleted.
//
// `AgentLoop` executes registered tools through `toolRegistry.execute` and only
// falls back to `toolExecutor.execute` for unregistered ones, so BOTH are
// wrapped. Wrapping the execution seam (rather than `ToolLifecycleHooks`) lets the
// tool body run inside an activity scope so instrumented HTTP/DB/file I/O is
// attributed to the right activity.

import { toErrorInfo } from "../error-info.js";
import { enrichActivityInput } from "../activity-input.js";
import {
  buildActivityCompleted,
  buildActivityStarted
} from "../lifecycle-events.js";
import { toJsonSafe } from "../serialization.js";
import {
  enforceGate,
  identityFor,
  openActivity,
  runWithCorrelation,
  sendTelemetry,
  settleActivity,
  type GovernanceContext
} from "./context.js";
import { requireRun, type RunState } from "./run-state.js";
import type { ErrorInfo } from "@openbox-ai/openbox-sdk-ts";
import type { ToolCall, ToolExecutor, ToolRegistry } from "agent-rt";

async function complete(
  ctx: GovernanceContext,
  run: RunState,
  activityId: string,
  tool: string,
  outcome: { result?: unknown; error?: ErrorInfo }
): Promise<void> {
  if (!settleActivity(run, activityId) || !ctx.options.sendToolEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, run),
      activityId,
      activityType: tool,
      result: outcome.result === undefined ? null : toJsonSafe(outcome.result),
      error: outcome.error ?? null
    })
  );
}

/** Run `invoke` under OpenBox governance for `call`. */
export async function governToolCall<T>(
  ctx: GovernanceContext,
  call: ToolCall,
  invoke: () => Promise<T>,
  sideEffect?: string | null
): Promise<T> {
  const run = requireRun();
  if (ctx.options.skipToolTypes.has(call.name)) return invoke();

  const activityId = globalThis.crypto.randomUUID();
  openActivity(run, activityId, call.name);

  if (ctx.options.sendToolStartEvent) {
    await enforceGate(
      ctx,
      run,
      buildActivityStarted({
        ...identityFor(ctx, run),
        activityId,
        activityType: call.name,
        activityInput: enrichActivityInput([toJsonSafe(call.arguments)], {
          toolType: ctx.options.toolTypeMap[call.name] ?? null,
          sideEffect: sideEffect ?? null
        })
      }),
      // On a stop verdict, close the orphan started row (failed, same id).
      (error) => complete(ctx, run, activityId, call.name, { error })
    );
  }

  try {
    const result = await runWithCorrelation(
      ctx,
      run,
      activityId,
      call.name,
      invoke
    );
    await complete(ctx, run, activityId, call.name, { result });
    return result;
  } catch (bodyError) {
    // A tool BODY failure, not a governance block: record it, do not close the run.
    await complete(ctx, run, activityId, call.name, {
      error: toErrorInfo(bodyError)
    });
    throw bodyError;
  }
}

/** Wrap a plain Agent-RT `ToolExecutor`. */
export function wrapToolExecutor<E extends ToolExecutor>(
  ctx: GovernanceContext,
  executor: E
): E {
  return new Proxy(executor, {
    get(target, prop) {
      if (prop === "execute") {
        return (call: ToolCall, signal?: AbortSignal): Promise<unknown> =>
          governToolCall(ctx, call, () => target.execute(call, signal));
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}

/** Wrap a `ToolRegistry` (a Proxy: every member is the registry's except `execute`). */
export function wrapToolRegistry(
  ctx: GovernanceContext,
  registry: ToolRegistry
): ToolRegistry {
  const sideEffectOf = (name: string): string | null => {
    try {
      return registry.get(name).definition.sideEffect ?? null;
    } catch {
      // Unknown/disabled tool: the registry raises its own error on execute.
      return null;
    }
  };
  return new Proxy(registry, {
    get(target, prop) {
      if (prop === "execute") {
        return (
          call: ToolCall,
          signal?: AbortSignal,
          requestContext?: Record<string, unknown>
        ): Promise<unknown> =>
          governToolCall(
            ctx,
            call,
            () => target.execute(call, signal, requestContext),
            sideEffectOf(call.name)
          );
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}
