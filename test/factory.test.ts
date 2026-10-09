import { AgentLoop, ToolRegistry, type ToolExecutor } from "agent-rt";
import { describe, expect, it } from "vitest";

import { createOpenBoxAgentRT } from "../src/governance/index.js";
import {
  buildGovernance,
  final,
  FakeProvider,
  makeRegistry,
  toolTurn,
  user
} from "./fakes.js";

const json = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" }
  });

describe("createOpenBoxAgentRT", () => {
  it("builds its own runtime from config, validates the key, and brands the SDK header", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = ((
      input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      seen.push({ url, headers });
      return Promise.resolve(
        url.includes("/auth/validate")
          ? json({ valid: true })
          : json({ verdict: "allow" })
      );
    }) as typeof fetch;

    const governance = await createOpenBoxAgentRT({
      apiUrl: "https://core.test",
      apiKey: "obx_test_key",
      agentName: "built",
      installInstrumentation: false,
      fetchImpl
    });
    await governance.runScope("hello", () => Promise.resolve());
    await governance.close();

    expect(seen[0]!.url).toContain("/auth/validate");
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[1]!.headers["x-openbox-sdk-version"]).toBe(
      "openbox-agentrt-typescript-v1.0.0"
    );
  });

  it("rejects when the API key is invalid", async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "nope" }), { status: 401 })
      )) as typeof fetch;
    await expect(
      createOpenBoxAgentRT({
        apiUrl: "https://core.test",
        apiKey: "obx_test_bad",
        installInstrumentation: false,
        fetchImpl
      })
    ).rejects.toThrow();
  });
});

describe("OpenBoxAgentRTGovernance wrappers", () => {
  it("wrapToolRegistry / wrapToolExecutor / wrapProvider are usable standalone inside runScope", async () => {
    const { governance, evaluates } = await buildGovernance();
    const calls: Record<string, unknown>[] = [];
    const registry = governance.wrapToolRegistry(makeRegistry(calls));
    const base: ToolExecutor = { execute: () => Promise.resolve(42) };
    const executor = governance.wrapToolExecutor(base);
    const provider = governance.wrapProvider(new FakeProvider(final("x")));

    await governance.runScope("hello", async (run) => {
      await registry.execute({
        id: "1",
        name: "echo",
        arguments: { text: "a" }
      });
      expect(
        await executor.execute({ id: "2", name: "other", arguments: {} })
      ).toBe(42);
      await provider.complete({ messages: [user("hello")] });
      run.output = { done: true };
    });

    expect(calls).toEqual([{ text: "a" }]);
    const done = evaluates.at(-1)!.body;
    expect(done.event_type).toBe("WorkflowCompleted");
    expect(done.workflow_output).toEqual({ done: true });
  });

  it("skipToolTypes bypasses tool governance", async () => {
    const { governance, evaluates } = await buildGovernance({
      options: { skipToolTypes: ["echo"] }
    });
    const calls: Record<string, unknown>[] = [];
    const loop = governance.governLoop(
      new AgentLoop(
        new FakeProvider(toolTurn("echo", { text: "a" }), final("d")),
        undefined,
        makeRegistry(calls)
      )
    );
    await loop.run({ name: "a", instructions: "i", model: { model: "m" } }, [
      user("go")
    ]);
    expect(calls).toHaveLength(1);
    expect(evaluates.some((e) => e.body.activity_type === "echo")).toBe(false);
  });

  it("send flags disable their events", async () => {
    const { governance, evaluates } = await buildGovernance({
      options: {
        sendRunStartEvent: false,
        sendRunEndEvent: false,
        sendLlmEndEvent: false
      }
    });
    await governance
      .governLoop(new AgentLoop(new FakeProvider(final("d"))))
      .run({ name: "a", instructions: "i", model: { model: "m" } }, [
        user("go")
      ]);
    const types = evaluates.map((e) => e.body.event_type);
    expect(types).not.toContain("WorkflowStarted");
    expect(types).not.toContain("WorkflowCompleted");
    expect(types).not.toContain("ActivityCompleted");
  });

  it("proxied registry keeps the rest of the ToolRegistry API", async () => {
    const { governance } = await buildGovernance();
    const raw = makeRegistry([]);
    const wrapped = governance.wrapToolRegistry(raw);
    expect(wrapped.definitions().map((d) => d.name)).toEqual(["echo"]);
    expect(wrapped).toBeInstanceOf(ToolRegistry);
  });
});
