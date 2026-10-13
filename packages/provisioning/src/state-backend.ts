// SPDX-License-Identifier: MPL-2.0

/**
 * Where an install's Pulumi state and install metadata live (#696, D2).
 *
 * Two kinds:
 *
 *   - `local` — the original layout: Pulumi's DIY backend at
 *     `file://~/.caelo-<id>/state`, secrets encrypted with the passphrase in
 *     `~/.caelo-<id>/secrets/pulumi-passphrase`. Only the machine that
 *     installed can upgrade or re-run the install. Self-hosted always stays
 *     here: its state is on the host, next to the install.
 *   - `gcs` — the install's own GCP project holds everything: a versioned,
 *     uniform-access, public-access-prevented bucket `<project>-caelo-ops`
 *     (`pulumi/` for Pulumi's DIY backend, `install/` for install.json and
 *     progress.json) and a Cloud KMS key `caelo/pulumi-state` as Pulumi's
 *     secrets provider. No passphrase exists. Any machine (laptop, Cloud
 *     Shell, an in-cloud job) the operator is signed in on can run the
 *     install's lifecycle commands after `cms-provision attach`.
 *
 * install.json records the kind in `stateBackend`; an install without the
 * field predates #696 and is `local`. Every Pulumi call resolves its backend
 * URL, secrets provider and environment through {@link resolveBackend} — no
 * other code builds a `file://` URL or reads the passphrase.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Name of the Cloud KMS key ring holding Caelo's keys in the install project. */
export const OPS_KEY_RING = "caelo";
/** Name of the Cloud KMS key Pulumi encrypts the stack's secrets with. */
export const OPS_STATE_KEY = "pulumi-state";
/** Prefix inside the ops bucket that Pulumi's DIY backend uses. */
export const OPS_PULUMI_PREFIX = "pulumi";
/** Prefix inside the ops bucket that holds install.json + progress.json. */
export const OPS_INSTALL_PREFIX = "install";

/** What install.json records about the install's state backend. */
export type StateBackendRecord =
  | { readonly kind: "local" }
  | {
      readonly kind: "gcs";
      /** The ops bucket, without `gs://`. */
      readonly bucket: string;
      /** Full resource name of the KMS key (`projects/…/cryptoKeys/pulumi-state`). */
      readonly kmsKey: string;
    };

/** The ops-bucket variant of {@link StateBackendRecord}. */
export type GcsBackendRecord = Extract<StateBackendRecord, { kind: "gcs" }>;

/** The backend a Pulumi command runs against, ready to pass to the CLI. */
export interface ResolvedBackend {
  readonly kind: StateBackendRecord["kind"];
  /** `PULUMI_BACKEND_URL`. */
  readonly url: string;
  /** What `pulumi stack init/migrate --secrets-provider` takes. */
  readonly secretsProvider: string;
  /** The environment Pulumi needs for this backend (and nothing else). */
  readonly envVars: Readonly<Record<string, string>>;
}

/** `<project>-caelo-ops` — the install's ops bucket (project ids are globally unique). */
export function opsBucketName(projectId: string): string {
  return `${projectId}-caelo-ops`;
}

/** Full resource name of the install's Pulumi state key. */
export function opsKmsKeyName(projectId: string, region: string): string {
  return `projects/${projectId}/locations/${region}/keyRings/${OPS_KEY_RING}/cryptoKeys/${OPS_STATE_KEY}`;
}

/** The `gcs` record for an install in `projectId`, its ops resources in `region`. */
export function gcsBackendRecord(projectId: string, region: string): GcsBackendRecord {
  return {
    kind: "gcs",
    bucket: opsBucketName(projectId),
    kmsKey: opsKmsKeyName(projectId, region),
  };
}

/** The install's recorded backend; installs that predate #696 are `local`. */
export function installBackend(meta: { readonly stateBackend?: StateBackendRecord }) {
  return meta.stateBackend ?? ({ kind: "local" } as const);
}

const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const KMS_KEY =
  /^projects\/[a-z][a-z0-9.:-]{0,61}[a-z0-9]\/locations\/[a-z0-9-]+\/keyRings\/[A-Za-z0-9_-]+\/cryptoKeys\/[A-Za-z0-9_-]+$/;

/**
 * Validate a `stateBackend` value read from install.json (on disk or in the
 * bucket). A malformed record would point Pulumi at the wrong place, so it
 * throws instead of guessing.
 */
export function parseStateBackend(value: unknown): StateBackendRecord | undefined {
  if (value === undefined) return undefined;
  const v = value as Record<string, unknown> | null;
  if (v && v.kind === "local") return { kind: "local" };
  if (
    v &&
    v.kind === "gcs" &&
    typeof v.bucket === "string" &&
    BUCKET.test(v.bucket) &&
    typeof v.kmsKey === "string" &&
    KMS_KEY.test(v.kmsKey)
  ) {
    return { kind: "gcs", bucket: v.bucket, kmsKey: v.kmsKey };
  }
  throw new Error(
    `install.json stateBackend is malformed (${JSON.stringify(value)}). Expected {"kind":"local"} or {"kind":"gcs","bucket":"<project>-caelo-ops","kmsKey":"projects/…/cryptoKeys/${OPS_STATE_KEY}"}.`,
  );
}

/** Where a `local` install keeps Pulumi's state. */
export function localStateDir(installRoot: string): string {
  return join(installRoot, "state");
}

/**
 * Resolve the backend URL, secrets provider and environment for an install.
 *
 * `local` needs the passphrase and fails loudly without it — Pulumi would
 * otherwise prompt for it on a terminal nobody sees. `gcs` needs no secret:
 * Pulumi reaches the bucket and the KMS key with the operator's Application
 * Default Credentials. Both set `PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER`:
 * Pulumi then takes the secrets provider (KMS key or passphrase salt) from
 * the install's own state when the stack's config file in the package's
 * stack dir names none (wizards/gcp-pulumi.ts alignedStackSettings).
 *
 * @param meta the install (its `stateBackend`, absent = local)
 * @param opts.installRoot `~/.caelo-<id>`
 * @param opts.readPassphrase reads `secrets/pulumi-passphrase`; called for local only
 */
export function resolveBackend(
  meta: { readonly installId: string; readonly stateBackend?: StateBackendRecord },
  opts: { readonly installRoot: string; readonly readPassphrase: () => string | null },
): ResolvedBackend {
  const record = installBackend(meta);
  if (record.kind === "gcs") {
    const url = `gs://${record.bucket}/${OPS_PULUMI_PREFIX}`;
    return {
      kind: "gcs",
      url,
      secretsProvider: `gcpkms://${record.kmsKey}`,
      envVars: {
        PULUMI_BACKEND_URL: url,
        PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER: "true",
      },
    };
  }
  const passphrase = opts.readPassphrase();
  if (!passphrase) {
    throw new Error(
      `~/.caelo-${meta.installId}/secrets/pulumi-passphrase is missing, so the install's local Pulumi state can't be decrypted. Restore it from your backup of ~/.caelo-${meta.installId}/.`,
    );
  }
  const url = `file://${localStateDir(opts.installRoot)}`;
  return {
    kind: "local",
    url,
    secretsProvider: "passphrase",
    envVars: {
      PULUMI_BACKEND_URL: url,
      PULUMI_CONFIG_PASSPHRASE: passphrase,
      PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER: "true",
    },
  };
}

/**
 * The shell prefix that points a manual `pulumi …` command at the install's
 * backend, for recovery instructions the CLI prints. Never contains the
 * passphrase itself: a local install reads it from its file at run time.
 */
export function backendShellEnv(
  meta: { readonly stateBackend?: StateBackendRecord },
  installRoot: string,
): string {
  const record = installBackend(meta);
  if (record.kind === "gcs") {
    return `PULUMI_BACKEND_URL=gs://${record.bucket}/${OPS_PULUMI_PREFIX} PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER=true`;
  }
  return `PULUMI_BACKEND_URL=file://${localStateDir(installRoot)} PULUMI_CONFIG_PASSPHRASE="$(cat ${join(installRoot, "secrets", "pulumi-passphrase")})" PULUMI_FALLBACK_TO_STATE_SECRETS_MANAGER=true`;
}

/** Human-readable location of the install's state, for status and progress output. */
export function describeBackend(
  meta: { readonly stateBackend?: StateBackendRecord },
  installRoot: string,
): string {
  const record = installBackend(meta);
  return record.kind === "gcs"
    ? `gs://${record.bucket} (secrets: Cloud KMS ${record.kmsKey.split("/").slice(-3).join("/")})`
    : `${localStateDir(installRoot)} on this machine (secrets: passphrase file)`;
}

/**
 * Whether a local Pulumi backend dir holds any stack (Pulumi's DIY layout
 * keeps them under `.pulumi/stacks/`).
 */
export function hasLocalPulumiState(installRoot: string): boolean {
  const stacks = join(localStateDir(installRoot), ".pulumi", "stacks");
  if (!existsSync(stacks)) return false;
  // An unreadable dir throws: guessing "no state" would move a deployed
  // install onto an empty backend.
  return readdirSync(stacks).length > 0;
}

/**
 * Which backend the GCP wizard runs an install on (#696). A recorded
 * backend wins. An install without one whose state already sits on this
 * machine stays local — moving state needs a preflight, a backup and a
 * verification, never a side effect of a re-run.
 * Everything else (a new GCP install) gets the ops bucket. Self-hosted, AWS
 * and Azure stay local until their adapters have an equivalent.
 */
export function chooseInstallBackend(
  meta: {
    readonly installId?: string;
    readonly provider: string;
    readonly stateBackend?: StateBackendRecord;
  },
  localStateExists: boolean,
  deployed = false,
): StateBackendRecord["kind"] {
  if (meta.stateBackend) return meta.stateBackend.kind;
  if (meta.provider !== "gcp" && meta.provider !== "gcp-firebase") return "local";
  if (localStateExists) return "local";
  if (deployed) {
    // Deployed, yet no state anywhere: a fresh backend would make Pulumi
    // recreate (and collide with) every resource.
    throw new Error(
      `Install ${meta.installId ?? ""} was deployed, but its Pulumi state is neither recorded in install.json nor in ~/.caelo-${meta.installId ?? "<install-id>"}/state. Restore that directory from your backup and re-run.`,
    );
  }
  return "gcs";
}
