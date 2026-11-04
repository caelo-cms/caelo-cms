// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1330 — the staged site's full mirror in the private staging bucket
 * (decision 2026-11-04, D1), which the staging gateway serves behind the
 * gate and nothing else reads for visitors.
 *
 * The bucket holds two slots, `_slots/a` and `_slots/b`, each a complete
 * build with its manifest next to it (@caelo-cms/shared staged-site.ts). A
 * Stage syncs the slot staging does NOT serve, rsync-style: it compares
 * every file's hash with the slot's manifest, writes only what changed,
 * deletes what the build no longer has, and writes the new manifest last.
 * The Stage then points the projection at that slot in the transaction that
 * records the run (deploy.finish_trigger), so visitors of staging never see
 * a half-synced build. The slot is one Stage behind the served one, so its
 * diff is the diff of two Stages: usually a handful of files.
 *
 * A sync deletes the slot's manifest before it writes anything: should it
 * stop halfway, the next sync finds no manifest and writes every file
 * again, instead of trusting a manifest that no longer describes the slot.
 * The first Stage after the update fills a slot completely the same way: on
 * gcp by server-side copies from the live bucket (no byte passes the
 * admin), on gcp-firebase (Hosting files cannot be read back) by uploading
 * each file once.
 */

import {
  nextStagingSlot,
  runBatched,
  type StagedFileEntry,
  type StagedManifest,
  stagedFileKey,
  stagedManifestKey,
  stagedManifestSchema,
  stagingSlotLocation,
} from "@caelo-cms/shared";
import type { Bucket, File } from "@google-cloud/storage";

const PARALLEL_DELETES = 100;
/** Slot writes in flight at once. */
const PARALLEL_WRITES = 50;

/** What one slot sync did. */
export interface SlotSyncSummary {
  /** The slot it filled (`_slots/a`), to be recorded as served. */
  readonly location: string;
  readonly written: number;
  readonly unchanged: number;
  readonly deleted: number;
}

/** The env var naming the private staging bucket on the admin (gcp, gcp-firebase). */
export const STAGING_BUCKET_ENV = "CAELO_STAGING_BUCKET";

/** A slot of a GCS staging bucket being synced to one build. */
export class GcsSlotSync {
  readonly #bucket: Bucket;
  readonly #location: string;
  readonly #previous: StagedManifest | null;
  readonly #files = new Map<string, StagedFileEntry>();
  readonly #inflight = new Set<Promise<void>>();
  #failure: Error | null = null;
  #written = 0;
  #unchanged = 0;
  #state: "open" | "finished" = "open";

  private constructor(bucket: Bucket, location: string, previous: StagedManifest | null) {
    this.#bucket = bucket;
    this.#location = location;
    this.#previous = previous;
  }

  /**
   * Start syncing the slot `servedLocation` does not name: read its
   * manifest as the base of the diff, then delete it (see the module
   * comment).
   */
  static async open(bucket: Bucket, servedLocation: string | null): Promise<GcsSlotSync> {
    const location = stagingSlotLocation(nextStagingSlot(servedLocation));
    const manifestFile = bucket.file(stagedManifestKey(location));
    let previous: StagedManifest | null = null;
    const [exists] = await manifestFile.exists();
    if (exists) {
      const parsed = stagedManifestSchema.safeParse(
        JSON.parse((await manifestFile.download())[0].toString("utf8")),
      );
      // A manifest this release cannot read is no base: everything is written.
      previous = parsed.success ? parsed.data : null;
      await manifestFile.delete({ ignoreNotFound: true });
    }
    return new GcsSlotSync(bucket, location, previous);
  }

  /** The slot being filled. */
  get location(): string {
    return this.#location;
  }

  /** Whether `path` with `hash` must be written (the slot holds something else, or nothing). */
  needs(path: string, hash: string): boolean {
    return this.#previous?.files[path]?.hash !== hash;
  }

  /**
   * Take `path`: write it with `write` when the slot holds other bytes,
   * otherwise only record it. `write` gets the object to write. Writes run
   * {@link PARALLEL_WRITES} at a time: this resolves once the write is
   * queued, and waits only while that many are running, so a caller that
   * streams a whole build (the first Stage after the update) is never held
   * to one upload at a time. A failed write fails {@link finish}.
   */
  async take(
    path: string,
    entry: StagedFileEntry,
    write: (destination: File) => Promise<void>,
  ): Promise<void> {
    if (this.#state !== "open") throw new Error("slot sync is finished");
    if (this.#files.has(path)) throw new Error(`staging slot: ${path} was taken twice`);
    this.#files.set(path, entry);
    if (!this.needs(path, entry.hash)) {
      this.#unchanged += 1;
      return;
    }
    while (this.#inflight.size >= PARALLEL_WRITES) await Promise.race(this.#inflight);
    if (this.#failure) throw this.#failure;
    const running: Promise<void> = write(this.#bucket.file(stagedFileKey(this.#location, path)))
      .then(
        () => {
          this.#written += 1;
        },
        (e: unknown) => {
          this.#failure ??= e instanceof Error ? e : new Error(String(e));
        },
      )
      .finally(() => this.#inflight.delete(running));
    this.#inflight.add(running);
  }

  /**
   * Delete what the build no longer has, then write the manifest that makes
   * the slot complete. Only after this may the slot be served.
   */
  async finish(args: {
    runId: string;
    pageUrlStyle: "directory" | "no-extension";
  }): Promise<SlotSyncSummary> {
    if (this.#state !== "open") throw new Error("slot sync is finished");
    this.#state = "finished";
    await Promise.all(this.#inflight);
    if (this.#failure) {
      throw new Error(
        `the staging slot ${this.#location} could not be written (${this.#failure.message}); staging keeps serving the previous build. Stage again.`,
      );
    }
    // Every object under the slot that the new build does not list: the
    // previous manifest's leftovers and whatever a stopped sync wrote.
    const prefix = `${this.#location}/`;
    const [objects] = await this.#bucket.getFiles({ prefix });
    const stale = objects.filter((o) => !this.#files.has(o.name.slice(prefix.length)));
    await runBatched(stale, PARALLEL_DELETES, async (o) => {
      await o.delete({ ignoreNotFound: true });
    });
    const manifest: StagedManifest = {
      version: 1,
      runId: args.runId,
      pageUrlStyle: args.pageUrlStyle,
      files: Object.fromEntries([...this.#files].sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    await this.#bucket.file(stagedManifestKey(this.#location)).save(JSON.stringify(manifest), {
      contentType: "application/json",
      metadata: { cacheControl: "no-store" },
    });
    return {
      location: this.#location,
      written: this.#written,
      unchanged: this.#unchanged,
      deleted: stale.length,
    };
  }
}

let bucketForTests: Bucket | null = null;

/** Test seam — the bucket {@link stagingBucket} returns; null restores the real one. */
export function setStagingBucketForTests(bucket: Bucket | null): void {
  bucketForTests = bucket;
}

/** The private staging bucket the admin's env names. */
export async function stagingBucket(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Bucket> {
  if (bucketForTests) return bucketForTests;
  const name = env[STAGING_BUCKET_ENV];
  if (!name) {
    throw new Error(
      `${STAGING_BUCKET_ENV} is not set on the admin service — the staged site is mirrored into the private staging bucket for the staging gateway (#1330). Next step: run \`cms-provision upgrade\` (it creates the bucket and sets the variable), then Stage again.`,
    );
  }
  const { Storage } = await import("@google-cloud/storage");
  return new Storage().bucket(name);
}
