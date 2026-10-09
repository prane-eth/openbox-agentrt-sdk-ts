// The package root must stay import-light: `agent-rt` is a type-only peer and the
// base-SDK runtime/instrumentation load only behind the `./governance` subpath.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION } from "../src/index.js";

const SRC = join(import.meta.dirname, "..", "src");
const rootFiles = readdirSync(SRC).filter((f) => f.endsWith(".ts"));
const HEAVY =
  /from\s+["'](agent-rt|@openbox-ai\/openbox-sdk-ts\/(runtime|instrumentation|client|adapters|approvals))["']/;

describe("package boundaries", () => {
  it.each(rootFiles)("%s has no heavy value import", (file) => {
    const lines = readFileSync(join(SRC, file), "utf-8").split("\n");
    const offenders = lines.filter(
      (l) => HEAVY.test(l) && !/^\s*import\s+type\b/.test(l)
    );
    expect(offenders).toEqual([]);
  });

  it("pins Agent-RT 0.0.3 in the SDK and content-builder example", () => {
    const repo = join(SRC, "..");
    const example = join(repo, "examples", "content-builder-agent");
    const sdk = JSON.parse(
      readFileSync(join(repo, "package.json"), "utf8")
    ) as {
      peerDependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const manifest = JSON.parse(
      readFileSync(join(example, "package.json"), "utf8")
    ) as {
      dependencies: Record<string, string>;
    };
    const lock = JSON.parse(
      readFileSync(join(example, "package-lock.json"), "utf8")
    ) as {
      packages: Record<
        string,
        { version?: string; dependencies?: Record<string, string> }
      >;
    };
    expect(sdk.peerDependencies["agent-rt"]).toBe("0.0.3");
    expect(sdk.devDependencies["agent-rt"]).toBe("0.0.3");
    expect(manifest.dependencies["agent-rt"]).toBe("0.0.3");
    expect(lock.packages[""]?.dependencies?.["agent-rt"]).toBe("0.0.3");
    expect(lock.packages["node_modules/agent-rt"]?.version).toBe("0.0.3");
  });

  it("exposes the SDK identity", () => {
    expect([SDK_ENGINE, SDK_LANGUAGE, SDK_PACKAGE_VERSION]).toEqual([
      "agentrt",
      "typescript",
      "1.0.0"
    ]);
    const pkg = JSON.parse(
      readFileSync(join(SRC, "..", "package.json"), "utf-8")
    ) as { version: string };
    expect(pkg.version).toBe(SDK_PACKAGE_VERSION);
  });
});
