#!/usr/bin/env node
/**
 * Content Builder Agent (Agent-RT + OpenBox Governance)
 *
 * A content writer agent configured entirely through files on disk:
 * - AGENTS.md defines brand voice and style guide
 * - skills/ provides specialized workflows (blog posts, social media)
 * - subagents.yaml defines the researcher subagent configuration
 *
 * Usage:
 *   node examples/content-builder-agent/content-writer.ts "Write a blog post about AI agents"
 *   npm run example:content-writer -- "Create a LinkedIn post about prompt engineering"
 *
 * This is a 1:1 TypeScript port of content_writer.py from the Python SDK. A few
 * behaviors map differently because of the underlying platforms (each is noted
 * inline): Agent-RT TS tools take plain JSON-schema definitions instead of zod,
 * and `rich` console rendering is approximated with `chalk`.
 */

import {
  mkdir,
  readdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { argv, env } from "node:process";

import chalk from "chalk";
import yaml from "js-yaml";
import { config as loadDotenv } from "dotenv";
import {
  AgentLoop,
  ToolRegistry,
  loadModel,
  type AgentConfig,
  type AgentRunResult,
  type ModelMessage,
  type ModelProvider,
  type ModelStreamEvent,
  type ToolDefinition,
  type ToolHandler
} from "agent-rt";

import {
  createOpenBoxAgentRT,
  type GovernedAgentLoop,
  type OpenBoxAgentRTGovernance
} from "@openbox-ai/openbox-agentrt-governance/governance";

// Python configures the stdlib logging module (WARNING globally, DEBUG for the
// "openbox_agentrt" logger). The TS SDK exposes only a minimal warn-sink
// `logger` option, so the closest equivalent is to route SDK diagnostics to the
// console (wired into governance in `createContentWriter`).

const EXAMPLE_DIR = dirname(fileURLToPath(import.meta.url));

// Load environment from this example's own .env (mirrors the Python example,
// which is run from this directory so load_dotenv() picks up ./.env). Using an
// explicit path makes it work regardless of the current working directory.
loadDotenv({ quiet: true, path: join(EXAMPLE_DIR, ".env") });

/** Read a required environment variable, throwing if unset (mirrors os.environ[key]). */
function requireEnv(name: string): string {
  const value = env[name];
  if (value === undefined) {
    throw new Error(`Environment variable ${name} is not set`);
  }
  return value;
}

/** Model name for Agent-RT's `loadModel()` provider (OPENAI_MODEL or ANTHROPIC_MODEL). */
function configuredModel(): string {
  const model = env.OPENAI_MODEL ?? env.ANTHROPIC_MODEL;
  if (!model) {
    throw new Error(
      "Set OPENAI_MODEL or ANTHROPIC_MODEL before running this example."
    );
  }
  return model;
}

/** HTTP is more reliable with local OpenAI-compatible proxies than WebSockets. */
async function loadExampleModel(): Promise<ModelProvider> {
  const environment: NodeJS.ProcessEnv = {
    ...env,
    OPENAI_WEBSOCKET: env.OPENAI_WEBSOCKET ?? "false"
  };
  return loadModel(environment, { validate: !environment.OPENAI_BASE_URL });
}

/** Resolve a model-supplied relative path, refusing to escape the example directory. */
function examplePath(filePath: string): string {
  const path = resolve(EXAMPLE_DIR, filePath);
  if (!path.startsWith(`${EXAMPLE_DIR}${sep}`)) {
    throw new Error(`path must stay inside the example directory: ${filePath}`);
  }
  return path;
}

/** JSON schema for an object whose properties are all required strings. */
function stringSchema(
  properties: Record<string, string>
): Record<string, unknown> {
  return {
    type: "object",
    required: Object.keys(properties),
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, description]) => [
        name,
        { type: "string", description }
      ])
    ),
    additionalProperties: false
  };
}

// ═══════════════════════════════════════════════════════════════════
// Tools
// ═══════════════════════════════════════════════════════════════════

const webSearch: ToolHandler = async (args) => {
  try {
    const { tavily } = await import("@tavily/core");

    const apiKey = env.TAVILY_API_KEY;
    if (!apiKey) {
      return { error: "TAVILY_API_KEY not set" };
    }

    const client = tavily({ apiKey });
    return await client.search(String(args.query), {
      maxResults: typeof args.max_results === "number" ? args.max_results : 5,
      topic: args.topic === "news" ? "news" : "general"
    });
  } catch (e) {
    return { error: `Search failed: ${String(e)}` };
  }
};

const writeFile: ToolHandler = async (args) => {
  try {
    const path = examplePath(String(args.file_path));
    await mkdir(dirname(path), { recursive: true });
    await fsWriteFile(path, String(args.content));
    return `File written to ${path}`;
  } catch (e) {
    return `Error: ${String(e)}`;
  }
};

const readFile: ToolHandler = async (args) => {
  try {
    return await fsReadFile(examplePath(String(args.file_path)), "utf-8");
  } catch (e) {
    return `Error: ${String(e)}`;
  }
};

/** Generate one image with Gemini and save it to `outputPath`. */
async function generateImage(
  prompt: string,
  outputPath: string
): Promise<string> {
  if (!env.GOOGLE_API_KEY && !env.GEMINI_API_KEY) {
    return "Image generation skipped: set GOOGLE_API_KEY or GEMINI_API_KEY.";
  }
  const { GoogleGenAI } = await import("@google/genai");
  // Python's genai.Client() auto-reads GOOGLE_API_KEY/GEMINI_API_KEY from the
  // environment; the JS SDK requires an explicit key, so pass it through.
  const client = new GoogleGenAI({
    apiKey: env.GOOGLE_API_KEY ?? env.GEMINI_API_KEY ?? ""
  });
  const response = await client.models.generateContent({
    model: "gemini-2.5-flash-image",
    contents: [prompt]
  });

  const parts = response.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    const data = part.inlineData?.data;
    if (data) {
      await mkdir(dirname(outputPath), { recursive: true });
      await fsWriteFile(outputPath, Buffer.from(data, "base64"));
      return `Image saved to ${outputPath}`;
    }
  }

  return "No image generated";
}

const generateCover: ToolHandler = async (args) => {
  try {
    const outputPath = examplePath(`blogs/${String(args.slug)}/hero.png`);
    return await generateImage(String(args.prompt), outputPath);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
};

const generateSocialImage: ToolHandler = async (args) => {
  try {
    const outputPath = examplePath(
      `${String(args.platform)}/${String(args.slug)}/image.png`
    );
    return await generateImage(String(args.prompt), outputPath);
  } catch (e) {
    return `Error: ${String(e)}`;
  }
};

const TOOLS: Record<string, [ToolDefinition, ToolHandler]> = {
  web_search: [
    {
      name: "web_search",
      description:
        "Search the web for current information. Returns search results with titles, URLs, and content excerpts.",
      inputSchema: {
        type: "object",
        required: ["query"],
        properties: {
          query: {
            type: "string",
            description: "The search query (be specific and detailed)"
          },
          max_results: {
            type: "integer",
            description: "Number of results to return (default: 5)"
          },
          topic: {
            type: "string",
            enum: ["general", "news"],
            description: '"general" for most queries, "news" for current events'
          }
        },
        additionalProperties: false
      },
      sideEffect: "read"
    },
    webSearch
  ],
  write_file: [
    {
      name: "write_file",
      description:
        "Write content to a file. Creates parent directories as needed.",
      inputSchema: stringSchema({
        file_path:
          "Relative path from the project root (e.g., 'blogs/my-post/post.md')",
        content: "The content to write"
      }),
      sideEffect: "write"
    },
    writeFile
  ],
  read_file: [
    {
      name: "read_file",
      description: "Read content from a file.",
      inputSchema: stringSchema({
        file_path:
          "Relative path from the project root (e.g., 'research/topic.md')"
      }),
      sideEffect: "read"
    },
    readFile
  ],
  generate_cover: [
    {
      name: "generate_cover",
      description: "Generate a cover image for a blog post.",
      inputSchema: stringSchema({
        prompt: "Detailed description of the image to generate.",
        slug: "Blog post slug. Image saves to blogs/<slug>/hero.png"
      }),
      sideEffect: "write"
    },
    generateCover
  ],
  generate_social_image: [
    {
      name: "generate_social_image",
      description: "Generate an image for a social media post.",
      inputSchema: stringSchema({
        prompt: "Detailed description of the image to generate.",
        platform: 'Either "linkedin" or "tweets"',
        slug: "Post slug. Image saves to <platform>/<slug>/image.png"
      }),
      sideEffect: "write"
    },
    generateSocialImage
  ]
};

/** Register the named tools from `TOOLS` in a fresh registry. */
function buildRegistry(names: string[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const name of names) {
    const tool = TOOLS[name];
    if (!tool) {
      throw new Error(`Unknown tool in subagents.yaml: ${name}`);
    }
    const [definition, handler] = tool;
    registry.register(definition, { handler });
  }
  return registry;
}

// ═══════════════════════════════════════════════════════════════════
// Skill & subagent loading
// ═══════════════════════════════════════════════════════════════════

/** Load all SKILL.md files and return their combined content. */
async function loadSkills(skillsDir: string): Promise<string> {
  const skillFiles: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name === "SKILL.md") {
        skillFiles.push(full);
      }
    }
  };
  await walk(skillsDir);
  // Lexicographic by full path (matches Python's sorted(rglob("SKILL.md")) for
  // the current skills/ layout; add prefix-colliding dir names only with care).
  skillFiles.sort();
  const skillContents = await Promise.all(
    skillFiles.map((file) => fsReadFile(file, "utf-8"))
  );
  return skillContents.join("\n\n---\n\n");
}

/** Load subagent definitions from YAML. */
async function loadSubagentConfig(
  configPath: string
): Promise<Record<string, unknown>> {
  return (yaml.load(await fsReadFile(configPath, "utf-8")) ?? {}) as Record<
    string,
    unknown
  >;
}

// ═══════════════════════════════════════════════════════════════════
// Researcher subagent
// ═══════════════════════════════════════════════════════════════════

function userMessage(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** Text of the run's final assistant response. */
function lastAssistantText(result: AgentRunResult): string {
  return (result.finalResponse?.message.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
}

/** Create and run the researcher subagent as its own governed Agent-RT run. */
async function runResearcher(
  governance: OpenBoxAgentRTGovernance,
  topic: string,
  saveTo: string
): Promise<string> {
  const config = await loadSubagentConfig(join(EXAMPLE_DIR, "subagents.yaml"));
  const researcherSpec = (config.researcher ?? {}) as Record<string, unknown>;
  const systemPrompt =
    typeof researcherSpec.system_prompt === "string"
      ? researcherSpec.system_prompt
      : "You are a research assistant.";
  const modelName =
    typeof researcherSpec.model === "string" &&
    researcherSpec.model !== "inherit"
      ? researcherSpec.model
      : configuredModel();
  const toolNames = Array.isArray(researcherSpec.tools)
    ? researcherSpec.tools.map(String)
    : ["web_search", "write_file"];

  const researcher: AgentConfig = {
    name: "researcher",
    instructions: systemPrompt,
    model: { model: modelName, temperature: 0 }
  };
  const researcherProvider = await loadExampleModel();
  const loop = governance.governLoop(
    new AgentLoop(researcherProvider, undefined, buildRegistry(toolNames))
  );

  const taskDescription = `Research ${topic} and save findings to ${saveTo}`;
  let result: AgentRunResult;
  try {
    result = await loop.run(researcher, [userMessage(taskDescription)]);
  } finally {
    await (
      researcherProvider as ModelProvider & { close?: () => Promise<void> }
    ).close?.();
  }

  // Extract last AI message as summary
  const content = lastAssistantText(result);
  if (content) {
    return `Research complete. Summary: ${content.slice(0, 300)}...`;
  }
  return "Research complete.";
}

/** Delegate research to the researcher subagent. */
function researchTool(
  governance: OpenBoxAgentRTGovernance
): [ToolDefinition, ToolHandler] {
  const research: ToolHandler = async (args) => {
    const topic = String(args.topic);
    console.log(
      `  ${chalk.bold.magenta(">> Researching:")} ${topic.slice(0, 60)}...`
    );
    const result = await runResearcher(governance, topic, String(args.save_to));
    console.log(`  ${chalk.green("✓ Research complete")}`);
    return result;
  };

  const definition: ToolDefinition = {
    name: "research",
    description:
      "Delegate research to the researcher subagent. ALWAYS use this first before writing any content.",
    inputSchema: stringSchema({
      topic: "The topic to research (be specific)",
      save_to:
        "File path to save research results (e.g., 'research/ai-agents.md')"
    }),
    sideEffect: "write"
  };
  return [definition, research];
}

// ═══════════════════════════════════════════════════════════════════
// Main agent
// ═══════════════════════════════════════════════════════════════════

/**
 * Create a content writer agent configured by filesystem files.
 *
 * Returns the governed loop, the agent config, and the governance handle (so
 * the caller can `close()` it), matching the Python example's tuple.
 */
async function createContentWriter(): Promise<{
  loop: GovernedAgentLoop;
  agent: AgentConfig;
  governance: OpenBoxAgentRTGovernance;
}> {
  // Load memory (brand voice & style guide)
  const agentsMd = await fsReadFile(join(EXAMPLE_DIR, "AGENTS.md"), "utf-8");

  // Load skills (blog-post, social-media workflows)
  const skillsText = await loadSkills(join(EXAMPLE_DIR, "skills"));

  // Build system prompt combining memory + skills
  const systemPrompt = `${agentsMd}

## Available Skills (loaded from skills/)

${skillsText}

## Tool Usage Instructions

- Use the \`research\` tool FIRST before writing any content
- Use \`write_file\` to save content to the appropriate directory
- Use \`read_file\` to read research results before writing
- Use \`generate_cover\` for blog post cover images (saves to blogs/<slug>/hero.png)
- Use \`generate_social_image\` for social media images (saves to <platform>/<slug>/image.png)
`;

  // Create OpenBox governance (async: validates the API key on startup)
  const governance = await createOpenBoxAgentRT({
    apiUrl: env.OPENBOX_URL ?? "https://core.openbox.ai",
    apiKey: requireEnv("OPENBOX_API_KEY"),
    agentName: env.OPENBOX_AGENT_NAME ?? "ContentWriter",
    agentDid: env.OPENBOX_AGENT_DID,
    agentPrivateKey: env.OPENBOX_AGENT_PRIVATE_KEY,
    toolTypeMap: { web_search: "http", research: "agent" },
    logger: console
  });

  // Reads OPENAI_MODEL / OPENAI_API_KEY (or Anthropic equivalents)
  const provider = await loadExampleModel();

  const registry = buildRegistry([
    "write_file",
    "read_file",
    "generate_cover",
    "generate_social_image"
  ]);
  const [definition, handler] = researchTool(governance);
  registry.register(definition, { handler });

  const agent: AgentConfig = {
    name: "content-writer",
    instructions: systemPrompt,
    model: { model: configuredModel(), temperature: 0 }
  };
  const loop = governance.governLoop(
    new AgentLoop(provider, undefined, registry)
  );

  return { loop, agent, governance };
}

// ═══════════════════════════════════════════════════════════════════
// Entry point
// ═══════════════════════════════════════════════════════════════════

/** Render content inside a titled, colored box (a stand-in for rich's Panel + Markdown). */
function printPanel(
  content: string,
  title: string,
  borderColor: "green"
): void {
  const paint = chalk[borderColor];
  const width = 68;
  console.log(
    paint(`┌─ ${title} ${"─".repeat(Math.max(0, width - title.length - 4))}┐`)
  );
  for (const line of content.split("\n")) {
    console.log(`${paint("│")} ${line}`);
  }
  console.log(paint(`└${"─".repeat(width)}┘`));
}

/** Render each completed model turn: assistant text and notable tool calls. */
function printProgress(event: ModelStreamEvent): void {
  if (event.type !== "completed" || event.response === undefined) {
    return;
  }
  const message = event.response.message;
  const text = message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  if (text.trim() !== "") {
    printPanel(text, "Agent", "green");
  }
  for (const tc of message.toolCalls ?? []) {
    if (tc.name === "research") {
      console.log(
        `  >> Research: ${String(tc.arguments.topic ?? "").slice(0, 60)}...`
      );
    } else if (tc.name === "write_file") {
      console.log(`  >> Writing: ${String(tc.arguments.file_path ?? "")}`);
    }
  }
}

/** Run the content writer agent with progress output. */
async function main(): Promise<void> {
  const cliArgs = argv.slice(2);
  const task =
    cliArgs.length > 0
      ? cliArgs.join(" ")
      : "Write a blog post about how AI agents are transforming software development";

  console.log();
  console.log(
    `${chalk.bold.blue("Content Builder Agent")} ${chalk.dim("(Agent-RT + OpenBox)")}`
  );
  console.log(chalk.dim(`Task: ${task}`));
  console.log();

  const { loop, agent, governance } = await createContentWriter();

  try {
    // Stream with governance applied by the governed loop
    await loop.runStreaming(agent, [userMessage(task)], printProgress);

    console.log();
    console.log(chalk.bold.green("✓ Done!"));
  } finally {
    // Release the governance runtime + instrumentation.
    await governance.close();
  }
}

process.on("SIGINT", () => {
  console.log(chalk.yellow("\nInterrupted"));
  process.exit(130);
});

await main();
