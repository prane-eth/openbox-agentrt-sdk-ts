import type { ModelMessage } from "agent-rt";
import { describe, expect, it } from "vitest";

import { buildGovernance, FakeProvider, final, user } from "./fakes.js";

describe("model requests without user text", () => {
  it("still enforces model-start governance for blank and absent user messages", async () => {
    const inputs: ModelMessage[][] = [[], [user("")]];
    for (const messages of inputs) {
      const { governance, evaluates } = await buildGovernance({
        route: (body) =>
          body.event_type === "ActivityStarted" &&
          body.activity_type === "llm_call"
            ? { verdict: "block", reason: "no model access" }
            : { verdict: "allow" }
      });
      const provider = new FakeProvider(final("should not run"));

      await expect(
        governance.runScope("", () =>
          governance.wrapProvider(provider).complete({ messages })
        )
      ).rejects.toThrow();

      expect(provider.requests).toHaveLength(0);
      const starts = evaluates.filter(
        (e) => e.body.event_type === "ActivityStarted"
      );
      expect(starts).toHaveLength(1);
      expect(starts[0]!.body.activity_input).toEqual([{ prompt: "" }]);
      expect(
        evaluates.filter((e) => e.body.event_type === "ActivityCompleted")
      ).toHaveLength(1);
      expect(evaluates.at(-1)!.body.event_type).toBe("WorkflowFailed");
      await governance.close();
    }
  });
});
