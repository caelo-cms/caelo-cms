// SPDX-License-Identifier: MPL-2.0

/**
 * #842 — which files a staged GCS run contains, and how to read one.
 *
 * Stage uploads only the files that differ from live into the staging
 * bucket's `<runId>/` prefix; unchanged files exist only in the live
 * static bucket. Everything that reads a staged run (Confirm-publish, the
 * admin's staging preview, the quality audit's staged origin,
 * `inspect_built_page`) therefore has to fall back to live, but ONLY
 * for files the build actually contains: a page the staged build deleted
 * is still in the live bucket until Confirm-publish prunes it, and
 * serving it would show the operator, the audit and the AI a page the
 * build no longer has. Stage records the build's full file list at
 * {@link buildFilesKey} for exactly this.
 */

import type { Bucket } from "@google-cloud/storage";

/** Where Stage stores a run's full file list in the staging bucket. */
export const buildFilesKey = (runId: string): string => `_build-files/${runId}.json`;

/** The object stored at {@link buildFilesKey}. */
export interface StagedBuildFiles {
  files: string[];
}

/**
 * Read a staged run's file list. Fails loudly when it is missing (a run
 * staged by an older release) or empty (every generator build has at
 * least `_redirects`, so empty means a corrupt object; for promote it
 * would delete the whole live site).
 */
export async function readStagedBuildFiles(
  stagingBucket: Bucket,
  runId: string,
): Promise<ReadonlySet<string>> {
  const file = stagingBucket.file(buildFilesKey(runId));
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error(
      `static-publisher-gcs: the file list of run ${runId} (gs://<staging>/${buildFilesKey(runId)}) is missing — the run was staged by an older release or the object was deleted. Run Stage again.`,
    );
  }
  const parsed = JSON.parse((await file.download())[0].toString("utf8")) as StagedBuildFiles;
  if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(
      `static-publisher-gcs: gs://<staging>/${buildFilesKey(runId)} is not a build file list. Run Stage again.`,
    );
  }
  return new Set(parsed.files);
}

/** One file of a staged run, with the bucket it was read from. */
export interface StagedObject {
  readonly body: Buffer;
  /** The Content-Type the publisher stored, when the object has one. */
  readonly contentType: string | undefined;
  readonly location: string;
  /** True when the file is unchanged from live and was read from there. */
  readonly fromLive: boolean;
}

/**
 * Read `key` (a build-relative site path) of staged run `runId`: from the
 * staging prefix, else from the live bucket when the build contains the
 * file unchanged. Null when the build does not contain `key`.
 */
export async function readStagedObject(args: {
  staging: Bucket;
  live: Bucket;
  runId: string;
  buildFiles: ReadonlySet<string>;
  key: string;
}): Promise<StagedObject | null> {
  if (!args.buildFiles.has(args.key)) return null;
  const candidates = [
    { file: args.staging.file(`${args.runId}/${args.key}`), fromLive: false },
    { file: args.live.file(args.key), fromLive: true },
  ];
  for (const { file, fromLive } of candidates) {
    const [exists] = await file.exists();
    if (!exists) continue;
    const [body] = await file.download();
    const [meta] = await file.getMetadata();
    return {
      body,
      contentType: typeof meta.contentType === "string" ? meta.contentType : undefined,
      location: `gs://${file.bucket.name}/${file.name}`,
      fromLive,
    };
  }
  // In the build but in neither bucket: the hash-skip assumed a live copy
  // that is gone (deleted out of band). Loud, not a silent 404.
  throw new Error(
    `staged run ${args.runId} contains ${args.key}, but it is neither in its staging prefix nor live (the live copy was removed after Stage). Run Stage again.`,
  );
}
