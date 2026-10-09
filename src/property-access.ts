// Small reflective helpers for reading fields off duck-typed values
// (messages, generations, responses) without unsafe `any` casts.
// Message shapes vary (typed classes vs plain dicts), so extraction/redaction
// code inspects them structurally.

/** Read a property from an unknown value; `undefined` if it is not a keyed object. */
export function readProp(value: unknown, key: string): unknown {
  if (typeof value === "object" && value !== null && key in value) {
    return (value as Record<string, unknown>)[key];
  }
  return undefined;
}

/** Coerce to a finite number, else `null`. */
export function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Typed array guard. `Array.isArray` narrows `unknown` to `any[]` (a TS quirk
 * that defeats no-unsafe lint rules); this narrows to `unknown[]` instead.
 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Invoke a zero-arg method by name if present, bound to `value`; else `undefined`. */
export function callMethod(value: unknown, method: string): unknown {
  const fn = readProp(value, method);
  if (typeof fn === "function") {
    return (fn as (this: unknown) => unknown).call(value);
  }
  return undefined;
}
