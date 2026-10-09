// Normalize anything thrown into the structured `ErrorInfo` object Core
// requires on lifecycle `error` fields — a bare string is rejected with 400.
//
// This is the ONE conversion seam for every governed seam (run scope, model,
// tools): callers pass the caught value straight through (never
// pre-stringified) so `type`/`stack_trace` survive to the wire. Optional
// fields are set conditionally — never present-with-undefined — so the object
// serializes exactly as built.

import type { ErrorInfo } from "@openbox-ai/openbox-sdk-ts";

/**
 * `Error` instances keep their name/message/stack; anything else (strings,
 * objects thrown raw, governance reason text) becomes
 * `{type: "Error", message: String(value)}`.
 */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof Error) {
    const info: ErrorInfo = { type: error.name, message: error.message };
    if (error.stack) info.stack_trace = error.stack;
    return info;
  }
  return { type: "Error", message: stringifyThrown(error) };
}

/**
 * `String(value)` itself throws on null-prototype objects and throwing
 * `toString`s — this seam sits inside catch blocks and must never mask the
 * original error, so fall back to the tag form (`"[object Object]"`).
 */
function stringifyThrown(value: unknown): string {
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}
