// Governed `ModelProvider`: LLMStarted -> redaction -> model -> LLMCompleted.
//
// The first model call of a run reuses the pre-screen verdict from `runScope`
// instead of re-evaluating the same prompt. Streaming providers keep streaming:
// LLMCompleted is sent once the stream yields its `completed` event (or fails).

import { toErrorInfo } from "../error-info.js";
import {
  buildActivityCompleted,
  buildActivityStarted
} from "../lifecycle-events.js";
import {
  applyRedaction,
  extractLastUserText,
  extractResponseMetadata
} from "../message-extraction.js";
import {
  closeLlmActivity,
  correlate,
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
import type {
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  StreamingModelProvider
} from "agent-rt";

/** Recorded when the consumer stops iterating before the stream completed. */
export const STREAM_CLOSED: ErrorInfo = {
  type: "Error",
  message: "model stream closed before completion"
};

interface LlmStart {
  request: ModelRequest;
  run: RunState;
  /** null is reserved for callers without an activity. */
  activityId: string | null;
}

async function start(
  ctx: GovernanceContext,
  request: ModelRequest
): Promise<LlmStart> {
  const run = requireRun();
  // A blank or absent user turn must not bypass the model-start policy gate.
  const prompt = extractLastUserText(request.messages);

  let activityId: string;
  let redactedInput: unknown = null;
  // The run's first model call for the pre-screened prompt reuses that verdict
  // (a stateful check, so callers passing prior chat history still reuse it).
  if (run.preScreen && !run.preScreenUsed && prompt === run.preScreen.prompt) {
    run.preScreenUsed = true;
    activityId = run.preScreen.activityId;
    redactedInput = run.preScreen.redactedInput;
  } else if (ctx.options.sendLlmStartEvent) {
    const id = globalThis.crypto.randomUUID();
    activityId = id;
    openActivity(run, id, "llm_call");
    const result = await enforceGate(
      ctx,
      run,
      buildActivityStarted({
        ...identityFor(ctx, run),
        activityId: id,
        activityType: "llm_call",
        activityInput: [{ prompt }]
      }),
      // On a stop verdict, close the orphan started row (failed, same id).
      (error) => closeLlmActivity(ctx, run, id, error)
    );
    redactedInput = result.guardrails?.redactedInput;
  } else {
    const id = globalThis.crypto.randomUUID();
    openActivity(run, id, "llm_call");
    return { request, run, activityId: id };
  }

  const governed =
    redactedInput == null
      ? request
      : {
          ...request,
          messages: applyRedaction(request.messages, redactedInput)
        };
  return { request: governed, run, activityId };
}

async function complete(
  ctx: GovernanceContext,
  run: RunState,
  activityId: string | null,
  outcome: { response?: ModelResponse; error?: ErrorInfo }
): Promise<void> {
  if (activityId === null || !settleActivity(run, activityId)) return;
  if (!ctx.options.sendLlmEndEvent) return;
  await sendTelemetry(
    ctx,
    buildActivityCompleted({
      ...identityFor(ctx, run),
      activityId,
      activityType: "llm_call",
      result: outcome.response
        ? extractResponseMetadata(outcome.response)
        : null,
      error: outcome.error ?? null
    })
  );
}

function governedComplete(ctx: GovernanceContext, inner: ModelProvider) {
  return async (input: ModelRequest): Promise<ModelResponse> => {
    const { request, run, activityId } = await start(ctx, input);
    if (activityId === null) return inner.complete(request);
    try {
      const response = await runWithCorrelation(
        ctx,
        run,
        activityId,
        "llm_call",
        () => inner.complete(request)
      );
      await complete(ctx, run, activityId, { response });
      return response;
    } catch (error) {
      await complete(ctx, run, activityId, { error: toErrorInfo(error) });
      throw error;
    }
  };
}

function governedStream(ctx: GovernanceContext, inner: StreamingModelProvider) {
  return async function* (
    input: ModelRequest
  ): AsyncGenerator<ModelStreamEvent> {
    const { request, run, activityId } = await start(ctx, input);
    let iterator: AsyncIterator<ModelStreamEvent> | undefined;
    // Bind the activity per step (each `next()`), so instrumented I/O inside the
    // stream is attributed to this LLM row but the consumer's handler is not.
    const step =
      activityId === null
        ? <R>(invoke: () => R): R => invoke()
        : correlate(ctx, run, activityId, "llm_call");
    let completed: ModelResponse | undefined;
    let settled = false;
    let closeInner = false;
    try {
      // An error constructing the iterator must not orphan its LLM start row.
      const streamIterator = inner.stream(request)[Symbol.asyncIterator]();
      iterator = streamIterator;
      for (;;) {
        const next = await step(() => streamIterator.next());
        if (next.done) break;
        if (next.value.type === "completed" && next.value.response)
          completed = next.value.response;
        yield next.value;
      }
      settled = true;
      await complete(
        ctx,
        run,
        activityId,
        completed ? { response: completed } : {}
      );
    } catch (error) {
      settled = true;
      closeInner = true;
      await complete(ctx, run, activityId, { error: toErrorInfo(error) });
      throw error;
    } finally {
      if (!settled) {
        // The consumer stopped early (`return()`): close the row and the inner stream.
        await complete(ctx, run, activityId, { error: STREAM_CLOSED });
        closeInner = true;
      }
      if (closeInner) {
        try {
          await iterator?.return?.();
        } catch {
          // Never mask the stream failure or consumer's own control flow.
        }
      }
    }
  };
}

/** Wrap any Agent-RT `ModelProvider` (a Proxy: every other member is the inner provider's). */
export function wrapModelProvider<P extends ModelProvider>(
  ctx: GovernanceContext,
  provider: P
): P {
  const complete = governedComplete(ctx, provider);
  const streaming = provider as Partial<StreamingModelProvider>;
  const stream =
    typeof streaming.stream === "function"
      ? governedStream(ctx, provider as unknown as StreamingModelProvider)
      : undefined;
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === "complete") return complete;
      if (prop === "stream" && stream) return stream;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    }
  });
}
