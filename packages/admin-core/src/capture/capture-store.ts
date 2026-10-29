// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1217 — the capture bucket, admin side. One private bucket per GCP
 * install (`<project>-caelo-<env>-capture`, lifecycle: deleted after a day):
 *
 *   in/<captureId>.json   written by the admin, read by the job ONLY through
 *                         a V4 signed URL (5 minutes) the admin hands it;
 *   out/<captureId>.json  created by the job (its identity may create objects
 *                         under `out/` and nothing else), read by the admin.
 *
 * The admin deletes both when the capture ends, so a signed input URL points
 * at nothing once its capture is over: one URL, one capture.
 *
 * Signing runs as the admin's own service account (IAM `signBlob`, granted by
 * capture-job-setup.ts as tokenCreator on itself — Cloud Run holds no key).
 * Media URLs in a preview are signed the same way, for the media bucket the
 * admin already reads, so the job never holds a read right anywhere.
 */

/** How long a signed URL the job gets stays valid. */
export const SIGNED_URL_TTL_MS = 5 * 60 * 1000;

/** The capture bucket and the media bucket, as the admin uses them. */
export interface CaptureStore {
  /** Write an input object (create only). */
  writeInput(key: string, text: string): Promise<void>;
  /** A V4 signed GET URL for an object of the capture bucket. */
  signInput(key: string): Promise<string>;
  /** A V4 signed GET URL for an object of the media bucket. */
  signMedia(storageKey: string): Promise<string>;
  /** The result object as text, or null while the job has not written it. */
  readResult(key: string): Promise<string | null>;
  /** Delete an object of the capture bucket; a missing one is fine. */
  remove(key: string): Promise<void>;
}

/** The env vars naming the two buckets on the admin. */
export const CAPTURE_BUCKET_ENV_VAR = "CAELO_CAPTURE_BUCKET";
export const MEDIA_BUCKET_ENV_VAR = "CAELO_MEDIA_BUCKET";

/**
 * The store of a GCP install.
 *
 * @param storage - test seam; a client with explicit credentials signs
 *   offline. Production uses the runtime's own identity.
 */
export function gcsCaptureStore(
  captureBucket: string,
  mediaBucket: string,
  storage?: import("@google-cloud/storage").Storage,
): CaptureStore {
  let client: Promise<import("@google-cloud/storage").Storage> | null = storage
    ? Promise.resolve(storage)
    : null;
  const open = () => {
    client ??= import("@google-cloud/storage").then(({ Storage }) => new Storage());
    return client;
  };
  const sign = async (bucket: string, key: string): Promise<string> => {
    const [url] = await (await open())
      .bucket(bucket)
      .file(key)
      .getSignedUrl({ version: "v4", action: "read", expires: Date.now() + SIGNED_URL_TTL_MS });
    return url;
  };
  return {
    async writeInput(key, text) {
      await (await open())
        .bucket(captureBucket)
        .file(key)
        .save(text, {
          contentType: "application/json",
          resumable: false,
          preconditionOpts: { ifGenerationMatch: 0 },
        });
    },
    signInput: (key) => sign(captureBucket, key),
    signMedia: (storageKey) => sign(mediaBucket, storageKey),
    async readResult(key) {
      try {
        const [bytes] = await (await open()).bucket(captureBucket).file(key).download();
        return bytes.toString("utf8");
      } catch (e) {
        if ((e as { code?: number }).code === 404) return null;
        throw e;
      }
    },
    async remove(key) {
      await (await open()).bucket(captureBucket).file(key).delete({ ignoreNotFound: true });
    },
  };
}
