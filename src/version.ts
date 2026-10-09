// Single source of truth for the SDK identity version component.
//
// A STATIC constant, hand-synced with `package.json#version` on release.
// Outbound governance requests must NOT read package metadata at request time
// (keeping the header version static avoids a filesystem/JSON read on the hot
// path). Anything needing the version for a wire header reads
// `SDK_PACKAGE_VERSION`, re-exported from here via `sdk-metadata.ts`.
export const SDK_VERSION = "1.0.0";
