// SPDX-License-Identifier: MPL-2.0

export * from "./ai/chat-runner.js";
export * from "./ai/pricing-cache.js";
export * from "./ai/provider.js";
export {
  configureProviderResolver,
  getActiveProvider,
  getProviderByName,
  invalidateProviderCache,
  knownProviderNames,
} from "./ai/provider-resolver.js";
export * from "./ai/providers/index.js";
export * from "./ai/system-prompt.js";
export * from "./ai/tools/index.js";
export * from "./audit.js";
export * from "./csrf.js";
// P12 review pass — email transport factory (consumed by hooks.server.ts).
export { buildEmailTransport, type EmailConfigRow } from "./email/transport.js";
export * from "./media/pipeline.js";
export * from "./media/storage.js";
export * from "./ops/auth.js";
export * from "./ops/deploy.js";
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
export * from "./rate-limit.js";
export * from "./register.js";
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
