import { afterEach, expect, it, vi } from "vitest";
import { buildGovernanceRuntime } from "../src/governance/runtime-builder.js";

const sampleKey = ["obx", "test", "placeholder"].join("_");
afterEach(() => vi.unstubAllEnvs());

it("uses default Core URL when unspecified", () => {
  vi.stubEnv("OPENBOX_URL", undefined);
  vi.stubEnv("OPENBOX_API_URL", undefined);
  vi.stubEnv("OPENBOX_AGENTRT_API_URL", undefined);
  const runtime = buildGovernanceRuntime({ apiKey: sampleKey });
  try {
    expect(runtime.config.apiUrl).toBe("https://core.openbox.ai");
  } finally {
    runtime.close();
  }
});

it("uses OPENBOX_URL when set", () => {
  vi.stubEnv("OPENBOX_URL", "https://override.example");
  const runtime = buildGovernanceRuntime({ apiKey: sampleKey });
  try {
    expect(runtime.config.apiUrl).toBe("https://override.example");
  } finally {
    runtime.close();
  }
});

it("prefers the explicit URL to OPENBOX_URL", () => {
  vi.stubEnv("OPENBOX_URL", "https://override.example");
  const runtime = buildGovernanceRuntime({
    apiKey: sampleKey,
    apiUrl: "https://explicit.example"
  });
  try {
    expect(runtime.config.apiUrl).toBe("https://explicit.example");
  } finally {
    runtime.close();
  }
});
