// Builds the governance runtime for one governance instance, resolving the
// circular approval dependency: the ApprovalPoller needs a client, the
// CoreAdapter needs the poller, and the runtime needs the adapter — so the
// client is built and injected explicitly.
//
// The client comes from the base SDK's shared `OpenBoxClient.fromConfig`, the
// same config -> client mapping `OpenBoxRuntime` uses. It carries every
// identity mode (DID, explicit Okta, Okta bootstrap, Keycloak workload, or
// unsigned) and the `openbox-agentrt-typescript-v<pkg>` branding from the
// resolved config, so this package never assembles identity options — or mints
// tokens — itself. One runtime, one client, one token cache for startup
// validation, every gate, approval polling, hooks, and telemetry.

import {
  SDK_ENGINE,
  SDK_LANGUAGE,
  SDK_PACKAGE_VERSION
} from "../sdk-metadata.js";
import {
  DEFAULT_APPROVAL_MAX_WAIT_MS,
  type AgentRTGovernanceOptions
} from "./options.js";
import { ApprovalPoller } from "@openbox-ai/openbox-sdk-ts/approvals";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import {
  OpenBoxConfig,
  type ResolveOptions
} from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

/** Resolve the finite approval wait: option wins, then config, then the finite default. */
export function resolveApprovalMaxWait(
  options: AgentRTGovernanceOptions,
  hitlMaxWaitMs: number | null
): number | null {
  if (options.approvalMaxWaitMs !== undefined) return options.approvalMaxWaitMs;
  if (hitlMaxWaitMs !== null) return hitlMaxWaitMs;
  return DEFAULT_APPROVAL_MAX_WAIT_MS;
}

export function buildGovernanceRuntime(
  options: AgentRTGovernanceOptions
): OpenBoxRuntime {
  const resolveInput: ResolveOptions = {
    envPrefix: options.envPrefix ?? "OPENBOX_AGENTRT",
    agentName: options.agentName ?? null,
    agentDid: options.agentDid ?? null,
    agentPrivateKey: options.agentPrivateKey ?? null,
    // Tagged identity (v2 okta_ai_agent, v3 keycloak_workload) — forwarded
    // unchanged; the base SDK owns validation, mutual exclusion, the Okta-key
    // migration alias, and method resolution (proposal §13.1, §13.7). `null`
    // here is a no-op for every field the base config layering already treats
    // as absent, so the OPENBOX_AGENTRT_* / OPENBOX_* env layering applies.
    identityMethod: options.identityMethod ?? null,
    agentId: options.agentId ?? null,
    organizationId: options.organizationId ?? null,
    deploymentId: options.deploymentId ?? null,
    agentProofAudience: options.agentProofAudience ?? null,
    oktaAgentId: options.oktaAgentId ?? null,
    oktaAgentKeyId: options.oktaAgentKeyId ?? null,
    oktaAgentPrivateKey: options.oktaAgentPrivateKey ?? null,
    oktaAgentAlgorithm: options.oktaAgentAlgorithm ?? null,
    workloadPrivateKey: options.workloadPrivateKey ?? null,
    sdkVersion: SDK_PACKAGE_VERSION,
    sdkEngine: SDK_ENGINE,
    sdkLanguage: SDK_LANGUAGE
  };
  // URL precedence: explicit option > OPENBOX_URL > hosted Core default.
  // Other optional config fields are passed only when provided.
  resolveInput.apiUrl =
    options.apiUrl || process.env.OPENBOX_URL || "https://core.openbox.ai";
  if (options.apiKey !== undefined) resolveInput.apiKey = options.apiKey;
  if (options.onApiError !== undefined)
    resolveInput.onApiError = options.onApiError;
  if (options.timeoutSeconds !== undefined)
    resolveInput.timeoutSeconds = options.timeoutSeconds;

  const config = OpenBoxConfig.resolve(resolveInput);

  const client = OpenBoxClient.fromConfig(
    config,
    options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}
  );

  // Gate on config.hitl.enabled directly (defaults true, never nullish).
  const approvalPoller = config.hitl.enabled
    ? new ApprovalPoller(client, {
        pollIntervalMs:
          options.approvalPollIntervalMs ?? config.hitl.pollIntervalMs,
        maxWaitMs: resolveApprovalMaxWait(options, config.hitl.maxWaitMs)
      })
    : null;

  const adapter = new CoreAdapter({ approvalPoller });
  return new OpenBoxRuntime(config, { client, adapter });
}
