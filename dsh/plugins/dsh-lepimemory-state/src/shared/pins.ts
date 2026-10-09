/**
 * Pinned, verification-checked runtime versions.
 *
 * Single source of truth for the exact Node / pnpm / dsh versions the launcher
 * and plugin assert. Reused by `scripts/build.mts`, the runtime launcher, and
 * the plugin entry/panel so a version bump happens in exactly one place.
 */
export const NODE_VERSION = 'v24.20.0';
export const PNPM_VERSION = '10.28.2';
export const DSH_VERSION = '0.1.7-rc.2';
