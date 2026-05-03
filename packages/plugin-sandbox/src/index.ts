// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sandbox — Phase 11 plugin safety surface.
 *
 * Three independent layers per CMS_REQUIREMENTS §14.5:
 *  1. validate.ts  — oxc-parser walk; rejects forbidden patterns.
 *  2. schema.ts    — schema-from-spec SQL emitter (FORCE RLS scoped to caelo.plugin_id).
 *  3. manifest.ts  — Ed25519 manifest signature verifier (Tier 1 only).
 *
 * The Deno subprocess wrapper for Tier 2 invocation lives in sandbox.ts
 * (lands when the API Gateway P13 plumbing connects public requests to
 * plugin operations; for P11 the lifecycle ops + validator + schema
 * emitter are enough to round-trip a hello-world Tier 2 plugin
 * end-to-end without spawning Deno).
 */

export {
  bytesToHex,
  CAELO_TIER1_PUBLIC_KEY_HEX,
  canonicalManifestBytes,
  generateManifestKeyPair,
  signManifest,
  verifyManifestSignature,
} from "./manifest.js";

export { type EmittedSchema, schemaFromSpec } from "./schema.js";
export {
  type ValidationFailure,
  type ValidationFailureKind,
  type ValidationResult,
  validateManifest,
  validatePlugin,
  validateSource,
} from "./validate.js";
