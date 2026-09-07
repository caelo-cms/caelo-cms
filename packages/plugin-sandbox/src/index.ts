// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-sandbox — Phase 11 plugin safety surface.
 *
 * Three independent layers per CMS_REQUIREMENTS §14.5:
 *  1. validate.ts  — oxc-parser walk; rejects forbidden patterns.
 *  2. schema.ts    — schema-from-spec SQL emitter (FORCE RLS scoped to caelo.plugin_id).
 *  3. manifest.ts  — Ed25519 manifest signature verifier (Tier 1 only).
 *
 * The Deno subprocess and SDK broker live in @caelo-cms/plugin-host.
 */

export { externalArtifactDigest } from "./artifact.js";

export {
  bytesToHex,
  CAELO_TIER1_PUBLIC_KEY_HEX,
  canonicalManifestBytes,
  generateManifestKeyPair,
  signManifest,
  verifyManifestSignature,
} from "./manifest.js";

export {
  ADMIN_REF_ALLOWLIST,
  adminSchemaFromSpec,
  type EmittedSchema,
  schemaFromSpec,
} from "./schema.js";
export {
  type ValidationFailure,
  type ValidationFailureKind,
  type ValidationResult,
  validateManifest,
  validatePlugin,
  validateSource,
} from "./validate.js";
