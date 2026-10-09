// evaluateLifecycleTelemetryOnly — the non-enforcing, best-effort send used by
// ALL completion events and observer telemetry.
//
// Hard rules:
//   - Prepare the payload OUTSIDE the try, so a prepare bug surfaces instead of
//     being swallowed.
//   - Wrap ONLY `runtime.client.evaluate(payload)` in the try.
//   - NEVER call `runtime.evaluateLifecycle`, `adapter.raiseLifecycleBlocked`,
//     or `adapter.handleApproval` — this helper never enforces and never throws
//     for a governance verdict.
//   - Return the `EvaluationResult` (so a caller can stash/inspect a verdict) or
//     `null` on any evaluate-level failure (network/API, auth/signing,
//     malformed body). A telemetry-only BLOCK/HALT/REQUIRE_APPROVAL verdict is
//     returned for the caller to stash/log — never thrown after work ran.
//
// This intentionally wraps the raw client: the base SDK exposes no non-enforcing
// lifecycle evaluate, and this is the sanctioned post-work telemetry pattern,
// distinct from the enforcement boundary the runtime/adapter own.

import {
  prepareLifecyclePayload,
  type EvaluationResult,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/** Minimal logger sink for diagnostics (a subset of console). */
export interface Logger {
  warn(message: string, ...args: unknown[]): void;
}

export interface TelemetryEvaluateOptions {
  logger?: Logger;
}

/**
 * Send a lifecycle event for telemetry only and return its verdict, or `null`
 * if the evaluate call itself failed. Never enforces, never throws for a
 * verdict.
 */
export async function evaluateLifecycleTelemetryOnly(
  runtime: OpenBoxRuntime,
  event: EventEnvelope,
  options: TelemetryEvaluateOptions = {}
): Promise<EvaluationResult | null> {
  // Prepare OUTSIDE the try — a prepare bug should surface, not be swallowed.
  const { payload } = prepareLifecyclePayload(event, {
    privacy: runtime.config.privacy
  });
  try {
    return await runtime.client.evaluate(payload);
  } catch (error) {
    options.logger?.warn(
      `OpenBox telemetry evaluate failed (send suppressed): ${String(error)}`
    );
    return null;
  }
}
