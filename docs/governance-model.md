# Governance model

How `@openbox-ai/openbox-agentrt-governance` applies OpenBox governance
to Agent-RT JavaScript/TypeScript agents.

## Two entry points, one enforcement path

| Surface | Import | Enforces? |
|---|---|---|
| Governed loop, provider and tools | `@openbox-ai/openbox-agentrt-governance/governance` | **Yes** — start-stage gates |
| SDK identity, event builders and telemetry helpers | `@openbox-ai/openbox-agentrt-governance` (root) | **No** — shared helpers and non-enforcing telemetry |

Agent-RT exposes public `ModelProvider`, `ToolRegistry`,
`ToolExecutor` and `AgentLoop` seams. The `/governance` wrappers
intercept work and throw **before the wrapped call runs** when Core
returns BLOCK/HALT, fails guardrails, or denies/times out approval.

There is no LangChain callback surface or middleware abstraction here.
The root `evaluateLifecycleTelemetryOnly` helper never blocks execution.

## Enforce vs telemetry matrix

| Event | Surface / path | Mode |
|---|---|---|
| `WorkflowStarted` | `runScope` / telemetry evaluator | Telemetry-only (workflow setup) |
| `SignalReceived` (`user_prompt`) | `runScope` / `runtime.evaluateLifecycle` | **Enforce** |
| Pre-screen `ActivityStarted` (`<run>-pre`) | `runScope` / `runtime.evaluateLifecycle` | **Enforce** |
| Model `ActivityStarted` | `wrapProvider` / evaluator; first matching call reuses pre-screen | **Enforce** |
| Tool `ActivityStarted` | `wrapToolRegistry` or `wrapToolExecutor` / evaluator | **Enforce** |
| Model/tool `ActivityCompleted` | Telemetry evaluator | Telemetry-only |
| `WorkflowCompleted` / `WorkflowFailed` | Telemetry evaluator | Telemetry-only |

A blocking gate closes any orphan start activity with the **same ID**
and sends `WorkflowFailed` at most once before rethrowing. A tool-body
failure is recorded as an errored activity completion; if it escapes
the loop, `runScope` closes the workflow as failed. An unused allowed
pre-screen is closed before the workflow completes or fails.

Model requests without non-empty user text still enforce a model-start activity
(with an empty `prompt` field), instead of silently skipping the gate.

A promise cannot be cancelled, so an `AgentLoop` deadline
(`timeoutMs`) or abort `signal` can return while a governed model or
tool call is still pending. Each run tracks its open start rows;
`runScope` closes any still open with `RUN_ENDED`
(`AbortError: run ended before the activity completed`) before it
closes the workflow, and the abandoned call's late completion is
dropped. The Python SDK reaches the same wire outcome through asyncio
cancellation (`CancelledError`).

A stream stopped early closes the inner iterator and records
`STREAM_CLOSED`. The wrapper correlates each awaited `next()` step
independently; the consumer's event handling does not inherit the
model activity scope.

## Single active runtime (instrumentation)

Base instrumentation patches process-global HTTP/DB/file hooks, so a
process can have one active instrumentation runtime. The factory
installs hooks by default but tolerates a collision: if another
runtime already instruments the process, it logs a diagnostic and
returns `instrumentation: null` for the new agent. **Model and tool
start gates still enforce**; only that runtime's low-level hook
attribution is unavailable.

Async file hooks can govern preflight operations supported by the
base SDK. Synchronous `readFileSync`, `writeFileSync` and `mkdirSync`
are completed-hook telemetry only, because they cannot await Core
before executing. `fileEnabled: false` in base instrumentation
configuration disables the respective file hooks.

Always `await governance.close()`. It drains in-flight synchronous
file completion telemetry with `flush()` before instrumentation
shutdown and runtime closure. A runtime supplied by the caller is
also closed by this method.

## Fail-open vs fail-closed

`onApiError` defaults to **`"fail_open"`** for Core connectivity
failures. Set `onApiError: "fail_closed"` for destructive agents
that must not proceed without policy evaluation.

Authentication/signing failures are not an ordinary fail-open
connectivity fallback. Startup validation defaults to enabled;
`validate: false` skips that **startup check**, not enforcing calls.

Completion telemetry is **always best-effort** and never reopens a
denied gate or turns a completed operation into a failure.

## Redaction

When a pre-screen or model-start verdict carries
`guardrails.redactedInput`, the adapter creates a **new**
`ModelRequest` with the latest user text replaced and passes it to
the provider. Other history and non-text content remain intact; the
caller-owned `ModelMessage` objects are not mutated.

Disabling `sendLlmStartEvent` also removes the associated model-start
gate/redaction. It must not be described as a harmless telemetry-only
toggle.

## Span correlation

Governed model and tool calls run inside an OpenBox activity scope
backed by `AsyncLocalStorage` and a trace-map fallback. Nested
instrumented HTTP/DB/file operations resolve to the enclosing model
or tool activity. Streaming scopes are bound per iterator step.

## Interaction with Agent-RT's own controls

OpenBox is the outer governance layer. The inner Agent-RT execution
still enforces its permission checks, `ApprovalManager`, guardrails
and rate limits. Agent-RT's `ApprovalRequiredError` /
`waiting_for_approval` state is distinct from an OpenBox
`REQUIRE_APPROVAL` verdict; resuming a tool can begin a new
governed activity.

`AgentLoop` uses `toolRegistry.execute` for registered tools and
falls back to `toolExecutor.execute`. Both are wrapped by
`governLoop`. The TypeScript clone relies on plain Agent-RT 0.0.3
fields (`provider`, `toolRegistry` and `toolExecutor`); a future
compatibility bump must revalidate these seams.

## References

- [API reference](./api-reference.md) — public and low-level exports
- [Release status](./release-status.md) — verified checks and outstanding gates
- [SDK README](./../README.md) — installation and quick start
