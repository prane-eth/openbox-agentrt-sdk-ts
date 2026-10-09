import { AgentLoop, ToolRegistry, type AgentConfig } from "agent-rt";
import { describe, expect, it } from "vitest";

import {
  buildGovernance,
  eventTypes,
  final,
  FakeProvider,
  FakeStreamingProvider,
  isPreScreen,
  makeRegistry,
  toolTurn,
  user
} from "./fakes.js";

const AGENT: AgentConfig = {
  name: "a",
  instructions: "be brief",
  model: { model: "fake-model" }
};

describe("governed AgentLoop (e2e)", () => {
  it("emits the full lifecycle in order and never delegates to the adapter on ALLOW", async () => {
    const { governance, evaluates, adapter } = await buildGovernance({
      options: { toolTypeMap: { echo: "http" } }
    });
    const calls: Record<string, unknown>[] = [];
    const provider = new FakeProvider(
      toolTurn("echo", { text: "hi" }),
      final("done")
    );
    const loop = governance.governLoop(
      new AgentLoop(provider, undefined, makeRegistry(calls))
    );

    const result = await loop.run(AGENT, [user("hello")]);

    expect(result.terminationReason).toBe("completed");
    expect(calls).toEqual([{ text: "hi" }]);
    const types = eventTypes(evaluates);
    expect(types.slice(0, 3)).toEqual([
      "WorkflowStarted",
      "SignalReceived",
      "ActivityStarted"
    ]);
    expect(isPreScreen(evaluates[2]!.body)).toBe(true);
    expect(types.filter((t) => t === "ActivityStarted")).toHaveLength(3);
    expect(types.at(-1)).toBe("WorkflowCompleted");
    expect(
      (evaluates.at(-1)!.body.workflow_output as { result: string }).result
    ).toBe("done");
    const toolStarted = evaluates.find(
      (e) =>
        e.body.event_type === "ActivityStarted" &&
        e.body.activity_type === "echo"
    )!;
    const input = toolStarted.body.activity_input as unknown[];
    expect(input.at(-1)).toEqual({
      __openbox: { tool_type: "http", side_effect: "read" }
    });
    expect(adapter.calls).toHaveLength(0);
    expect(evaluates[0]?.headers["x-openbox-sdk-version"]).toBe(
      "openbox-agentrt-typescript-v1.0.0"
    );
  });

  it("reuses the pre-screen for the first model call (no duplicate LLMStarted)", async () => {
    const { governance, evaluates } = await buildGovernance();
    await governance
      .governLoop(new AgentLoop(new FakeProvider(final("ok"))))
      .run(AGENT, [user("hello")]);
    const llmStarted = evaluates.filter(
      (e) =>
        e.body.event_type === "ActivityStarted" &&
        e.body.activity_type === "llm_call"
    );
    expect(llmStarted).toHaveLength(1);
    const completed = evaluates.find(
      (e) => e.body.event_type === "ActivityCompleted"
    )!;
    expect(completed.body.activity_id).toBe(llmStarted[0]!.body.activity_id);
    expect(
      (completed.body.activity_output as { total_tokens: number }).total_tokens
    ).toBe(5);
  });

  it("blocks on SignalReceived, never calls the model, closes the workflow once", async () => {
    const { governance, evaluates, adapter } = await buildGovernance({
      route: (body) =>
        body.event_type === "SignalReceived"
          ? { verdict: "block", reason: "signal denied" }
          : { verdict: "allow" }
    });
    const provider = new FakeProvider(final("should not run"));
    await expect(
      governance.governLoop(new AgentLoop(provider)).run(AGENT, [user("bad")])
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
    const types = eventTypes(evaluates);
    expect(types.filter((t) => t === "WorkflowFailed")).toHaveLength(1);
    expect(types).not.toContain("WorkflowCompleted");
    expect(adapter.calls.some((c) => c.kind === "raiseLifecycleBlocked")).toBe(
      true
    );
  });

  it("blocks at the pre-screen so the model never runs", async () => {
    const { governance, evaluates } = await buildGovernance({
      route: (body) =>
        isPreScreen(body)
          ? { verdict: "block", reason: "pre" }
          : { verdict: "allow" }
    });
    const provider = new FakeProvider(final("nope"));
    await expect(
      governance.governLoop(new AgentLoop(provider)).run(AGENT, [user("x")])
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowFailed");
  });

  it("a blocked tool never executes and its orphan start row is closed with a structured error", async () => {
    const { governance, evaluates } = await buildGovernance({
      route: (body) =>
        body.activity_type === "echo" && body.event_type === "ActivityStarted"
          ? { verdict: "block", reason: "tool denied" }
          : { verdict: "allow" }
    });
    const calls: Record<string, unknown>[] = [];
    const provider = new FakeProvider(
      toolTurn("echo", { text: "hi" }),
      final("never")
    );
    await expect(
      governance
        .governLoop(new AgentLoop(provider, undefined, makeRegistry(calls)))
        .run(AGENT, [user("go")])
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
    const toolEvents = evaluates.filter((e) => e.body.activity_type === "echo");
    expect(toolEvents.map((e) => e.body.event_type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(toolEvents[0]!.body.activity_id).toBe(
      toolEvents[1]!.body.activity_id
    );
    expect((toolEvents[1]!.body.error as { type: string }).type).toBeTruthy();
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowFailed");
  });

  it("records a tool body failure without a governance closure on the tool row", async () => {
    const { governance, evaluates } = await buildGovernance();
    const registry = new ToolRegistry();
    registry.register(
      { name: "boom", description: "d", inputSchema: { type: "object" } },
      { handler: () => Promise.reject(new Error("kaboom")) }
    );
    await expect(
      governance
        .governLoop(
          new AgentLoop(
            new FakeProvider(toolTurn("boom", {}), final("x")),
            undefined,
            registry
          )
        )
        .run(AGENT, [user("go")])
    ).rejects.toThrow("kaboom");
    const done = evaluates
      .filter((e) => e.body.activity_type === "boom")
      .at(-1)!;
    expect(done.body.event_type).toBe("ActivityCompleted");
    expect(done.body.error).toMatchObject({ type: "Error", message: "kaboom" });
  });

  it("governs the executor path too", async () => {
    const { governance, evaluates } = await buildGovernance();
    const executor = { execute: () => Promise.resolve({ ok: true }) };
    await governance
      .governLoop(
        new AgentLoop(
          new FakeProvider(toolTurn("ext", {}), final("fin")),
          executor
        )
      )
      .run(AGENT, [user("go")]);
    expect(evaluates.some((e) => e.body.activity_type === "ext")).toBe(true);
  });

  it("applies guardrail redaction from the pre-screen to the first model request", async () => {
    const { governance } = await buildGovernance({
      route: (body) =>
        isPreScreen(body)
          ? {
              verdict: "allow",
              guardrails_result: {
                redacted_input: [{ prompt: "my SSN is [REDACTED]" }]
              }
            }
          : { verdict: "allow" }
    });
    const provider = new FakeProvider(final("ok"));
    await governance
      .governLoop(new AgentLoop(provider))
      .run(AGENT, [user("my SSN is 123-45-6789")]);
    expect(provider.requests[0]!.messages.at(-1)!.content[0]!.text).toBe(
      "my SSN is [REDACTED]"
    );
  });

  it("a rejected approval stops the run with structured ApprovalRejectedError telemetry", async () => {
    const { governance, evaluates, adapter } = await buildGovernance({
      route: (body) =>
        isPreScreen(body)
          ? { verdict: "require_approval" }
          : { verdict: "allow" },
      adapterOptions: { approvalOutcome: "reject" }
    });
    const provider = new FakeProvider(final("never"));
    await expect(
      governance.governLoop(new AgentLoop(provider)).run(AGENT, [user("x")])
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(0);
    expect(adapter.calls.some((c) => c.kind === "handleApproval")).toBe(true);
    const failed = evaluates.find(
      (e) => e.body.event_type === "WorkflowFailed"
    )!;
    expect((failed.body.error as { type: string }).type).toBe(
      "ApprovalRejectedError"
    );
  });

  it("streaming runs stay streaming and are governed", async () => {
    const { governance, evaluates } = await buildGovernance();
    const seen: string[] = [];
    const loop = governance.governLoop(
      new AgentLoop(new FakeStreamingProvider(final("streamed")))
    );
    const result = await loop.runStreaming(AGENT, [user("hi")], (event) => {
      seen.push(event.type);
    });
    expect(result.terminationReason).toBe("completed");
    expect(seen).toContain("text_delta");
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowCompleted");
    expect(
      evaluates.some((e) => e.body.event_type === "ActivityCompleted")
    ).toBe(true);
  });

  it("records provider failures and closes the run", async () => {
    const { governance, evaluates } = await buildGovernance();
    const failing = {
      name: "failing",
      complete: () => Promise.reject(new Error("upstream down"))
    };
    await expect(
      governance.governLoop(new AgentLoop(failing)).run(AGENT, [user("hi")])
    ).rejects.toThrow("upstream down");
    const done = evaluates.find(
      (e) => e.body.event_type === "ActivityCompleted"
    )!;
    expect(done.body.error).toMatchObject({ message: "upstream down" });
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowFailed");
  });

  it("concurrent runs never share identity", async () => {
    const { governance, evaluates } = await buildGovernance();
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        governance
          .governLoop(new AgentLoop(new FakeProvider(final(`r${i}`))))
          .run(AGENT, [user(`q${i}`)])
      )
    );
    const ids = new Set(
      evaluates
        .filter((e) => e.body.event_type === "WorkflowStarted")
        .map((e) => e.body.workflow_id)
    );
    expect(ids.size).toBe(5);
    for (const id of ids) {
      const mine = evaluates.filter((e) => e.body.workflow_id === id);
      expect(mine.at(-1)!.body.event_type).toBe("WorkflowCompleted");
    }
  });

  it("a wrapped provider outside a run fails closed", async () => {
    const { governance } = await buildGovernance();
    const provider = governance.wrapProvider(new FakeProvider(final("x")));
    await expect(provider.complete({ messages: [user("x")] })).rejects.toThrow(
      /no active run/
    );
  });

  it("does not mutate the original loop", async () => {
    const { governance } = await buildGovernance();
    const raw = new FakeProvider(final("x"));
    const loop = new AgentLoop(raw);
    governance.governLoop(loop);
    expect((loop as unknown as { provider: unknown }).provider).toBe(raw);
  });
});
