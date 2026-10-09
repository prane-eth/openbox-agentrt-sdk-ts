import { describe, expect, it } from "vitest";

import {
  applyRedaction,
  coerceRedactedText,
  extractLastUserText
} from "../src/index.js";
import { final, user } from "./fakes.js";

describe("message extraction", () => {
  it("extracts the last user text", () => {
    expect(
      extractLastUserText([user("a"), final("b").message, user("c")])
    ).toBe("c");
    expect(extractLastUserText([final("b").message])).toBe("");
  });

  it("redacts the last user turn, keeps non-text parts, never mutates history", () => {
    const original = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "secret" },
          { type: "image" as const, data: "x" }
        ]
      }
    ];
    const out = applyRedaction(original, [{ prompt: "[R]" }]);
    expect(out[0]!.content.map((p) => p.type)).toEqual(["text", "image"]);
    expect(out[0]!.content[0]!.text).toBe("[R]");
    expect(original[0]!.content[0]!.text).toBe("secret");
  });

  it("coerces redacted input shapes", () => {
    expect(coerceRedactedText("x")).toBe("x");
    expect(coerceRedactedText([{ text: "t" }])).toBe("t");
    expect(coerceRedactedText(null)).toBeNull();
    expect(applyRedaction([user("a")], null)[0]!.content[0]!.text).toBe("a");
  });
});
