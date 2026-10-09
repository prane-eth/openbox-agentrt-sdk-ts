// Regression tests: no orphan activity rows (incl. calls a deadline or abort
// abandons), per-step stream correlation, best-effort telemetry,
// prompt-matched pre-screen reuse, and factory startup options. Keep in
// lockstep with the Python `tests/test_lifecycle_hardening.py`.

import {
  AgentLoop,
  ToolRegistry,
  type AgentConfig,
  type ModelRequest,
  type ModelStreamEvent
} from "agent-rt";
import { describe, expect, it } from "vitest";

import { createOpenBoxAgentRT } from "../src/governance/index.js";
import { buildGovernanceRuntime } from "../src/governance/runtime-builder.js";
import {
  buildGovernance,
  eventTypes,
  FakeProvider,
  FakeStreamingProvider,
  final,
  isPreScreen,
  makeRegistry,
  toolTurn,
  user,
  type CapturedEvaluate
} from "./fakes.js";

const AGENT: AgentConfig = {
  name: "a",
  instructions: "be brief",
  model: { model: "fake-model" }
};

const llmRows = (evaluates: CapturedEvaluate[]): [string, string][] =>
  evaluates
    .filter((e) => e.body.activity_type === "llm_call")
    .map((e) => [String(e.body.event_type), String(e.body.activity_id)]);

function expectEveryStartClosed(evaluates: CapturedEvaluate[]): void {
  const ids = (type: string): Set<unknown> =>
    new Set(
      evaluates
        .filter((e) => e.body.event_type === type)
        .map((e) => e.body.activity_id)
    );
  const done = ids("ActivityCompleted");
  expect([...ids("ActivityStarted")].filter((id) => !done.has(id))).toEqual([]);
}

const RUN_ENDED = {
  type: "AbortError",
  message: "run ended before the activity completed"
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("lifecycle hardening", () => {
  it("binds the LLM activity inside each stream step, not in the consumer's handler", async () => {
    const { governance, evaluates } = await buildGovernance();
    const store = governance.runtime.contextStore;
    const insideStream: (string | null)[] = [];
    const insideHandler: (string | null)[] = [];
    const provider = {
      name: "streaming",
      complete: () => Promise.reject(new Error("unused")),
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        await Promise.resolve();
        insideStream.push(store.currentActivityContext()?.activityId ?? null);
        yield { type: "text_delta", text: "hi" };
        insideStream.push(store.currentActivityContext()?.activityId ?? null);
        yield { type: "completed", response: final("s") };
      }
    };
    await governance
      .governLoop(new AgentLoop(provider))
      .runStreaming(AGENT, [user("hi")], () => {
        insideHandler.push(store.currentActivityContext()?.activityId ?? null);
      });
    const llmId = llmRows(evaluates)[0]![1];
    expect(insideStream).toEqual([llmId, llmId]);
    expect(insideHandler.every((id) => id === null)).toBe(true);
    expectEveryStartClosed(evaluates);
  });

  it("closes the LLM row when the consumer stops a stream early", async () => {
    const { governance, evaluates } = await buildGovernance();
    const provider = governance.wrapProvider(
      new FakeStreamingProvider(final("s"))
    );
    await governance.runScope("hi", async () => {
      const request: ModelRequest = { messages: [user("hi")] };
      for await (const event of provider.stream(request)) {
        expect(event.type).toBe("text_delta");
        break; // consumer stops before `completed`
      }
    });
    const done = evaluates.find(
      (e) => e.body.event_type === "ActivityCompleted"
    )!;
    expect(done.body.error).toMatchObject({
      type: "Error",
      message: "model stream closed before completion"
    });
    expectEveryStartClosed(evaluates);
  });

  it("reuses the pre-screen even when prior chat history is passed", async () => {
    const { governance, evaluates } = await buildGovernance();
    const history = [
      user("earlier"),
      final("earlier answer").message,
      user("now")
    ];
    await governance
      .governLoop(new AgentLoop(new FakeProvider(final("ok"))))
      .run(AGENT, history);
    const rows = llmRows(evaluates);
    expect(rows.map(([type]) => type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(rows[0]![1]).toBe(rows[1]![1]);
  });

  it("a blocked model call closes its orphan start row", async () => {
    const { governance, evaluates } = await buildGovernance({
      route: (body) =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "llm_call" &&
        !isPreScreen(body)
          ? { verdict: "block", reason: "no" }
          : { verdict: "allow" }
    });
    const registry = new ToolRegistry();
    registry.register(
      { name: "echo", description: "d", inputSchema: { type: "object" } },
      { handler: () => Promise.resolve("e") }
    );
    const provider = new FakeProvider(toolTurn("echo", {}), final("never"));
    await expect(
      governance
        .governLoop(new AgentLoop(provider, undefined, registry))
        .run(AGENT, [user("go")])
    ).rejects.toThrow();
    expect(provider.requests).toHaveLength(1);
    const second = llmRows(evaluates).slice(-2);
    expect(second.map(([type]) => type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(second[0]![1]).toBe(second[1]![1]);
    expect(
      eventTypes(evaluates).filter((t) => t === "WorkflowFailed")
    ).toHaveLength(1);
    expectEveryStartClosed(evaluates);
  });

  it("a blocked pre-screen closes its row", async () => {
    const { governance, evaluates } = await buildGovernance({
      route: (body) =>
        isPreScreen(body)
          ? { verdict: "block", reason: "pre" }
          : { verdict: "allow" }
    });
    await expect(
      governance
        .governLoop(new AgentLoop(new FakeProvider(final("x"))))
        .run(AGENT, [user("x")])
    ).rejects.toThrow();
    expect(llmRows(evaluates).map(([type]) => type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expectEveryStartClosed(evaluates);
  });

  it("closes an unconsumed pre-screen at run end", async () => {
    const { governance, evaluates } = await buildGovernance();
    await governance.runScope("hello", () => Promise.resolve());
    expect(llmRows(evaluates).map(([type]) => type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowCompleted");
  });

  it("closes an unconsumed pre-screen before WorkflowFailed", async () => {
    // The model start for a DIFFERENT prompt is blocked, so the pre-screen row
    // is never consumed.
    const { governance, evaluates } = await buildGovernance({
      route: (body) =>
        body.event_type === "ActivityStarted" &&
        body.activity_type === "llm_call" &&
        !isPreScreen(body)
          ? { verdict: "block", reason: "no" }
          : { verdict: "allow" }
    });
    const provider = governance.wrapProvider(new FakeProvider(final("never")));
    await expect(
      governance.runScope("hello", () =>
        provider.complete({ messages: [user("other")] })
      )
    ).rejects.toThrow();
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowFailed");
    expect(
      eventTypes(evaluates).filter((t) => t === "WorkflowFailed")
    ).toHaveLength(1);
    expectEveryStartClosed(evaluates);
  });

  it("validate: false skips the startup API-key check", async () => {
    const urls: string[] = [];
    const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
      urls.push(String(input instanceof Request ? input.url : input));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    const governance = await createOpenBoxAgentRT({
      apiUrl: "https://core.test",
      apiKey: "obx_test_key",
      installInstrumentation: false,
      validate: false,
      fetchImpl
    });
    await governance.close();
    expect(urls).toEqual([]);
  });

  it("closes a tool row a run deadline abandons, before the workflow closes", async () => {
    const { governance, evaluates } = await buildGovernance();
    const registry = new ToolRegistry();
    registry.register(
      { name: "slow", description: "d", inputSchema: { type: "object" } },
      // Ignores the abort signal: AgentLoop abandons the pending promise.
      { handler: () => sleep(150).then(() => 1) }
    );
    const result = await governance
      .governLoop(
        new AgentLoop(
          new FakeProvider(toolTurn("slow", {}), final("x")),
          undefined,
          registry
        )
      )
      .run(AGENT, [user("go")], { timeoutMs: 30 });
    expect(result.terminationReason).toBe("timeout");
    const slowRows = (): CapturedEvaluate[] =>
      evaluates.filter((e) => e.body.activity_type === "slow");
    expect(slowRows().map((e) => e.body.event_type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(slowRows()[1]!.body.error).toMatchObject(RUN_ENDED);
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowCompleted");
    expectEveryStartClosed(evaluates);

    await sleep(200); // the abandoned tool settles: no second, late completion
    expect(slowRows()).toHaveLength(2);
  });

  it("an aborted run closes its pending model row", async () => {
    const { governance, evaluates } = await buildGovernance();
    const controller = new AbortController();
    const hanging = {
      name: "hanging",
      complete: (): Promise<never> => {
        setTimeout(() => controller.abort(), 10);
        return new Promise<never>(() => undefined);
      }
    };
    const result = await governance
      .governLoop(new AgentLoop(hanging))
      .run(
        AGENT,
        [user("hi")],
        undefined,
        undefined,
        undefined,
        controller.signal
      );
    expect(result.terminationReason).toBe("cancelled");
    const rows = llmRows(evaluates);
    expect(rows.map(([type]) => type)).toEqual([
      "ActivityStarted",
      "ActivityCompleted"
    ]);
    expect(
      evaluates.find((e) => e.body.event_type === "ActivityCompleted")!.body
        .error
    ).toMatchObject(RUN_ENDED);
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowCompleted");
  });

  it("a failed completion send never discards a tool result", async () => {
    const { governance, evaluates } = await buildGovernance();
    const client = governance.runtime.client;
    const real = client.evaluate.bind(client);
    // Core unreachable for completions only (e.g. under fail_closed).
    client.evaluate = (payload: Parameters<typeof real>[0]) =>
      (payload as { event_type?: unknown }).event_type === "ActivityCompleted"
        ? Promise.reject(new Error("unreachable"))
        : real(payload);
    const calls: Record<string, unknown>[] = [];
    const result = await governance
      .governLoop(
        new AgentLoop(
          new FakeProvider(toolTurn("echo", { text: "a" }), final("done")),
          undefined,
          makeRegistry(calls)
        )
      )
      .run(AGENT, [user("go")]);
    expect(result.terminationReason).toBe("completed");
    expect(calls).toEqual([{ text: "a" }]);
    expect(eventTypes(evaluates).at(-1)).toBe("WorkflowCompleted");
  });

  it("a plain governed provider never exposes an ungoverned stream", async () => {
    const { governance } = await buildGovernance();
    const plain = governance.wrapProvider(new FakeProvider(final("x")));
    expect("stream" in plain).toBe(false);
    const inner = new FakeStreamingProvider(final("x"));
    expect(governance.wrapProvider(inner).stream).not.toBe(inner.stream);
  });

  it("the approval poller shares the runtime client", () => {
    const runtime = buildGovernanceRuntime({
      apiUrl: "https://core.test",
      apiKey: "obx_test_key"
    });
    try {
      const { poller } = runtime.adapter as unknown as {
        poller: { client: unknown; intervalMs: number } | null;
      };
      expect(poller).not.toBeNull();
      // One client: identity, token cache, and close() are shared.
      expect(poller!.client).toBe(runtime.client);
      expect(poller!.intervalMs).toBe(runtime.config.hitl.pollIntervalMs);
    } finally {
      runtime.close();
    }
  });
});
