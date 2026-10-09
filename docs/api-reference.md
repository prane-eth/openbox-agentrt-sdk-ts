# API reference

Two entry points. The package root is **import-light** and provides SDK
identity, event builders, and pure helpers. Runtime-bound governance,
instrumentation and Agent-RT loop wrappers load only behind `./governance`.

## `@openbox-ai/openbox-agentrt-governance` (root — shared helpers)

### SDK identity

- `SDK_VERSION`, `SDK_PACKAGE_VERSION` — package identity/version.
- `SDK_ENGINE` (`"agentrt"`), `SDK_LANGUAGE` (`"typescript"`).
- The `X-OpenBox-SDK-Version` header uses
  `openbox-agentrt-typescript-v<version>`.

### Lifecycle helpers (pure)

- `buildWorkflowStarted`, `buildWorkflowCompleted`,
  `buildWorkflowFailed`, `buildSignalReceived`,
  `buildActivityStarted`, `buildActivityCompleted`.
- `mergeSessionExtra` — injects `session_id` and `agent_name`
  as snake_case wire keys.
- `toErrorInfo` — converts caught values into structured error details
  required by the Core lifecycle contract.
- `enrichActivityInput` — adds an `__openbox` sentinel for tool
  classification/side-effect metadata.

### Message extraction and redaction

- `extractLastUserText` / `messageText` — read text from Agent-RT
  `ModelMessage` sequences.
- `coerceRedactedText` / `applyRedaction` — apply returned guardrail text
  to copied model messages; never mutate caller-owned history.
- `extractResponseMetadata` — summarize model response/usage for completion
  telemetry.

### Telemetry evaluator (non-enforcing)

`evaluateLifecycleTelemetryOnly(runtime, event, { logger? })` sends a
post-work lifecycle event and returns the base SDK's result or `null` after
a suppressed evaluation failure. **It never enforces a verdict.** Use the
`/governance` surface for enforceable model/tool starts.

## `@openbox-ai/openbox-agentrt-governance/governance` (enforcement)

### `createOpenBoxAgentRT(options?)`

```ts
import { AgentLoop, ToolRegistry, loadModel } from "agent-rt";
import { createOpenBoxAgentRT } from "@openbox-ai/openbox-agentrt-governance/governance";

const governance = await createOpenBoxAgentRT({
  apiUrl: process.env.OPENBOX_API_URL,
  apiKey: process.env.OPENBOX_API_KEY,
  agentName: "MyAgent"
});

try {
  const provider = await loadModel();
  const loop = governance.governLoop(
    new AgentLoop(provider, undefined, new ToolRegistry())
  );
  // Register tools and pass your AgentConfig and ModelMessage[]:
  // const result = await loop.run(agent, messages);
} finally {
  await governance.close();
}
```

Returns `Promise<OpenBoxAgentRTGovernance>`. By default the factory builds
one base-SDK runtime, validates the API key against Core, and installs
HTTP/DB/file instrumentation (collision-safe). `validate: false` skips
startup validation. If validation/installation fails, a runtime created
by the factory is closed; an injected `runtime` remains the caller's.

### `OpenBoxAgentRTGovernance`

| Member | Description |
|---|---|
| `runtime` | The underlying `OpenBoxRuntime` |
| `instrumentation` | Controller, or `null` if disabled or owned elsewhere |
| `runScope(prompt, body)` | Workflow, signal and pre-screen gates; invokes `body(run)`; returns its result |
| `governLoop(loop)` | Creates a `GovernedAgentLoop` without mutating the original |
| `wrapProvider(provider)` | Governed `ModelProvider`; preserves streaming when implemented |
| `wrapToolRegistry(registry)` | Governed `ToolRegistry.execute` |
| `wrapToolExecutor(executor)` | Governed `ToolExecutor.execute` |
| `close()` | Async flush → instrumentation shutdown → runtime close |

`runScope` supplies per-run state; set `run.output` in the body when
writing custom workflows to include a summarized workflow result.

### `GovernedAgentLoop`

`run(...args)` / `runStreaming(...args)` use the same parameters and
return the same result types as Agent-RT's `AgentLoop`. Both execute
inside a governed run scope.

The adapter shallow-clones the original `AgentLoop` and shadows its
`provider`, `toolRegistry` and `toolExecutor` fields with wrapped
versions. This depends on the Agent-RT 0.0.3 field layout and must be
rechecked whenever Agent-RT changes.

The workflow output summary is:

```text
{ result, termination_reason, turns, tool_calls, total_tokens }
```

### `AgentRTGovernanceOptions`

**Identity and configuration**

- `apiUrl`, `apiKey`, `agentName`, `onApiError` (default
  `"fail_open"`), `timeoutSeconds`, `envPrefix` (default
  `"OPENBOX_AGENTRT"`).
- `agentDid`, `agentPrivateKey` — DID identity.
- `identityMethod` — base SDK method selection.
- `agentId`, `organizationId`, `deploymentId`,
  `agentProofAudience`, `oktaAgentId`, `oktaAgentKeyId`,
  `oktaAgentPrivateKey`, `oktaAgentAlgorithm` — Okta identity.
- `workloadPrivateKey` — Keycloak workload identity (PKCS8 RSA key).
  Identity secrets are forwarded to the base SDK unchanged and are
  never minted/signed by this adapter.

**Lifecycle and tool options**

- `sessionId`, `taskQueue` (default `"agentrt"`).
- `sendRunStartEvent`, `sendRunEndEvent`,
  `sendLlmStartEvent`, `sendLlmEndEvent`,
  `sendToolStartEvent`, `sendToolEndEvent` (default `true`).
  **Start flags also control the corresponding enforcement/redaction.**
- `toolTypeMap` (tool name → policy type) and `skipToolTypes`.

**HITL**

- `approvalPollIntervalMs` — override the resolved polling interval.
- `approvalMaxWaitMs` — default finite one-hour wait if not set by
  configuration; explicit `null` opts into indefinite polling.
- `DEFAULT_APPROVAL_MAX_WAIT_MS` is exported as a constant.

**Instrumentation and testing**

- `installInstrumentation` (default enabled),
  `instrumentationStrict`, `databases`.
- `validate` (default `true`), `logger`, `fetchImpl`.
- `runtime` — injects an existing runtime; it wins over identity/config
  options, and `close()` closes that supplied runtime.

### Low-level exports

`runScope`, `wrapModelProvider`, `wrapToolRegistry`,
`wrapToolExecutor`, `governToolCall`, `currentRun`,
`requireRun` and `resolveGovernanceOptions` are available for
custom integrations. Types include `GovernanceContext`,
`AgentRTGovernanceOptions`, `ResolvedGovernanceOptions`,
`RunState` and `PreScreenSummary`.

## Compatibility

The package's `agent-rt` peer and dev dependencies are pinned to
**exactly 0.0.3** (not a range). The content-builder example follows
the same pin in its manifest and lockfile. Node.js `>=24.10.0` is
the declared engine requirement; `@openbox-ai/openbox-sdk-ts` is the
runtime dependency.

See [governance-model.md](./governance-model.md) for the enforce-vs-
telemetry matrix, instrumentation constraints and error posture.
See [release-status.md](./release-status.md) for package verification.
