// SPDX-License-Identifier: MPL-2.0

/**
 * Regression for GCP installs keeping media on the Cloud Run container's
 * in-memory filesystem: a cloud admin must refuse to start unless the media
 * root is a mounted, non-memory volume. Self-hosted stays unchecked.
 */

import { describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertDurableMediaRoot, type MediaRootProbe } from "./durable-root.js";

const ROOT = "/app/apps/admin/data/media";
const EXT4 = 0xef53;
const FUSE = 0x65735546;
const TMPFS = 0x01021994;

/** A container filesystem: `/` is device 1; `mounts` maps paths to [device, fsType]. */
function probe(mounts: Record<string, [number, number]>): MediaRootProbe {
  return {
    device: async (path) => {
      if (path === "/") return 1;
      const m = mounts[path];
      if (!m) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return m[0];
    },
    fsType: async (path) => mounts[path]?.[1] ?? EXT4,
  };
}

const gcp = { provider: "gcp-firebase", storageProvider: "local", rootDir: ROOT } as const;

describe("assertDurableMediaRoot", () => {
  it("refuses to boot a GCP admin whose media root is the container filesystem", async () => {
    await expect(
      assertDurableMediaRoot(
        { ...gcp, mediaStorageUrl: "gs://acme-caelo-production-media" },
        probe({ [ROOT]: [1, EXT4] }),
      ),
    ).rejects.toThrow(
      /not durable on this gcp-firebase install.*own filesystem.*cms-provision upgrade.*gs:\/\/acme-caelo-production-media.*Refusing to start/,
    );
  });

  it("refuses a media root that does not exist (nothing mounted)", async () => {
    await expect(assertDurableMediaRoot(gcp, probe({}))).rejects.toThrow(/does not exist/);
  });

  it("refuses an in-memory volume", async () => {
    await expect(assertDurableMediaRoot(gcp, probe({ [ROOT]: [7, TMPFS] }))).rejects.toThrow(
      /in-memory tmpfs/,
    );
  });

  it("boots with the media bucket mounted (Cloud Storage volume = fuse)", async () => {
    await assertDurableMediaRoot(gcp, probe({ [ROOT]: [42, FUSE] }));
  });

  it("checks AWS and Azure too, naming that their stacks mount nothing yet", async () => {
    for (const provider of ["aws", "azure"]) {
      await expect(
        assertDurableMediaRoot({ ...gcp, provider }, probe({ [ROOT]: [1, EXT4] })),
      ).rejects.toThrow(/does not mount persistent storage for media yet/);
    }
  });

  it("leaves self-hosted installs and non-local adapters alone", async () => {
    const containerFs = probe({ [ROOT]: [1, EXT4] });
    for (const provider of [undefined, "", "self-hosted"]) {
      await assertDurableMediaRoot({ ...gcp, provider }, containerFs);
    }
    await assertDurableMediaRoot({ ...gcp, storageProvider: "gcs" }, containerFs);
  });

  it("works against the real filesystem (default probe)", async () => {
    // A missing directory is never a mount, whatever the host.
    const missing = join(await mkdtemp(join(tmpdir(), "caelo-media-")), "absent");
    await expect(assertDurableMediaRoot({ ...gcp, rootDir: missing })).rejects.toThrow(
      /does not exist/,
    );
  });
});
