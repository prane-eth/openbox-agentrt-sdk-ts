# Release status

**Versioned 1.0.0.** The adapter targets exactly `agent-rt@0.0.3` and
depends on published `@openbox-ai/openbox-sdk-ts@^2.1.0`. The root and
example resolve Agent-RT 0.0.3 from npm; publishing this adapter
requires explicit approval.

## Resolved: Agent-RT 0.0.3 dependency pin

- Root `package.json` declares `"agent-rt": "0.0.3"` in both
  `peerDependencies` and `devDependencies`.
- Root `package-lock.json` resolves registry Agent-RT `0.0.3`.
- `examples/content-builder-agent/package.json` and its lockfile
  also require **exactly 0.0.3**, not `^0.0.2`.
- Base SDK runtime functionality is imported from
  `@openbox-ai/openbox-sdk-ts`; Agent-RT is a peer dependency
  whose public types/interfaces define the integration seams.

The example uses `file:../..` for the in-repository adapter, which
is intentional and **not** part of the published package tarball.

## Verified locally

The SDK's full `npm run ci:check` gate passed after updating the
examples and dependency regression test:

- ESLint and TypeScript typecheck.
- Vitest with coverage: **65 tests passed** in the last full run
  (90% statements, 83% branches).
- `tsup` build for ESM and declarations.
- Import-light root check.
- `npm run pack:check` dry-run packaging of
  `dist/`, `README.md`, `LICENSE` and `package.json`.
- Content-builder example typecheck and offline smoke run passed.
- Example `npm ci --ignore-scripts` completed and reported zero
  vulnerabilities in that installation.

**Environment qualification:** The example install was executed
under local Node 22 and emitted engine warnings. The packages declare
Node **`>=24.10.0`**; local green checks under a lower Node version do
not establish support for it or replace a supported-Node CI run.
No deployed OpenBox Core, external identity provider, or live LLM
was contacted in the offline smoke test.

## Version: 1.0.0

**Package:** `@openbox-ai/openbox-agentrt-governance`  
**SDK identity:** `openbox-agentrt-typescript-v<version>`  
**Export paths:** `.` (shared helpers) and `./governance`
(runtime-bound enforcement).

There is only one enforcing path, behind `/governance`. The root
entry point remains import-light and is guarded by dedicated tests
and `scripts/check-root-import-light.mjs`.

## Compatibility constraints

The adapter's `GovernedAgentLoop` shallow-clones `AgentLoop` and
shadows its plain `provider`, `toolRegistry` and `toolExecutor`
fields. Agent-RT changes to these fields could invalidate governed
interception. Keep Python and TypeScript adapters in behavioral
lockstep when changing the supported Agent-RT version.

No new release or backwards-compatibility guarantee beyond the
declared exact `0.0.3` peer dependency is implied by these checks.

## Base SDK and identity

The `^2.1.0` dependency provides runtime lifecycle evaluation,
configuration, HTTP/DB/file instrumentation, and the public
identity/approval seams. The adapter forwards DID, Okta and
Keycloak workload configuration to the base SDK; it does not mint
identity proofs or tokens itself.

Startup credential validation is enabled by default and can be
skipped with `validate: false`. The default Core connectivity
posture is `fail_open`; auth/signing failures are not treated as
ordinary connectivity fallbacks. Completion sends remain
telemetry-only regardless of the error posture.

## Example

`examples/content-builder-agent` is a port of the LangChain
reference example and mirrors the Python example's file-driven layout:

- `AGENTS.md` for persistent instructions.
- `skills/*/SKILL.md` for writing workflows.
- `subagents.yaml` for a delegated Agent-RT researcher (prompt, model, tools).
- `content-writer.ts` for governed provider/tool execution: `research`
  runs the researcher as its own governed run (`web_search` via Tavily,
  `write_file`); the writer uses `write_file`, `read_file`,
  `generate_cover` and `generate_social_image` (Gemini).
- `run-smoke-agent.ts` for an entirely offline governed run.

The example's dependency lock resolves exactly Agent-RT 0.0.3
and the smoke test uses a scripted provider and fake Core.

## Release checklist

Before publishing:

1. Run clean `npm ci` under Node 24.10+ in the SDK root.
2. Run `npm run ci:check` and review the offline test coverage.
3. Run `npm run pack:check` and inspect the published contents.
4. Install and typecheck the example cleanly; run `npm run smoke`.
5. Verify public README and API docs against the built declarations.
6. Run CI/security workflows and obtain explicit publish approval.

No publish command is part of this documentation alignment task.

## References

- [API reference](./api-reference.md) — entry points and options
- [Governance model](./governance-model.md) — enforcement, telemetry and span correlation
- [SDK README](./../README.md) — public quick start
