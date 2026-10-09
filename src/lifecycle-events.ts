// Thin wrappers over the base SDK event factories.
//
// Two jobs the base factories do not do for us:
//   1. Inject `session_id` / `agent_name` into `extra` using SNAKE_CASE wire
//      keys — they are not first-class factory fields, and a camelCase merge
//      would silently drop them from the payload.
//   2. Thread `taskQueue` through as a factory option (the factory serializes
//      it to `task_queue`), NOT as config.
//
// Caller-supplied `extra` wins over the injected session/agent values
// (set-if-absent), matching the Python `setdefault` semantics.

import {
  activityCompleted,
  activityStarted,
  signalReceived,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
  type ErrorInfo,
  type EventEnvelope,
  type JsonValue
} from "@openbox-ai/openbox-sdk-ts";

/** Identity + telemetry fields common to every lifecycle event this adapter emits. */
export interface LifecycleEventIdentity {
  workflowId: string;
  runId: string;
  workflowType: string;
  taskQueue?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  multiAgentSessionId?: string | null;
  timestamp?: string | null;
  extra?: Readonly<Record<string, JsonValue>> | null;
}

export interface ActivityStartedBuild extends LifecycleEventIdentity {
  activityId: string;
  activityType: string;
  activityInput?: JsonValue | null;
  attempt?: number | null;
}

export interface ActivityCompletedBuild extends LifecycleEventIdentity {
  activityId: string;
  activityType: string;
  result?: JsonValue | null;
  /** Structured error object Core requires — a bare string is rejected (400). */
  error?: ErrorInfo | null;
  attempt?: number | null;
}

export interface SignalReceivedBuild extends LifecycleEventIdentity {
  signalName: string;
}

export interface WorkflowFailedBuild extends LifecycleEventIdentity {
  /** Structured error object Core requires — a bare string is rejected (400). */
  error?: ErrorInfo | null;
}

/**
 * Merge `session_id` / `agent_name` into `extra` with snake_case wire keys.
 * Caller-supplied keys win. Returns `null` (omit) when nothing to send.
 */
export function mergeSessionExtra(
  extra: Readonly<Record<string, JsonValue>> | null | undefined,
  sessionId: string | null | undefined,
  agentName: string | null | undefined
): Record<string, JsonValue> | null {
  const merged: Record<string, JsonValue> = { ...(extra ?? {}) };
  if (sessionId != null && merged.session_id === undefined)
    merged.session_id = sessionId;
  if (agentName != null && merged.agent_name === undefined)
    merged.agent_name = agentName;
  return Object.keys(merged).length > 0 ? merged : null;
}

export function buildActivityStarted(
  opts: ActivityStartedBuild
): EventEnvelope {
  return activityStarted({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    activityId: opts.activityId,
    activityType: opts.activityType,
    taskQueue: opts.taskQueue ?? null,
    activityInput: opts.activityInput ?? null,
    attempt: opts.attempt ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}

export function buildActivityCompleted(
  opts: ActivityCompletedBuild
): EventEnvelope {
  return activityCompleted({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    activityId: opts.activityId,
    activityType: opts.activityType,
    taskQueue: opts.taskQueue ?? null,
    result: opts.result ?? null,
    error: opts.error ?? null,
    attempt: opts.attempt ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}

export function buildWorkflowStarted(
  opts: LifecycleEventIdentity
): EventEnvelope {
  return workflowStarted({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    taskQueue: opts.taskQueue ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}

export function buildWorkflowCompleted(
  opts: LifecycleEventIdentity
): EventEnvelope {
  return workflowCompleted({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    taskQueue: opts.taskQueue ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}

export function buildWorkflowFailed(opts: WorkflowFailedBuild): EventEnvelope {
  return workflowFailed({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    taskQueue: opts.taskQueue ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    error: opts.error ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}

export function buildSignalReceived(opts: SignalReceivedBuild): EventEnvelope {
  return signalReceived({
    workflowId: opts.workflowId,
    runId: opts.runId,
    workflowType: opts.workflowType,
    signalName: opts.signalName,
    taskQueue: opts.taskQueue ?? null,
    multiAgentSessionId: opts.multiAgentSessionId ?? null,
    timestamp: opts.timestamp ?? null,
    extra: mergeSessionExtra(opts.extra, opts.sessionId, opts.agentName)
  });
}
