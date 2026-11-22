// SPDX-License-Identifier: MPL-2.0

/**
 * Where the admin stores the visitor-AI key (#1654) — write only.
 *
 * The visitor AI runs in the public gateway, which counts as compromised
 * (#635), on a key of its own: never the admin's AI key, never in a
 * database. Each environment has its own secret, mounted into that
 * environment's gateway only:
 *
 *   - Google Cloud (`gcp`, `gcp-firebase`): Secret Manager
 *     `caelo-<env>-visitor-ai-key` (live gateway) and
 *     `caelo-<env>-visitor-ai-staging-key` (staging gateway). The admin's
 *     service account holds `secretVersionAdder` on both and nothing else:
 *     it adds a version, it can never read one (`CAELO_VISITOR_AI_KEY_STORE`,
 *     `CAELO_VISITOR_AI_STAGING_KEY_STORE` name them). Each gateway reads its
 *     file at `latest`, so a new version reaches it without a new revision.
 *   - Self-hosted and dev: a secret file per environment
 *     (`CAELO_VISITOR_AI_KEY_FILE`, `CAELO_VISITOR_AI_STAGING_KEY_FILE`),
 *     which the admin replaces atomically and no admin code reads; Compose
 *     mounts it read-only into that environment's gateway. On one machine
 *     the boundary is the Owner's: the admin process could open the file.
 *   - AWS and Azure: no store yet (#749, #750), refused with the reason.
 *
 * The payload is JSON `{"provider","apiKey"}`, or `{}` for "no key" (the
 * CLI creates every secret with `{}`: Cloud Run refuses a revision whose
 * secret volume has no version).
 */

import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { VisitorAiEnvironment, VisitorAiProvider } from "../ops/visitor_ai.js";
import { addSecretVersion } from "../security/google-sign-in/setup.js";
import { defaultGoogleDeps, type GoogleDeps } from "../security/operator-access/google-iam.js";

/** Env vars naming each environment's Secret Manager secret (Google Cloud). */
export const VISITOR_AI_KEY_STORE_ENV: Readonly<Record<VisitorAiEnvironment, string>> = {
  live: "CAELO_VISITOR_AI_KEY_STORE",
  staging: "CAELO_VISITOR_AI_STAGING_KEY_STORE",
};

/** Env vars naming each environment's key file (self-hosted, dev). */
export const VISITOR_AI_KEY_FILE_ENV: Readonly<Record<VisitorAiEnvironment, string>> = {
  live: "CAELO_VISITOR_AI_KEY_FILE",
  staging: "CAELO_VISITOR_AI_STAGING_KEY_FILE",
};

/** The secret's content: a key for a provider, or none. */
export type VisitorAiKeyPayload = {
  readonly provider: VisitorAiProvider;
  readonly apiKey: string;
} | null;

/** Serialises a payload the way the gateway parses it (`{}` = no key). */
export function visitorAiKeyFile(payload: VisitorAiKeyPayload): string {
  return JSON.stringify(
    payload === null ? {} : { provider: payload.provider, apiKey: payload.apiKey },
  );
}

/** A write-only store of one environment's key. */
export interface VisitorAiKeyStore {
  /** Where it writes, for messages (never a value). */
  readonly describe: string;
  write(payload: VisitorAiKeyPayload): Promise<void>;
}

/** Why no store is available, with what to do. */
export class VisitorAiKeyStoreUnavailable extends Error {
  override readonly name = "VisitorAiKeyStoreUnavailable";
}

/** The store of `environment` this admin runs with. */
export function visitorAiKeyStore(
  environment: VisitorAiEnvironment,
  env: Readonly<Record<string, string | undefined>> = process.env,
  deps: { google?: GoogleDeps } = {},
): VisitorAiKeyStore {
  const provider = env.CAELO_PROVIDER?.trim();
  if (provider === "aws" || provider === "azure") {
    throw new VisitorAiKeyStoreUnavailable(
      `visitor AI is not available on ${provider} yet: its gateway has no secret store for the visitor-AI key (${provider === "aws" ? "#749" : "#750"}). Google Cloud and self-hosted installs have one.`,
    );
  }
  const resource = env[VISITOR_AI_KEY_STORE_ENV[environment]]?.trim();
  if (resource) {
    if (!/^projects\/[^/]+\/secrets\/[^/]+$/.test(resource)) {
      throw new VisitorAiKeyStoreUnavailable(
        `${VISITOR_AI_KEY_STORE_ENV[environment]} is not a Secret Manager secret name (projects/<p>/secrets/<s>); run \`cms-provision upgrade\`, which sets it`,
      );
    }
    return {
      describe: `Secret Manager ${resource}`,
      async write(payload) {
        await addSecretVersion(
          deps.google ?? defaultGoogleDeps(),
          resource,
          visitorAiKeyFile(payload),
        );
      },
    };
  }
  const file = env[VISITOR_AI_KEY_FILE_ENV[environment]]?.trim();
  if (file) {
    return {
      describe: `the secret file ${file}`,
      async write(payload) {
        // Replaced atomically: the gateway never reads half a key.
        const tmp = join(dirname(file), `.visitor-ai-${randomBytes(6).toString("hex")}.tmp`);
        await writeFile(tmp, visitorAiKeyFile(payload), { mode: 0o640 });
        await rename(tmp, file);
      },
    };
  }
  throw new VisitorAiKeyStoreUnavailable(
    `this admin has no store for the ${environment} visitor-AI key: ${VISITOR_AI_KEY_STORE_ENV[environment]} (Google Cloud) and ${VISITOR_AI_KEY_FILE_ENV[environment]} (self-hosted) are unset. Run \`cms-provision upgrade\`, which sets it up.`,
  );
}
