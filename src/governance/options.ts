// Options for `createOpenBoxAgentRT` and their resolved form.

import type { Logger } from "../lifecycle-telemetry.js";
import type { AgentIdentityMethod } from "@openbox-ai/openbox-sdk-ts";
import type { OnApiError } from "@openbox-ai/openbox-sdk-ts/config";
import type { DatabaseDriverName } from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/**
 * Finite client-side approval wait used when neither the option nor
 * `config.hitl.maxWaitMs` sets one. Comfortably above the typical server-side
 * approval expiry (~30 min) so a server halt normally wins, but bounded so a
 * never-approved request cannot hang a run forever. Pass `null` explicitly
 * (option or config) to opt back into indefinite polling.
 */
export const DEFAULT_APPROVAL_MAX_WAIT_MS = 60 * 60 * 1000;

export interface AgentRTGovernanceOptions {
  // ── identity / config ──
  apiUrl?: string;
  apiKey?: string;
  agentName?: string;
  agentDid?: string;
  agentPrivateKey?: string;
  /**
   * Explicit verification method override — the base SDK's own
   * `AgentIdentityMethod`. Recommended for deployments: with an explicit method,
   * a missing key is an error rather than a silently unconfigured client.
   */
  identityMethod?: AgentIdentityMethod;
  // ── v2 (okta_ai_agent) identity — forwarded to the base SDK unchanged. ──
  agentId?: string;
  organizationId?: string;
  deploymentId?: string;
  agentProofAudience?: string;
  oktaAgentId?: string;
  oktaAgentKeyId?: string;
  oktaAgentPrivateKey?: string;
  oktaAgentAlgorithm?: string;
  // ── IAM v3 (keycloak_workload) — forwarded to the base SDK unchanged. ──
  workloadPrivateKey?: string | null;
  onApiError?: OnApiError;
  timeoutSeconds?: number;
  /** Env-var prefix layered over the global `OPENBOX_*` set. */
  envPrefix?: string;

  // ── event/wire options (NOT config inputs) ──
  sessionId?: string;
  taskQueue?: string;

  // ── send flags (each also gates its enforcement + redaction) ──
  sendRunStartEvent?: boolean;
  sendRunEndEvent?: boolean;
  sendLlmStartEvent?: boolean;
  sendLlmEndEvent?: boolean;
  sendToolStartEvent?: boolean;
  sendToolEndEvent?: boolean;

  // ── tool handling ──
  /** Tool name → tool type, surfaced to policies as `__openbox.tool_type`. */
  toolTypeMap?: Record<string, string>;
  skipToolTypes?: Iterable<string>;

  // ── HITL approval polling (default from config.hitl unless set) ──
  approvalPollIntervalMs?: number;
  /** `undefined` → finite default; explicit `null` → poll indefinitely. */
  approvalMaxWaitMs?: number | null;

  // ── instrumentation ──
  installInstrumentation?: boolean;
  instrumentationStrict?: boolean;
  databases?: readonly DatabaseDriverName[];

  // ── misc ──
  /** Validate the API key against Core before returning (default `true`). */
  validate?: boolean;
  /**
   * Inject a pre-built runtime (owns its own client, identity, adapter, and
   * approval semantics). When set, it WINS: the identity/config options above
   * are ignored and `close()` closes this runtime (and therefore its client).
   */
  runtime?: OpenBoxRuntime;
  logger?: Logger;
  /** Injectable fetch for tests (e.g. a fixture-backed Core stub); defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** Options with all send flags + defaults applied (used inside the gates). */
export interface ResolvedGovernanceOptions {
  sessionId: string | null;
  agentName: string | null;
  taskQueue: string;
  sendRunStartEvent: boolean;
  sendRunEndEvent: boolean;
  sendLlmStartEvent: boolean;
  sendLlmEndEvent: boolean;
  sendToolStartEvent: boolean;
  sendToolEndEvent: boolean;
  toolTypeMap: Record<string, string>;
  skipToolTypes: Set<string>;
  logger: Logger | undefined;
}

/** Apply defaults to the event/behavior options (config-layer options handled separately). */
export function resolveGovernanceOptions(
  options: AgentRTGovernanceOptions
): ResolvedGovernanceOptions {
  return {
    sessionId: options.sessionId ?? null,
    agentName: options.agentName ?? null,
    taskQueue: options.taskQueue ?? "agentrt",
    sendRunStartEvent: options.sendRunStartEvent ?? true,
    sendRunEndEvent: options.sendRunEndEvent ?? true,
    sendLlmStartEvent: options.sendLlmStartEvent ?? true,
    sendLlmEndEvent: options.sendLlmEndEvent ?? true,
    sendToolStartEvent: options.sendToolStartEvent ?? true,
    sendToolEndEvent: options.sendToolEndEvent ?? true,
    toolTypeMap: { ...(options.toolTypeMap ?? {}) },
    skipToolTypes: new Set(options.skipToolTypes ?? []),
    logger: options.logger
  };
}
