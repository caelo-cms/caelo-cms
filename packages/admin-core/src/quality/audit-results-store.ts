// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #875 — the audit results store: a private bucket (or blob
 * container) the parallel audit tasks write their results into and the
 * admin reads them back from. It holds nothing but results: the task
 * identity may only create objects in it, the admin may only read them,
 * and a lifecycle rule deletes them after a day.
 *
 * A separate store, not a prefix of the staging bucket, so the task
 * identity never holds a write right anywhere a staged or live build
 * lives.
 */

/** Where results are written (task side) and read (admin side). */
export interface AuditResultStore {
  write(key: string, text: string): Promise<void>;
  /** The object as text, or null while it does not exist. */
  read(key: string): Promise<string | null>;
}

/** The environment variable naming the store on GCP installs. */
export const AUDIT_RESULTS_BUCKET_ENV_VAR = "CAELO_AUDIT_RESULTS_BUCKET";

/** The store of a GCP install: a GCS bucket. */
export function gcsAuditResultStore(bucketName: string): AuditResultStore {
  let bucket: Promise<import("@google-cloud/storage").Bucket> | null = null;
  const open = () => {
    bucket ??= import("@google-cloud/storage").then(({ Storage }) =>
      new Storage().bucket(bucketName),
    );
    return bucket;
  };
  return {
    async write(key, text) {
      // ifGenerationMatch 0: create only. The task identity may not
      // overwrite (roles/storage.objectCreator), and a key is written once.
      await (await open()).file(key).save(text, {
        contentType: "application/json",
        resumable: false,
        preconditionOpts: { ifGenerationMatch: 0 },
      });
    },
    async read(key) {
      try {
        const [bytes] = await (await open()).file(key).download();
        return bytes.toString("utf8");
      } catch (e) {
        if ((e as { code?: number }).code === 404) return null;
        throw e;
      }
    },
  };
}

/**
 * The install's results store, from the provider environment.
 *
 * @throws when the install has no store configured: a parallel audit
 *   without one cannot report, and that must fail loudly (no fallbacks
 *   pre-1.0).
 */
export function auditResultStoreFromEnv(env: NodeJS.ProcessEnv): AuditResultStore {
  const provider = env.CAELO_PROVIDER ?? "";
  if (provider === "gcp" || provider === "gcp-firebase") {
    const bucket = env[AUDIT_RESULTS_BUCKET_ENV_VAR];
    if (!bucket) {
      throw new Error(
        `${AUDIT_RESULTS_BUCKET_ENV_VAR} is not set — the ${provider} stack sets it on the admin and the audit job; run \`cms-provision upgrade\``,
      );
    }
    return gcsAuditResultStore(bucket);
  }
  throw new Error(`parallel audits have no results store on provider "${provider}"`);
}
