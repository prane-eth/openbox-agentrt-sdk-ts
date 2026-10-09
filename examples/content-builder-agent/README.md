# Content Builder Agent

A content writing agent for writing blog posts, LinkedIn posts, and tweets with cover images included.

**This example demonstrates how to use Agent-RT with OpenBox governance through three filesystem primitives:**

- **Memory** (`AGENTS.md`) – persistent context like brand voice and style guidelines
- **Skills** (`skills/*/SKILL.md`) – workflows for specific tasks, loaded on demand
- **Subagents** (`subagents.yaml`) – specialized agents for delegated tasks like research

The `content-writer.ts` script shows how to combine these into a working agent using Agent-RT with OpenBox governance. It is a 1:1 TypeScript port of `content_writer.py` from the Python SDK.

## Quick Start

```bash
# Set API keys
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4o-mini"
# OPENBOX_URL is optional (default: https://core.openbox.ai)
export OPENBOX_API_KEY="obx_live_..."
export OPENBOX_AGENT_DID="did:aip:..."          # Required by default for newly registered agents
export OPENBOX_AGENT_PRIVATE_KEY="..."          # Required by default for newly registered agents
export GOOGLE_API_KEY="..."      # For image generation
export TAVILY_API_KEY="..."      # For web search (optional)

# Install deps (from the repo root) and build the SDK once
npm install
npm run build
(cd examples/content-builder-agent && npm install)

# Run
npm run example:content-writer -- "Write a blog post about prompt engineering"
```

The script reads a `.env` file in this directory (via `dotenv`), so you can put the
keys there instead of exporting them. The example depends on the parent SDK
through `file:../..`.

The example uses HTTP for OpenAI-compatible model requests by default to avoid
WebSocket continuation and keepalive problems on local proxies. Set
`OPENAI_WEBSOCKET=true` to opt back into WebSockets.

**More examples:**

```bash
npm run example:content-writer -- "Create a LinkedIn post about AI agents"
npm run example:content-writer -- "Write a Twitter thread about the future of coding"

# Or run the file directly (Node >= 24 strips TypeScript natively):
node examples/content-builder-agent/content-writer.ts "Write a blog post about prompt engineering"
```

OpenBox enables DID signing by default for newly registered agents. If signing
has been explicitly disabled for this agent in OpenBox, you can omit
`OPENBOX_AGENT_DID` and `OPENBOX_AGENT_PRIVATE_KEY`.

**Offline smoke test:** `npm run example:smoke` runs `run-smoke-agent.ts` with a
scripted Agent-RT provider, an in-memory tool, and a fake OpenBox Core
transport — no API keys or network needed.

## How It Works

The agent is configured by files on disk, not code:

```
content-builder-agent/
├── AGENTS.md                    # Brand voice & style guide
├── subagents.yaml               # Subagent definitions
├── skills/
│   ├── blog-post/
│   │   └── SKILL.md             # Blog writing workflow
│   └── social-media/
│       └── SKILL.md             # Social media workflow
├── content-writer.ts            # Wires it together (includes tools)
└── run-smoke-agent.ts           # Offline governance smoke run
```

| File                | Purpose                                         | When Loaded                        |
| ------------------- | ----------------------------------------------- | ---------------------------------- |
| `AGENTS.md`         | Brand voice, tone, writing standards            | Always (system prompt)             |
| `subagents.yaml`    | Research subagent config (prompt, model, tools) | When research tool runs            |
| `skills/*/SKILL.md` | Content-specific workflows                      | Always (appended to system prompt) |

## Architecture

```ts
// Load memory + skills into system prompt
const agentsMd = await fsReadFile(join(EXAMPLE_DIR, "AGENTS.md"), "utf-8");
const skillsText = await loadSkills(join(EXAMPLE_DIR, "skills"));

// Create OpenBox governance (async: validates the API key, returns a handle with close())
const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_URL ?? "https://core.openbox.ai",
  apiKey: requireEnv("OPENBOX_API_KEY"),
  agentName: "ContentWriter"
});

// Create a governed agent loop
const loop = governance.governLoop(
  new AgentLoop(await loadModel(), undefined, registry)
);

// Run with governance applied automatically
const result = await loop.runStreaming(
  agent,
  [userMessage(task)],
  printProgress
);
```

**Flow:**

1. Agent receives task → loads relevant skill (blog-post or social-media)
2. Calls `research` tool → runs the researcher subagent as its own governed run → saves to `research/`
3. Reads research findings → writes content → saves to `blogs/`, `linkedin/`, or `tweets/`
4. Generates cover image with Gemini → saves alongside content

File tools refuse paths that would escape the example directory.

## Output

```
blogs/
└── prompt-engineering/
    ├── post.md       # Blog content
    └── hero.png      # Generated cover image

linkedin/
└── ai-agents/
    ├── post.md       # Post content
    └── image.png     # Generated image

research/
└── prompt-engineering.md   # Research notes
```

## Customizing

**Change the voice:** Edit `AGENTS.md` to modify brand tone and style.

**Add a content type:** Create `skills/<name>/SKILL.md` with YAML frontmatter:

```yaml
---
name: newsletter
description: Use this skill when writing email newsletters
---
# Newsletter Skill
...
```

**Add a subagent:** Add to `subagents.yaml`:

```yaml
editor:
  description: Review and improve drafted content
  model: inherit
  system_prompt: |
    You are an editor. Review the content and suggest improvements...
  tools: []
```

**Add a tool:** Define a `ToolHandler` and `ToolDefinition` in `content-writer.ts`, add it to `TOOLS`, and include its name in the `buildRegistry([...])` list. Classify it for policies through `toolTypeMap`.

## Notes on the TypeScript Port

This example mirrors `content_writer.py` function-for-function. A few behaviors
map differently because of the underlying platforms:

| Aspect             | Python                                                      | TypeScript                                                 |
| ------------------ | ----------------------------------------------------------- | ---------------------------------------------------------- |
| Governance factory | `await create_openbox_agentrt(...)`, closed with `aclose()` | `await createOpenBoxAgentRT({...})`, closed with `close()` |
| Tool schemas       | `ToolDefinition(input_schema=...)`                          | `ToolDefinition` with `inputSchema` (plain JSON schema)    |
| Console output     | `rich` Console / Panel / Markdown                           | `chalk` colors + a simple `printPanel` box                 |
| Model init         | `load_model()` + `ModelSettings(model=..., temperature=0)`  | `loadModel()` + `{ model, temperature: 0 }`                |
| Web search         | `tavily-python`                                             | `@tavily/core`                                             |
| Image gen          | `google-genai` (`genai.Client()` auto-reads env key)        | `@google/genai` (`new GoogleGenAI({ apiKey })`)            |
| SDK diagnostics    | `logging.getLogger("openbox_agentrt")`                      | `logger: console` option                                   |

## Requirements

- Node.js 24.10+ (native TypeScript execution)
- `OPENAI_API_KEY` + `OPENAI_MODEL` - For the main agent and researcher
- `OPENBOX_API_KEY` - For OpenBox governance (`OPENBOX_URL` optional; defaults to `https://core.openbox.ai`)
- `GOOGLE_API_KEY` - For image generation (Gemini)
- `TAVILY_API_KEY` - For web search (optional, research still works without it)
