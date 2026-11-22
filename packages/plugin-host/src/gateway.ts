// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-host/gateway — what the API gateway imports of the
 * plugin host (#1340, epic #763 E2-B).
 *
 * A separate entry so the gateway's bundle holds only the dispatch-only
 * host: plugins attached as their manifests, visitor calls run as their
 * declarations with core code, the consent rule computed by core. Nothing
 * reachable from here imports the plugin loader, the plugin validator,
 * the sandbox or a plugin's dist — `gateway-entry.test.ts` walks this
 * module's imports and fails on any of them.
 */

export { failureProvedUnbilled } from "./ai-unbilled.js";
// #1649 / #1650 — declared collection operations, executed by core code.
export {
  AI_CHAT_SEARCH_HITS,
  aiChatToolParams,
  type CollectionAnswer,
  MAX_QUERY_WORDS,
  ModelUnavailableError,
  type OpenEntry,
  runCollectionOperation,
  wasmQueryEmbedder,
} from "./collection-query.js";
export {
  consentPurposeDeclared,
  declaredConsentPurposes,
  pluginDeclaresConsentPurpose,
} from "./consent-purposes.js";
export {
  hostInfra,
  isPluginDisabled,
  type LoadedPlugin,
  loadedPlugins,
  runPluginOperation,
} from "./dispatch.js";
export {
  bootstrapDispatchOnly,
  markDispatchRegistryStale,
  resetDispatchOnlyHost,
  servesVisitorOperations,
  syncDispatchPlugins,
} from "./gateway-attach.js";
export { registerGatewayOperations } from "./gateway-ops.js";
export { verifyMailUnsubscribeToken } from "./mail-link-token.js";
export { checkShippedManifests } from "./manifest-definition.js";
export { unpublishedRegistryError } from "./published-state.js";
// #1655 — released visitor-visible configuration for public declarations.
export {
  type PublishedVisitorConfigReader,
  publishedVisitorConfig,
  setPublishedVisitorConfigReader,
} from "./published-visitor-config.js";
export {
  resolveVisitorConsentRule,
  VISITOR_CONSENT_HEADER,
  VISITOR_ID_PURPOSE,
  type VisitorConsentRule,
  visitorConsentGranted,
} from "./visitor-consent.js";
