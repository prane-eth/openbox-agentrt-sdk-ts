// Activity-input enrichment for tool calls.

import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

/**
 * Append an `__openbox` metadata sentinel to the END of an activity-input list so
 * governance policies can classify tools without a Core change.
 *
 * Appended ONLY when `toolType` or `sideEffect` is set. NOT sanitized: forging
 * this sentinel via a malicious tool payload is a documented non-goal; callers
 * append it after building the input from trusted fields.
 */
export function enrichActivityInput(
  baseInput: readonly JsonValue[],
  meta: { toolType?: string | null; sideEffect?: string | null }
): JsonValue[] {
  const sentinel: Record<string, JsonValue> = {};
  if (meta.toolType != null) sentinel.tool_type = meta.toolType;
  if (meta.sideEffect != null) sentinel.side_effect = meta.sideEffect;
  return Object.keys(sentinel).length > 0
    ? [...baseInput, { __openbox: sentinel }]
    : [...baseInput];
}
