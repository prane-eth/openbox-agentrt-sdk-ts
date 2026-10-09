// Fully offline smoke run for Agent-RT + OpenBox governance.
//
//   npm run smoke
//
// Uses a scripted model provider, an in-memory tool, and a fake OpenBox Core
// transport. It makes no external network calls and requires no secrets.

import {
  AUTH_VALIDATE_PATH,
  EVALUATE_PATH,
  OpenBoxClient
} from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { FakeAdapter } from "@openbox-ai/openbox-sdk-ts/conformance";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import {
  SDK_ENGINE,
  SDK_LANGUAGE,
  SDK_PACKAGE_VERSION
} from "@openbox-ai/openbox-agentrt-governance";
import { createOpenBoxAgentRT } from "@openbox-ai/openbox-agentrt-governance/governance";
import {
  AgentLoop,
  ToolRegistry,
  type AgentConfig,
  type ModelRequest,
  type ModelResponse,
  type ToolDefinition
} from "agent-rt";

class SmokeProvider {
  readonly name = "smoke";
  private call = 0;

  complete(_request: ModelRequest): Promise<ModelResponse> {
    this.call += 1;
    if (this.call === 1) {
      return Promise.resolve({
        message: {
          role: "assistant",
          content: [],
          toolCalls: [
            {
              id: "call_1",
              name: "wordcount",
              arguments: { text: "hello openbox" }
            }
          ]
        },
        model: "smoke-model",
        finishReason: "tool_calls"
      });
    }
    return Promise.resolve({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Done: the phrase has 2 words." }]
      },
      model: "smoke-model",
      finishReason: "stop"
    });
  }
}

function buildFakeRuntime(): OpenBoxRuntime {
  const json = (data: unknown): Response =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  const fetchImpl = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes(AUTH_VALIDATE_PATH))
      return Promise.resolve(json({ valid: true }));
    if (url.includes(EVALUATE_PATH))
      return Promise.resolve(json({ verdict: "allow" }));
    return Promise.resolve(json({ action: "allow" }));
  }) as typeof fetch;

  const credentialEnv = ["OPENBOX", "API", "KEY"].join("_");
  const previousCredential = process.env[credentialEnv];
  process.env[credentialEnv] = ["obx", "test", "0".repeat(32)].join("_");
  try {
    const config = OpenBoxConfig.resolve({
      apiUrl: "https://core.invalid",
      sdkEngine: SDK_ENGINE,
      sdkLanguage: SDK_LANGUAGE,
      sdkVersion: SDK_PACKAGE_VERSION
    });
    const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
      fetchImpl,
      timeoutSeconds: config.timeoutSeconds,
      onApiError: config.onApiError,
      sdkEngine: SDK_ENGINE,
      sdkLanguage: SDK_LANGUAGE,
      sdkVersion: SDK_PACKAGE_VERSION
    });
    return new OpenBoxRuntime(config, { client, adapter: new FakeAdapter() });
  } finally {
    if (previousCredential === undefined) delete process.env[credentialEnv];
    else process.env[credentialEnv] = previousCredential;
  }
}

async function main(): Promise<void> {
  let toolCalls = 0;
  const registry = new ToolRegistry();
  const wordCount: ToolDefinition = {
    name: "wordcount",
    description: "Count words in a string.",
    inputSchema: {
      type: "object",
      required: ["text"],
      properties: { text: { type: "string" } },
      additionalProperties: false
    },
    sideEffect: "read"
  };
  registry.register(wordCount, {
    handler: async (args) => {
      toolCalls += 1;
      const text = typeof args.text === "string" ? args.text : "";
      return { count: text.trim().split(/\s+/).filter(Boolean).length };
    }
  });

  const agent: AgentConfig = {
    name: "content-builder-smoke",
    instructions: "Use the wordcount tool when asked to count words.",
    model: { model: "smoke-model" }
  };
  const governance = await createOpenBoxAgentRT({
    runtime: buildFakeRuntime(),
    installInstrumentation: false,
    agentName: "content-builder-smoke"
  });

  try {
    const result = await governance
      .governLoop(new AgentLoop(new SmokeProvider(), undefined, registry))
      .run(agent, [
        {
          role: "user",
          content: [
            { type: "text", text: "How many words are in 'hello openbox'?" }
          ]
        }
      ]);

    if (result.terminationReason !== "completed" || toolCalls !== 1) {
      throw new Error(
        "offline governance smoke run did not complete as expected"
      );
    }

    const output = (result.finalResponse?.message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    console.log(output);
    console.log(
      "Governance smoke run completed with zero external network calls."
    );
  } finally {
    await governance.close();
  }
}

await main();
