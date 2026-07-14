// SPDX-License-Identifier: MPL-2.0

// issue #150 — theme web-font resolver. Canonical implementation lives
// in the static-generator (admin-core already depends on that app for
// deploy publishing; hosting it here would close a module cycle).
export {
  clearFontResolverMemo,
  defaultFontsCacheDir,
  type ResolvedThemeFonts,
  type ResolveThemeFontsArgs,
  resolveThemeFonts,
} from "@caelo-cms/static-generator";
export * from "./ai/chat-runner.js";
// issue #298 — the calls×context import cost model + calibration helpers.
export * from "./ai/import-cost-model.js";
export * from "./ai/pricing-cache.js";
export * from "./ai/provider.js";
export {
  checkProviderKeyHealth,
  configureProviderResolver,
  getActiveProvider,
  getProviderByName,
  invalidateProviderCache,
  knownProviderNames,
  type ProviderKeyHealth,
} from "./ai/provider-resolver.js";
export * from "./ai/providers/index.js";
export {
  awaitScreenshot,
  clearPendingScreenshots,
  deliverScreenshot,
  failScreenshot,
} from "./ai/screenshot-orchestrator.js";
export * from "./ai/system-prompt.js";
// v0.2.77 — describeError reused by SvelteKit form actions to surface
// the underlying QueryError reason (e.g. "Staging build failed: ...").
export { describeError } from "./ai/tools/_describe-error.js";
export * from "./ai/tools/index.js";
export * from "./audit.js";
export * from "./csrf.js";
// P12 review pass — email transport factory (consumed by hooks.server.ts).
export { buildEmailTransport, type EmailConfigRow } from "./email/transport.js";
export * from "./media/pipeline.js";
export * from "./media/storage.js";
export * from "./ops/auth.js";
export * from "./ops/deploy.js";
// issue #297 — pure cost-gate math for the approve UI (shows the ceiling a
// click will arm; requires a budget input when the estimate failed).
export {
  deriveCeilingFromEstimate,
  ESTIMATE_CEILING_SAFETY_FACTOR,
  formatMicrocentsAsMoney,
  microcentsToMajorUnits,
} from "./ops/imports-cost.js";
export * from "./ops/roles.js";
// P17 PR4 — MCP bridge wiring helper.
export { configureMcpBridge } from "./ops/security/mcp_tokens.js";
export {
  resetStuckTranslationUnits,
  startTranslationWorker,
  stopTranslationWorker,
} from "./ops/translation/jobs.js";
export { setTranslationProvider } from "./ops/translation/mode_1.js";
export { setMode2Provider } from "./ops/translation/mode_2.js";
export * from "./ops/users.js";
export * from "./password.js";
export * from "./permissions.js";
// v0.2.37 — proposal GC sidecar (sweeps stale pending rows daily).
export { startProposalGcWorker, stopProposalGcWorker } from "./proposal-gc-worker.js";
export * from "./rate-limit.js";
export * from "./register.js";
// P21 ship 5 — release-check sidecar worker (replaces the in-handler
// GitHub fetch; bootstrap from hooks.server.ts).
export { startReleaseCheckWorker, stopReleaseCheckWorker } from "./release-check-worker.js";
// P12+ at-rest secret encryption (project KEK + AES-GCM).
export {
  decryptSecret,
  type EncryptedSecret,
  encryptSecret,
  generateKekHex,
  kekFingerprint,
} from "./security/secret-box.js";
// P11.5 audit fix #3 — exposed for plugin-host's PluginHostInfra DI.
export { emitSnapshot } from "./snapshots/emit.js";
export * from "./tokens.js";
