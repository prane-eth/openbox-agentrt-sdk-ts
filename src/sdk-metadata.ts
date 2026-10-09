// SDK identity constants that brand every governance request this SDK makes.
//
// The base SDK composes the `X-OpenBox-SDK-Version` header as
// `openbox-{engine}-{language}-v{version}`. For this package that resolves to
// `openbox-agentrt-typescript-v<pkg>`: engine `"agentrt"`, language
// `"typescript"`, and the version is THIS package's own version — not the base
// SDK version — so the header identifies the Agent-RT adapter.
import { SDK_VERSION } from "./version.js";

/** Governance engine component of the SDK identifier. */
export const SDK_ENGINE = "agentrt";

/** Runtime language component of the SDK identifier. */
export const SDK_LANGUAGE = "typescript";

/** Version component of the SDK identifier — this package's own version. */
export const SDK_PACKAGE_VERSION = SDK_VERSION;
