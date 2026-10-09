import { describe, expect, it } from "vitest";

import { toJsonSafe } from "../src/serialization.js";

describe("toJsonSafe", () => {
  it("passes primitives and plain structures through", () => {
    expect(toJsonSafe({ a: 1, b: "x", c: [true, null] })).toEqual({
      a: 1,
      b: "x",
      c: [true, null]
    });
  });

  it("coerces non-JSON values (bigint, Date, Map/Set, non-finite)", () => {
    expect(toJsonSafe(10n)).toBe("10");
    expect(toJsonSafe(Number.POSITIVE_INFINITY)).toBeNull();
    expect(toJsonSafe(new Map([["k", 1]]))).toEqual({ k: 1 });
    expect(toJsonSafe(new Set([1, 2]))).toEqual([1, 2]);
    expect(typeof toJsonSafe(new Date(0))).toBe("string");
  });

  it("breaks circular references", () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(toJsonSafe(a)).toEqual({ self: "[Circular]" });
  });

  it("never throws — a throwing getter yields a fallback, not an exception", () => {
    const hostile = {
      get boom(): never {
        throw new Error("getter exploded");
      }
    };
    expect(() => toJsonSafe(hostile)).not.toThrow();
    expect(toJsonSafe(hostile)).toBe("[unserializable]");
  });
});
