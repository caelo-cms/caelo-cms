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
import { z } from "zod";

/** Where Stage stores a run's full file list in the staging bucket. */
export const buildFilesKey = (runId: string): string => `_build-files/${runId}.json`;

/**
 * Shape of the object at {@link buildFilesKey}. Never empty: every generator
 * build has at least `_redirects`, so an empty list means a corrupt object
 * (for promote it would delete the whole live site).
 */
const stagedBuildFilesSchema = z.object({ files: z.array(z.string().min(1)).min(1) });

/** The object Stage writes at {@link buildFilesKey}. */
export type StagedBuildFiles = z.infer<typeof stagedBuildFilesSchema>;

/**
 * A staged run cannot be read as the build it claims to be: its file list
 * is missing or corrupt, or a file of the build is in neither bucket. The
 * fix is always the same (Run Stage again), so callers map it to a
 * conflict, not a server fault. Bucket I/O failures stay plain errors.
 */
export class StagedRunError extends Error {
  override readonly name = "StagedRunError";
}

/**
 * Read a staged run's file list. Throws {@link StagedRunError} when it is
 * missing (a run staged by an older release), not JSON, or not a non-empty
 * list of paths.
 */
export async function readStagedBuildFiles(
  stagingBucket: Bucket,
  runId: string,
): Promise<ReadonlySet<string>> {
  const file = stagingBucket.file(buildFilesKey(runId));
  const location = `gs://<staging>/${buildFilesKey(runId)}`;
  const [exists] = await file.exists();
  if (!exists) {
    throw new StagedRunError(
      `static-publisher-gcs: the file list of run ${runId} (${location}) is missing — the run was staged by an older release or the object was deleted. Run Stage again.`,
    );
  }
  const raw = (await file.download())[0].toString("utf8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new StagedRunError(
      `static-publisher-gcs: ${location} is not valid JSON (${e instanceof Error ? e.message : String(e)}) — the object is corrupt. Run Stage again.`,
    );
  }
  const parsed = stagedBuildFilesSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new StagedRunError(
      `static-publisher-gcs: ${location} is not a build file list (${issues}). Run Stage again.`,
    );
  }
  return new Set(parsed.data.files);
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
  throw new StagedRunError(
    `staged run ${args.runId} contains ${args.key}, but it is neither in its staging prefix nor live (the live copy was removed after Stage). Run Stage again.`,
  );
}
