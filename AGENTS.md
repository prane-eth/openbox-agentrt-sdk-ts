# AGENTS.md — OpenBox Agent-RT SDK (TypeScript)

## Project Overview

OpenBox governance SDK for [Agent-RT](https://github.com/Pro-GenAI/Agent-RT) TypeScript agents. Wraps
Agent-RT's public seams (`ModelProvider`, `ToolRegistry` / `ToolExecutor`, `AgentLoop`) and enforces
OpenBox policies, guardrails, and HITL approvals inline. Mirrors the layout and conventions of
`openbox-langchain-sdk-ts`; the Python twin is `openbox-agentrt-sdk-python` — keep behavior and
event semantics in lockstep with it.

**Key principle:** only the Agent-RT integration layer lives here. Client, gate, runtime, approvals,
instrumentation, and contracts come from `@openbox-ai/openbox-sdk-ts` — never copied.

## Architecture

- **Layer 1:** `OpenBoxAgentRTGovernance` — run scope + governed provider/tool/loop wrappers.
- **Layer 2:** HTTP/DB/file hook governance — base-SDK instrumentation, installed per runtime.
- **Layer 3:** activity context mapping — wrappers run each model and tool body under
  `correlate(...)` (AsyncLocalStorage + trace-map fallback) so Layer-2 spans resolve to the right
  activity.

**Invariants:**

- The root stays import-light: `agent-rt` is imported with `import type` only; runtime/instrumentation
  imports live under `src/governance/`. Enforced by `scripts/check-root-import-light.mjs` and
  `test/package-boundaries.test.ts`.
- Start-stage events are **enforced** (`enforceGate` → `runtime.evaluateLifecycle`); completions are
  **telemetry only** (`sendTelemetry`) and never throw for a verdict.
- On enforcement failure: close the orphan start row (same activity id — model, tool, and pre-screen
  rows alike), send `WorkflowFailed` once (`RunState.workflowClosed`), rethrow the original error.
  Errors go to the wire as structured `ErrorInfo` (`toErrorInfo`) — a bare string is rejected by Core.
- No orphan rows: an allowed pre-screen that no model call consumed is closed at run end (before
  `WorkflowFailed` when a later gate blocks — `closeWorkflow`), and a stream the consumer stops
  early (`return()`) records `STREAM_CLOSED` and closes the inner stream.
- Promises cannot be cancelled: an `AgentLoop` deadline (`timeoutMs`) or abort `signal` returns while
  a governed model/tool call is still pending. Every start row is tracked in `RunState.openActivities`
  (`openActivity`); `runScope` closes rows still open with `RUN_ENDED` before closing the workflow,
  and every completion claims its row first (`settleActivity`) so a late settle sends nothing.
- Run identity lives in `AsyncLocalStorage`, never on the governance instance.
- The run's first model call **for the pre-screened prompt** (`preScreen.prompt`) reuses the
  pre-screen verdict (`preScreenUsed`) — even when the caller passes prior chat history.
- Streaming: correlate each `next()` step (`correlate(...)`), so instrumented I/O inside the stream is
  attributed to the LLM row but the consumer's event handler is not.
- `createOpenBoxAgentRT` closes a runtime it built if validation or instrumentation install fails;
  an injected `runtime` stays the caller's.
- `AgentLoop` prefers `toolRegistry.execute` over `toolExecutor.execute`; wrap both. `GovernedAgentLoop`
  clones the loop via `Object.create` + shadowed own props — it relies on `AgentLoop` keeping `provider`,
  `toolRegistry`, `toolExecutor` as plain (non-`#`) fields; re-check on Agent-RT changes.
- Redaction builds new `ModelMessage`s; never mutate conversation history.

Both peer and development dependencies pin Agent-RT to exactly `0.0.3`.
Keep the SDK and content-builder example `package.json`/`package-lock.json` files on exact
registry Agent-RT 0.0.3, verified by `npm ci`. The package-boundaries test guards these pins.

## Package Structure

```
src/
├── index.ts                  # import-light root: identity + pure helpers
├── version.ts / sdk-metadata.ts   # static SDK identity (engine "agentrt")
├── lifecycle-events.ts       # envelope builders (snake_case session/agent injection)
├── lifecycle-telemetry.ts    # non-enforcing evaluator
├── message-extraction.ts     # ModelMessage helpers, redaction, response metadata
├── activity-input.ts         # __openbox sentinel enrichment
├── error-info.ts / serialization.ts / property-access.ts
└── governance/               # runtime-bound surface (./governance subpath)
    ├── factory.ts            # createOpenBoxAgentRT (validates key, installs instrumentation)
    ├── governance.ts         # OpenBoxAgentRTGovernance
    ├── runtime-builder.ts    # config → OpenBoxClient → ApprovalPoller → CoreAdapter → runtime
    ├── options.ts            # AgentRTGovernanceOptions + resolved form
    ├── run-state.ts          # RunState + AsyncLocalStorage
    ├── run-scope.ts          # run bracket (workflow + signal + pre-screen)
    ├── model-provider.ts     # governed provider (Proxy; streaming-aware)
    ├── tool-governance.ts    # governed registry/executor (Proxy)
    ├── loop.ts               # GovernedAgentLoop (clones the loop, wraps its seams)
    └── context.ts            # GovernanceContext, enforceGate, telemetry, correlation
```

## Key Classes

- `OpenBoxAgentRTGovernance` — Owns one `OpenBoxRuntime`; `runScope`, wrappers, `close()`
- `GovernedAgentLoop` — Governed `AgentLoop` (`run`, `runStreaming`)
- `AgentRTGovernanceOptions` — Configuration interface (resolved by `resolveGovernanceOptions`)
- `RunState` — Per-run identity, pre-screen summary, and close flag (bound in `AsyncLocalStorage`)

## Key Functions

- `createOpenBoxAgentRT()` — Async factory (primary entry point); validates the API key
- `runScope()` — `WorkflowStarted`, `SignalReceived`, pre-screen, run close
- `enforceGate()` — Enforced start-stage evaluation; closes orphans on failure
- `sendTelemetry()` — Best-effort completion send; never throws for a verdict
- `wrapModelProvider()` / `wrapToolRegistry()` / `wrapToolExecutor()` — Seam wrappers (Proxy)
- `governToolCall()` — Tool gate, correlation, and completion for registry/executor paths
- `buildGovernanceRuntime()` — Config → one `OpenBoxClient` → `ApprovalPoller` → `CoreAdapter` → runtime

## Quick Start

```ts
import { AgentLoop, ToolRegistry, loadModel } from "agent-rt";
import { createOpenBoxAgentRT } from "@openbox-ai/openbox-agentrt-governance/governance";

// Create governance
const governance = await createOpenBoxAgentRT({
  apiUrl: "https://core.openbox.ai",
  apiKey: "obx_live_...",
  agentName: "MyAgent"
});

// Wrap an Agent-RT loop
const loop = governance.governLoop(new AgentLoop(await loadModel(), undefined, new ToolRegistry()));

// Run — governance applied automatically
const result = await loop.run(agent, messages);
await governance.close();
```

## Commands

```bash
# Install
npm install

# Test (vitest with coverage thresholds)
npm test

# Lint
npm run lint

# Type check
npm run typecheck

# Everything: lint → typecheck → test → build → import:check
npm run ci:check

# Examples
npm run example:smoke
npm run example:content-writer -- "Write a blog post about AI agents"
```

## Testing

**Current:** 65 tests, 100% pass rate, 90% statement coverage (83% branches)

**Coverage:**
- Full governed `AgentLoop` lifecycle against a real Agent-RT loop
- Verdict enforcement (signal, pre-screen, model, tool), guardrail redaction, approval rejection
- Orphan-row closure (incl. calls a run deadline or abort abandons), streaming correlation, early
  stream close, best-effort completion telemetry, pre-screen reuse, shared approval client
- Factory validation, error-info normalization, serialization, message extraction
- Package boundaries (import-light root) and the Agent-RT 0.0.3 pin

Offline only: a routing fake Core (`test/fakes.ts`) decides each verdict from the evaluate body, plus
the base SDK's `FakeAdapter` (records enforcement delegations). No network, no real LLM.
`test/lifecycle-hardening.test.ts` covers the orphan-row, abandoned-call, streaming-correlation,
telemetry-failure, and pre-screen-reuse invariants above; keep it in lockstep with the Python `tests/test_lifecycle_hardening.py`.

## Documentation

- **README.md** — install, quick start, configuration
- **docs/api-reference.md** — exports and options
- **docs/governance-model.md** — enforce vs telemetry matrix, verdicts, instrumentation
- **docs/release-status.md** — verified gates and release checklist
- **examples/content-builder-agent/** — governed port of the LangChain reference example (Tavily search, Gemini images) plus an offline smoke run, aligned with the Python twin

Preserve the exact three-document `docs/` layout of the LangChain TypeScript reference.
Keep its API-reference, governance-model and release-status sectioning, Markdown
formatting, tables, and relative cross-links while retaining Agent-RT-specific
seams and reporting only verified release status.

## References

- Agent-RT: `../typescript` (runtime) and `../docs/Introduction-to-Harness.md`
- LangChain reference SDK: `../openbox-examples/openbox-langchain-sdk-ts`
