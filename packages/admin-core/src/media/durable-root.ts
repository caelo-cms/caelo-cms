// SPDX-License-Identifier: MPL-2.0

/**
 * Boot check: on a cloud install, media must not land on the container's
 * own filesystem.
 *
 * Cloud containers (Cloud Run, Fargate, Container Apps) have an ephemeral,
 * per-instance filesystem: a file written there is gone on the next revision
 * or scale-to-zero, and other instances never see it. With the local media
 * adapter that is silent data loss — uploads succeed, the editor shows them,
 * and the next Stage fails with "storage object missing". So the admin
 * refuses to start (CLAUDE.md §2, no silent fallbacks) unless the media root
 * is a mounted volume that is not in memory: on GCP the media bucket as a
 * Cloud Storage volume (stack-contract.ts `adminMediaVolume`).
 *
 * "Mounted" is decided by the device: the media root on the same device as
 * `/` is the container filesystem. An in-memory volume (tmpfs/ramfs) is a
 * mount but just as ephemeral, so its filesystem type is refused too.
 * Self-hosted installs (compose, a host bind mount) are not checked.
 */

import { stat, statfs } from "node:fs/promises";

/** `CAELO_PROVIDER` values whose containers have ephemeral filesystems. */
const CLOUD_PROVIDERS: ReadonlySet<string> = new Set(["gcp", "gcp-firebase", "aws", "azure"]);

/** statfs(2) `f_type` of in-memory filesystems (linux/magic.h). */
const IN_MEMORY_FS_TYPES: ReadonlyMap<number, string> = new Map([
  [0x01021994, "tmpfs"],
  [0x858458f6, "ramfs"],
]);

/** The filesystem facts the check needs; injectable for tests. */
export interface MediaRootProbe {
  /** `st_dev` of `path`; throws when it does not exist. */
  device(path: string): Promise<number | bigint>;
  /** statfs(2) `f_type` of the filesystem holding `path`. */
  fsType(path: string): Promise<number>;
}

const nodeProbe: MediaRootProbe = {
  device: async (path) => (await stat(path)).dev,
  fsType: async (path) => (await statfs(path)).type,
};

/** What the admin's media storage is configured as. */
export interface MediaStorageSetup {
  /** `CAELO_PROVIDER` (unset = self-hosted). */
  readonly provider: string | undefined;
  /** `MEDIA_STORAGE_PROVIDER` — `local` is the filesystem adapter. */
  readonly storageProvider: string;
  /** Absolute media root of the local adapter. */
  readonly rootDir: string;
  /** `MEDIA_STORAGE_URL` the stack set, named in the error. */
  readonly mediaStorageUrl?: string;
}

/**
 * Throw when a cloud install would keep media on ephemeral local disk.
 * No-op for self-hosted installs and for a non-local storage adapter.
 *
 * @example
 *   await assertDurableMediaRoot({ provider: "gcp", storageProvider: "local",
 *     rootDir: "/app/apps/admin/data/media" });
 *   // throws unless a persistent volume is mounted at (or above) that path
 */
export async function assertDurableMediaRoot(
  setup: MediaStorageSetup,
  probe: MediaRootProbe = nodeProbe,
): Promise<void> {
  if (!setup.provider || !CLOUD_PROVIDERS.has(setup.provider)) return;
  if (setup.storageProvider !== "local") return;

  const problem = await ephemeralReason(setup.rootDir, probe);
  if (!problem) return;
  const bucket = setup.mediaStorageUrl ? ` (${setup.mediaStorageUrl})` : "";
  const fix =
    setup.provider === "gcp" || setup.provider === "gcp-firebase"
      ? `Run \`cms-provision upgrade\`: it mounts the install's media bucket${bucket} at ${setup.rootDir} as a Cloud Storage volume.`
      : `This provider's stack does not mount persistent storage for media yet (github.com/caelo-cms/caelo-cms/issues/618); mount a persistent volume at MEDIA_ROOT_DIR (${setup.rootDir}) or configure an object-storage adapter (MEDIA_STORAGE_PROVIDER).`;
  throw new Error(
    `media storage is not durable on this ${setup.provider} install: ${problem}. ` +
      "Every upload would be lost on the next revision or scale-to-zero, and each instance would see different files. " +
      `${fix} Refusing to start.`,
  );
}

async function ephemeralReason(rootDir: string, probe: MediaRootProbe): Promise<string | null> {
  let rootDevice: number | bigint;
  try {
    rootDevice = await probe.device(rootDir);
  } catch {
    return `the media root ${rootDir} does not exist, so no volume is mounted there`;
  }
  if (rootDevice === (await probe.device("/"))) {
    return `the media root ${rootDir} is on the container's own filesystem (no volume is mounted there)`;
  }
  const inMemory = IN_MEMORY_FS_TYPES.get(await probe.fsType(rootDir));
  if (inMemory) {
    return `the media root ${rootDir} is an in-memory ${inMemory} volume`;
  }
  return null;
}
