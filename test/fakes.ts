// Shared test fakes: scripted Agent-RT providers and a routing fake Core.

import {
  AUTH_VALIDATE_PATH,
  EVALUATE_PATH,
  OpenBoxClient
} from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { FakeAdapter } from "@openbox-ai/openbox-sdk-ts/conformance";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import type {
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelStreamEvent,
  ToolDefinition
} from "agent-rt";
import { ToolRegistry } from "agent-rt";

import { SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION } from "../src/index.js";
import {
  type OpenBoxAgentRTGovernance,
  type AgentRTGovernanceOptions
} from "../src/governance/index.js";
import { createOpenBoxAgentRT } from "../src/governance/index.js";

export const user = (text: string): ModelMessage => ({
  role: "user",
  content: [{ type: "text", text }]
});

export const final = (text: string): ModelResponse => ({
  message: { role: "assistant", content: [{ type: "text", text }] },
  model: "fake-model",
  usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  finishReason: "stop"
});

export const toolTurn = (
  name: string,
  args: Record<string, unknown>,
  id = "call_1"
): ModelResponse => ({
  message: {
    role: "assistant",
    content: [],
    toolCalls: [{ id, name, arguments: args }]
  },
  model: "fake-model",
  finishReason: "tool_calls"
});

export class FakeProvider {
  readonly name = "fake";
  readonly requests: ModelRequest[] = [];
  private readonly responses: ModelResponse[];
  constructor(...responses: ModelResponse[]) {
    this.responses = [...responses];
  }
  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const next = this.responses.shift();
    if (!next)
      return Promise.reject(new Error("FakeProvider: no scripted response"));
    return Promise.resolve(next);
  }
}

export class FakeStreamingProvider extends FakeProvider {
  async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
    const response = await this.complete(request);
    yield { type: "text_delta", text: "hi" };
    yield { type: "completed", response };
  }
}

export function makeRegistry(calls: Record<string, unknown>[]): ToolRegistry {
  const registry = new ToolRegistry();
  const definition: ToolDefinition = {
    name: "echo",
    description: "echo",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"]
    },
    sideEffect: "read"
  };
  registry.register(definition, {
    handler: (args: Record<string, unknown>) => {
      calls.push({ ...args });
      return Promise.resolve({ echo: args.text });
    }
  });
  return registry;
}

function bodyText(body: unknown): string {
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return Buffer.from(body).toString("utf-8");
  return "";
}

export interface CapturedEvaluate {
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface GovernanceHarness {
  governance: OpenBoxAgentRTGovernance;
  evaluates: CapturedEvaluate[];
  adapter: FakeAdapter;
}

/**
 * Governance whose Core verdict is chosen by inspecting each evaluate body, so a
 * test can block a specific gate regardless of send order. `route` returns the
 * response body (e.g. `{ verdict: "block", reason }`); default is allow.
 */
export async function buildGovernance(
  config: {
    route?: (body: Record<string, unknown>) => Record<string, unknown>;
    adapterOptions?: ConstructorParameters<typeof FakeAdapter>[0];
    options?: Partial<AgentRTGovernanceOptions>;
  } = {}
): Promise<GovernanceHarness> {
  const evaluates: CapturedEvaluate[] = [];
  const route = config.route ?? (() => ({ verdict: "allow" }));
  const json = (data: unknown): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
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
    const raw = bodyText(init?.body);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (url.includes(AUTH_VALIDATE_PATH))
      return Promise.resolve(json({ valid: true }));
    if (url.includes(EVALUATE_PATH)) {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      evaluates.push({ headers, body });
      return Promise.resolve(json(route(body)));
    }
    return Promise.resolve(json({ action: "allow" }));
  }) as typeof fetch;

  const identity = {
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE,
    sdkVersion: SDK_PACKAGE_VERSION
  };
  const cfg = OpenBoxConfig.resolve({
    apiUrl: "https://core.test",
    apiKey: "obx_test_key",
    ...identity
  });
  const client = new OpenBoxClient(cfg.apiUrl, cfg.apiKey, {
    fetchImpl,
    timeoutSeconds: cfg.timeoutSeconds,
    onApiError: cfg.onApiError,
    ...identity
  });
  const adapter = new FakeAdapter(config.adapterOptions);
  const runtime = new OpenBoxRuntime(cfg, { client, adapter });
  const governance = await createOpenBoxAgentRT({
    runtime,
    installInstrumentation: false,
    agentName: "test-agent",
    ...config.options
  });
  return { governance, evaluates, adapter };
}

export const eventTypes = (evaluates: CapturedEvaluate[]): string[] =>
  evaluates.map((e) => String(e.body.event_type));

export const isPreScreen = (body: Record<string, unknown>): boolean =>
  body.event_type === "ActivityStarted" &&
  String(body.activity_id).endsWith("-pre");
