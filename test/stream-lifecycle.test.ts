// Streaming iterator failures must close OpenBox activity rows and resources.
import { describe, expect, it } from "vitest";
import type { ModelRequest, ModelStreamEvent } from "agent-rt";

import { buildGovernance, user } from "./fakes.js";

describe("stream lifecycle", () => {
  it("closes the LLM row when stream construction throws", async () => {
    const { governance, evaluates } = await buildGovernance();
    const provider = governance.wrapProvider({
      name: "broken",
      complete: () => Promise.reject(new Error("unused")),
      stream(_request: ModelRequest): AsyncIterable<ModelStreamEvent> {
        throw new Error("stream factory failed");
      }
    });
    await governance.runScope("hi", async () => {
      await expect(async () => {
        for await (const _event of provider.stream({
          messages: [user("hi")]
        })) {
          // The iterator throws before delivering an event.
        }
      }).rejects.toThrow("stream factory failed");
    });
    const started = evaluates
      .filter((e) => e.body.event_type === "ActivityStarted")
      .map((e) => e.body.activity_id);
    const completed = evaluates
      .filter((e) => e.body.event_type === "ActivityCompleted")
      .map((e) => e.body.activity_id);
    expect(started.every((id) => completed.includes(id))).toBe(true);
  });

  it("closes the inner iterator when a stream step rejects", async () => {
    const { governance, evaluates } = await buildGovernance();
    let returned = 0;
    const iterator: AsyncIterator<ModelStreamEvent> = {
      next: () => Promise.reject(new Error("next failed")),
      return: () => {
        returned++;
        return Promise.resolve({ done: true, value: undefined });
      }
    };
    const provider = governance.wrapProvider({
      name: "broken",
      complete: () => Promise.reject(new Error("unused")),
      stream: (_request: ModelRequest): AsyncIterable<ModelStreamEvent> => ({
        [Symbol.asyncIterator]: () => iterator
      })
    });
    await governance.runScope("hi", async () => {
      await expect(async () => {
        for await (const _event of provider.stream({
          messages: [user("hi")]
        })) {
          // The first next() rejects.
        }
      }).rejects.toThrow("next failed");
    });
    expect(returned).toBe(1);
    const started = evaluates
      .filter((e) => e.body.event_type === "ActivityStarted")
      .map((e) => e.body.activity_id);
    const completed = evaluates
      .filter((e) => e.body.event_type === "ActivityCompleted")
      .map((e) => e.body.activity_id);
    expect(started.every((id) => completed.includes(id))).toBe(true);
  });
});
