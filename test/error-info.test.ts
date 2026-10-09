import { describe, expect, it } from "vitest";

import { toErrorInfo } from "../src/error-info.js";

class CustomToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomToolError";
  }
}

describe("toErrorInfo — Error instances", () => {
  it("preserves name as type, message, and stack as stack_trace", () => {
    const error = new CustomToolError("tool exploded");
    const info = toErrorInfo(error);
    expect(info.type).toBe("CustomToolError");
    expect(info.message).toBe("tool exploded");
    expect(info.stack_trace).toBe(error.stack);
  });

  it("omits stack_trace entirely (not undefined) when the stack is absent", () => {
    const error = new Error("no stack");
    delete error.stack;
    const info = toErrorInfo(error);
    expect(info).toStrictEqual({ type: "Error", message: "no stack" });
    expect("stack_trace" in info).toBe(false);
  });

  it("a plain Error keeps the default name", () => {
    const info = toErrorInfo(new Error("late"));
    expect(info.type).toBe("Error");
    expect(info.message).toBe("late");
  });
});

describe("toErrorInfo — non-Error thrown values normalize safely", () => {
  it.each([
    ["a string", "just a reason string", "just a reason string"],
    ["a number", 42, "42"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["an object", { code: 500 }, "[object Object]"]
  ])(
    "%s becomes {type: 'Error', message: String(value)}",
    (_label, value, expected) => {
      const info = toErrorInfo(value);
      expect(info).toStrictEqual({ type: "Error", message: expected });
      expect("stack_trace" in info).toBe(false);
    }
  );

  it("never produces a string — always the structured object", () => {
    for (const value of [new Error("e"), "s", 1, null]) {
      expect(typeof toErrorInfo(value)).toBe("object");
    }
  });

  it("survives values String() itself throws on (null-prototype, throwing toString)", () => {
    expect(toErrorInfo(Object.create(null))).toStrictEqual({
      type: "Error",
      message: "[object Object]"
    });
    const hostile = {
      toString() {
        throw new Error("gotcha");
      }
    };
    expect(toErrorInfo(hostile)).toStrictEqual({
      type: "Error",
      message: "[object Object]"
    });
  });
});
