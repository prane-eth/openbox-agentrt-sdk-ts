// Shared runtime context + enforcement/telemetry/correlation helpers for the
// governed wrappers. The wrappers are the SOLE enforcement surface: gates call
// `runtime.evaluateLifecycle` (which evaluates AND enforces — throwing on
// BLOCK/HALT and driving approval), and every telemetry send goes through the
// non-enforcing evaluator.

import { toErrorInfo } from "../error-info.js";
import {
  buildActivityCompleted,
  buildWorkflowFailed,
  type LifecycleEventIdentity
} from "../lifecycle-events.js";
import { evaluateLifecycleTelemetryOnly } from "../lifecycle-telemetry.js";
import type { ResolvedGovernanceOptions } from "./options.js";
import type { RunState } from "./run-state.js";
import {
  ActivityContext,
  type ErrorInfo,
  type EvaluationResult,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/** Everything the gates need beyond per-run state. */
export interface GovernanceContext {
  runtime: OpenBoxRuntime;
  options: ResolvedGovernanceOptions;
  workflowType: string;
}

/** Identity fields for the lifecycle event builders. */
export function identityFor(
  ctx: GovernanceContext,
  run: RunState
): LifecycleEventIdentity {
  return {
    workflowId: run.workflowId,
    runId: run.runId,
    workflowType: ctx.workflowType,
    taskQueue: ctx.options.taskQueue,
    sessionId: ctx.options.sessionId,
    agentName: ctx.options.agentName
  };
}

/** Best-effort telemetry send (never enforces, never throws for a verdict). */
export async function sendTelemetry(
  ctx: GovernanceContext,
  envelope: EventEnvelope
): Promise<EvaluationResult | null> {
  return evaluateLifecycleTelemetryOnly(
    ctx.runtime,
    envelope,
    ctx.options.logger ? { logger: ctx.options.logger } : {}
  );
}

/**
 * Send `workflowFailed` and mark the run closed, once. Called by every enforcing
 * gate BEFORE it rethrows a block, so workflow-closure telemetry is never lost
 * on a blocked run.
 */
export async function closeWorkflow(
  ctx: GovernanceContext,
  run: RunState,
  error: ErrorInfo
): Promise<void> {
  if (run.workflowClosed) return;
  run.workflowClosed = true;
  // Every row closes BEFORE the workflow: an allowed pre-screen that no model
  // call consumed (e.g. a later model gate blocked a different prompt).
  await closeUnusedPreScreen(ctx, run, error);
  if (!ctx.options.sendRunEndEvent) return;
  await sendTelemetry(
    ctx,
    buildWorkflowFailed({ ...identityFor(ctx, run), error })
  );
}

/**
 * Evaluate + enforce a start-stage gate. On a block (or rejected approval) the
 * runtime throws; this closes the workflow (and any orphan start row) first,
 * then rethrows so the wrapped call never runs.
 */
export async function enforceGate(
  ctx: GovernanceContext,
  run: RunState,
  envelope: EventEnvelope,
  orphanClose?: (error: ErrorInfo) => Promise<void>
): Promise<EvaluationResult> {
  try {
    return await ctx.runtime.evaluateLifecycle(envelope);
  } catch (error) {
    // Convert ONCE — name/stack survive to the wire (e.g. `ApprovalRejectedError`).
    const info = toErrorInfo(error);
    if (orphanClose) await orphanClose(info);
    await closeWorkflow(ctx, run, info);
    throw error;
  }
}

/** Recorded on a row the run ended without (an `AgentLoop` deadline or abort). */
export const RUN_ENDED: ErrorInfo = {
  type: "AbortError",
  message: "run ended before the activity completed"
};

/** Track a start row as open until {@link settleActivity} claims it. */
export function openActivity(
  run: RunState,
  activityId: string,
  activityType: string
): void {
  run.openActivities.set(activityId, activityType);
}

/**
 * Claim an open row for closing. `false` means it is already closed (by run
 * end, after the governed promise was abandoned), so the caller must not send
 * a second, late `ActivityCompleted`.
 */
export function settleActivity(run: RunState, activityId: string): boolean {
  return run.openActivities.delete(activityId);
}

/**
 * Close every row still open when the run ends, BEFORE the workflow closes. A
 * promise cannot be cancelled: an `AgentLoop` deadline or abort returns while a
 * governed model/tool call is still pending, which would otherwise orphan it.
 */
export async function closeOpenActivities(
  ctx: GovernanceContext,
  run: RunState,
  error: ErrorInfo | null = null
): Promise<void> {
  for (const [activityId, activityType] of [...run.openActivities]) {
    settleActivity(run, activityId);
    const send =
      activityType === "llm_call"
        ? ctx.options.sendLlmEndEvent
        : ctx.options.sendToolEndEvent;
    if (!send) continue;
    await sendTelemetry(
      ctx,
      buildActivityCompleted({
        ...identityFor(ctx, run),
        activityId,
        activityType,
        result: null,
        error: error ?? RUN_ENDED
      })
    );
  }
}

/** Close an open `llm_call` start row (telemetry; gated by `sendLlmEndEvent`). */
export async function closeLlmActivity(
  ctx: GovernanceContext,
  run: RunState,
  activityId: string,
  error: ErrorInfo | null = null
): Promise<void> {
  if (!settleActivity(run, activityId) || !ctx.options.sendLlmEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, run),
      activityId,
      activityType: "llm_call",
      result: null,
      error
    })
  );
}

/** Close an allowed pre-screen row that no model call consumed. */
export async function closeUnusedPreScreen(
  ctx: GovernanceContext,
  run: RunState,
  error: ErrorInfo | null = null
): Promise<void> {
  if (!run.preScreen || run.preScreenUsed) return;
  run.preScreenUsed = true;
  await closeLlmActivity(ctx, run, run.preScreen.activityId, error);
}

/**
 * A runner that executes each callback inside one activity scope bound to the
 * runtime's context store, also registering a trace-map fallback so base
 * instrumentation can correlate a detached provider fetch that escapes ALS.
 * Reusable per step (e.g. every `next()` of a model stream).
 */
export function correlate(
  ctx: GovernanceContext,
  run: RunState,
  activityId: string,
  activityType: string
): <R>(invoke: () => R) => R {
  const activityContext = new ActivityContext({
    workflowId: run.workflowId,
    runId: run.runId,
    workflowType: ctx.workflowType,
    taskQueue: ctx.options.taskQueue,
    activityId,
    activityType,
    agentName: ctx.options.agentName,
    sessionId: ctx.options.sessionId
  });
  const traceId = globalThis.crypto.randomUUID().replaceAll("-", "");
  return (invoke) =>
    ctx.runtime.contextStore.activityScope(
      activityContext,
      { traceId },
      invoke
    );
}

/** Run `invoke` once inside the activity scope (see {@link correlate}). */
export function runWithCorrelation<R>(
  ctx: GovernanceContext,
  run: RunState,
  activityId: string,
  activityType: string,
  invoke: () => R
): R {
  return correlate(ctx, run, activityId, activityType)(invoke);
}
