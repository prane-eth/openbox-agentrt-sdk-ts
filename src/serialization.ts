// JSON-safe coercion for arbitrary tool inputs/outputs and model responses.
//
// The base event factories type `activityInput`/`result` as `JsonValue`, so
// caller values (tool args, tool results, model responses) must be coerced
// to a serializable shape first. This handles circular references, non-finite
// numbers, bigint, Map/Set, Date, and objects exposing `toJSON`.

import { isUnknownArray, readProp } from "./property-access.js";
import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

/** Coerce an arbitrary value to a JSON-safe `JsonValue`, never throwing. */
export function toJsonSafe(value: unknown): JsonValue {
  try {
    return convert(value, new WeakSet<object>());
  } catch {
    // A pathological value (a throwing getter or `toJSON`) must never break a
    // governed call — this feeds telemetry, which is best-effort.
    return "[unserializable]";
  }
}

/** Convert primitives and unserializable scalars; `undefined` = not a scalar. */
function convertScalar(value: unknown): JsonValue | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return null;
  return undefined;
}

function convert(value: unknown, seen: WeakSet<object>): JsonValue {
  const scalar = convertScalar(value);
  if (scalar !== undefined) return scalar;

  // Everything below is a non-null object (convertScalar handled the rest).
  const obj = value as object;
  if (seen.has(obj)) return "[Circular]";
  if (value instanceof Date) return value.toISOString();

  // Objects that define their own serialization (e.g. message classes).
  const toJSON = readProp(value, "toJSON");
  if (typeof toJSON === "function") {
    seen.add(obj);
    try {
      return convert((toJSON as (this: unknown) => unknown).call(value), seen);
    } finally {
      seen.delete(obj);
    }
  }

  seen.add(obj);
  try {
    if (isUnknownArray(value)) return value.map((item) => convert(item, seen));
    if (value instanceof Map) {
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of value) out[String(k)] = convert(v, seen);
      return out;
    }
    if (value instanceof Set)
      return [...value].map((item) => convert(item, seen));
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = convert(v, seen);
    return out;
  } finally {
    seen.delete(obj);
  }
}
