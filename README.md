# @openbox-ai/openbox-agentrt-governance

OpenBox governance + observability for [Agent-RT](https://github.com/Pro-GenAI/Agent-RT) TypeScript
agents. A thin adapter over the base SDK
[`@openbox-ai/openbox-sdk-ts`](https://www.npmjs.com/package/@openbox-ai/openbox-sdk-ts),
mirroring the architecture and wire behavior of `openbox-agentrt-sdk-python`.

> **Status:** active development; APIs may still change.

## Two governance surfaces

This package exposes **two independent** entry points. They are not
interchangeable:

| Surface                 | Import                                              | Role                                                                                                                                                                                                                |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Governed agent loop** | `@openbox-ai/openbox-agentrt-governance/governance` | **Enforcement** — `createOpenBoxAgentRT`, `GovernedAgentLoop`, and the provider/tool wrappers block model/tool calls that fail governance (throws before the wrapped call). This is the only surface that enforces. |
| **Import-light root**   | `@openbox-ai/openbox-agentrt-governance`            | **Helpers + observability only** — SDK identity, event builders, message/redaction helpers, and a telemetry-only evaluator. It **never** blocks execution and never loads `agent-rt` or the base-SDK runtime.       |

The split is deliberate: the root stays safe to import anywhere, while the
runtime-bound surface (instrumentation, network, approval polling) lives behind
the `/governance` subpath.

## Install

```bash
npm install @openbox-ai/openbox-agentrt-governance agent-rt@0.0.3
```

`agent-rt@0.0.3` is an exact peer dependency (used for types only). The OpenBox
base SDK is installed transitively. Requires Node 24.10+.

## Quickstart (enforcing governance)

```ts
import { AgentLoop, ToolRegistry, loadModel, type AgentConfig } from "agent-rt";
import { createOpenBoxAgentRT } from "@openbox-ai/openbox-agentrt-governance/governance";

const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_URL ?? "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY,
  agentName: "content-builder"
});

const provider = await loadModel(); // reads OPENAI_MODEL and OPENAI_API_KEY
const registry = new ToolRegistry(); // register tools as usual
const loop = governance.governLoop(
  new AgentLoop(provider, undefined, registry)
);

const agent: AgentConfig = {
  name: "content-builder",
  instructions: "Be brief.",
  model: { model: process.env.OPENAI_MODEL ?? "gpt-4o-mini" }
};

try {
  const result = await loop.run(agent, [
    { role: "user", content: [{ type: "text", text: "Hello" }] }
  ]);
  console.log(result.terminationReason);
} finally {
  // Flushes in-flight hook telemetry, then shuts down instrumentation +
  // runtime. Always await it.
  await governance.close();
}
```

`governLoop` returns a `GovernedAgentLoop` whose `run(...)` / `runStreaming(...)`
take the same arguments as `AgentLoop`. The original loop is not mutated.

| Governed operation | Wrapper                                                                | Events                                                                                                           |
| ----- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Run   | `governance.runScope(prompt, body)`                                    | `WorkflowStarted` → `SignalReceived` (enforced) → pre-screen (enforced) → `WorkflowCompleted` / `WorkflowFailed` |
| Model | `governance.wrapProvider(provider)`                                    | `ActivityStarted(llm_call)` (enforced, redaction applied) → `ActivityCompleted`                                  |
| Tools | `governance.wrapToolRegistry(registry)` / `wrapToolExecutor(executor)` | `ActivityStarted(<tool>)` (enforced) → `ActivityCompleted`                                                       |

`AgentLoop` runs registered tools through the registry and only falls back to
the executor, so `governLoop` wraps both. A wrapped provider/tool called outside
a run scope fails closed. Tool activities carry an `__openbox` sentinel
(`tool_type` from `toolTypeMap`, plus the tool's Agent-RT `sideEffect`) so Rego
policies can classify calls.

Every started activity is closed before the workflow is — including when a run
deadline or abort signal abandons a pending call, a stream is stopped early, or
a gate blocks — and completion telemetry is best-effort: a failed send is
logged, never thrown over a tool or model result. See
[docs/governance-model.md](docs/governance-model.md).

Model calls without non-empty user text still pass through the model-start gate (with an empty `prompt` field).

## Observability-only helpers

```ts
import { evaluateLifecycleTelemetryOnly } from "@openbox-ai/openbox-agentrt-governance";

const verdict = await evaluateLifecycleTelemetryOnly(runtime, event, {
  logger: console
});
```

> The root surface sends telemetry and builds events only. A returned
> BLOCK/HALT verdict is never thrown. To enforce governance you must use the
> `/governance` surface.

## Span correlation

Each model and tool call runs inside an OpenBox activity scope
(AsyncLocalStorage) with a trace-map fallback, so HTTP/DB/file spans captured by
base instrumentation resolve to the enclosing LLM/tool activity. This is the
primary, supported correlation path.

Because the sync fs wrapper fires its telemetry after returning,
`await governance.close()` (which drains in-flight hook telemetry) so the last
fs event is durable.

## Runnable example

A fully offline smoke example (scripted model, in-memory tool, fake Core — no
network, no secrets) lives in [`examples/content-builder-agent`](examples/content-builder-agent/run-smoke-agent.ts),
next to the full content-writer port:

```bash
npm run build && npm run example:smoke
```

## Example Quick Start

From the TypeScript SDK root, configure your API keys in
`examples/content-builder-agent/.env`, then run:

```bash
npm ci
npm run build
cd examples/content-builder-agent
npm ci
npm run start -- "Write a blog post about prompt engineering"
```

`OPENBOX_URL` is optional and defaults to `https://core.openbox.ai`.
Requires Node.js 24.10 or later.

## Configuration

Environment prefix `OPENBOX_AGENTRT_*` layered over global `OPENBOX_*`. See
[docs/api-reference.md](docs/api-reference.md) for the full configuration
surface. On-API-error posture defaults to `fail_open`; set
`onApiError: "fail_closed"` for destructive agents.

### Agent identity verification (OpenBox DID, Okta AI Agent, or Keycloak workload)

`createOpenBoxAgentRT` forwards the tagged identity configuration straight to
the base SDK's `OpenBoxClient.fromConfig` — this package never mints a
signature, assertion, or token itself. One runtime and one client serve startup
validation, every gate, approval polling, HTTP/DB/file hooks, and completion
telemetry.

**OpenBox DID (v1, default):**

```ts
const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_URL ?? "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY,
  agentDid: process.env.OPENBOX_AGENT_DID,
  agentPrivateKey: process.env.OPENBOX_AGENT_PRIVATE_KEY
});
```

**Okta AI Agent (v2):**

```ts
const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_URL ?? "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY,
  agentId: process.env.OPENBOX_AGENT_ID,
  organizationId: process.env.OPENBOX_ORGANIZATION_ID,
  deploymentId: process.env.OPENBOX_DEPLOYMENT_ID,
  agentProofAudience: process.env.OPENBOX_AGENT_PROOF_AUDIENCE,
  oktaAgentId: process.env.OPENBOX_OKTA_AGENT_ID,
  oktaAgentKeyId: process.env.OPENBOX_OKTA_AGENT_KEY_ID,
  oktaAgentPrivateKey: process.env.OPENBOX_OKTA_AGENT_PRIVATE_KEY, // PKCS8 PEM, keep in a secret store
  oktaAgentAlgorithm: "RS256"
});
```

**Keycloak workload identity (IAM v3, `keycloak_workload`):**

```ts
const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_URL ?? "https://core.openbox.ai",
  apiKey: process.env.OPENBOX_API_KEY,
  identityMethod: "keycloak_workload", // recommended: a missing key is then an error
  workloadPrivateKey: process.env.OPENBOX_WORKLOAD_PRIVATE_KEY, // PKCS8 PEM RSA, keep in a secret store
  onApiError: "fail_closed"
});
```

Every field above may also be set via the corresponding `OPENBOX_AGENTRT_*` or
global `OPENBOX_*` environment variable (framework-prefixed wins). The identity
modes are mutually exclusive — the base SDK rejects combining them before any
request.

**Injected runtime.** When you pass `runtime`, it wins: the identity/config
options are ignored (no second client is built), and `close()` closes that
runtime and its client — coordinate shutdown if you share it.

## Contributing

Contributions and bug reports are welcome. Install development dependencies
with `npm ci`, then run the checks from the SDK directory:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run import:check
```

For the content-builder example, run `npm ci` inside
`examples/content-builder-agent`, then `npm run typecheck` there.
Include tests for behavior changes and update public API documentation.

## License

MIT
