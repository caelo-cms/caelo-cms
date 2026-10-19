// SPDX-License-Identifier: MPL-2.0

/**
 * #696 Phase 0 — `platform_updates.status` against real Postgres (§6):
 *   - reads the release check's cache (version, notes, dates) and compares
 *     it with this build's CAELO_VERSION;
 *   - is open to the AI (it informs; installing is the Owner's, elsewhere);
 *   - "never checked" (the migration's epoch seed) reads as checkedAt=null;
 *   - the release's predicted route (#817) counts only for the running release;
 *   - `notifications.aggregate` points the release notice at the page.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { CAELO_VERSION, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { getCaeloVersionTool } from "../ai/tools/get-caelo-version.js";
import type { PlatformUpdateStatus } from "../ops/platform-updates.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "platform-updates-int-ai",
};
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "platform-updates-int",
};

/** Write the singleton the release-check worker owns; null = the migration's seed. */
async function setCache(
  row: {
    latest: string | null;
    url: string | null;
    notes: string | null;
    publishedAt: string | null;
    /** The release check's route prediction (#817) and the release it was decided against. */
    infraChange?: boolean | null;
    infraChangeFrom?: string | null;
  } | null,
): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (row === null) {
        await tx`
          UPDATE release_check_cache
             SET latest_version = NULL, release_url = NULL, release_notes = NULL,
                 published_at = NULL, latest_infra_change = NULL, infra_change_from = NULL,
                 fetched_at = '1970-01-01T00:00:00Z'
           WHERE id = 1`;
      } else {
        await tx`
          UPDATE release_check_cache
             SET latest_version = ${row.latest}, release_url = ${row.url},
                 release_notes = ${row.notes}, published_at = ${row.publishedAt},
                 latest_infra_change = ${row.infraChange ?? null},
                 infra_change_from = ${row.infraChangeFrom ?? null},
                 fetched_at = '2026-10-13T10:00:00Z'
           WHERE id = 1`;
      }
    });
  } finally {
    await sql.end();
  }
}

async function status(ctx: ExecutionContext): Promise<PlatformUpdateStatus> {
  const r = await execute(registry, adapter, ctx, "platform_updates.status", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as PlatformUpdateStatus;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});
beforeEach(() => setCache(null));
afterAll(async () => {
  await setCache(null);
  await adapter.close();
});

describe("platform_updates.status", () => {
  it("reports a newer release with its notes, readable by the AI", async () => {
    await setCache({
      latest: "99.0.0",
      url: "https://github.com/caelo-cms/caelo-cms/releases/tag/v99.0.0",
      notes: "## Highlights\n\nFaster everything.",
      publishedAt: "2026-10-12T09:00:00Z",
    });
    expect(await status(AI)).toEqual({
      installedVersion: CAELO_VERSION,
      latestVersion: "99.0.0",
      upgradeAvailable: true,
      releaseUrl: "https://github.com/caelo-cms/caelo-cms/releases/tag/v99.0.0",
      releaseNotes: "## Highlights\n\nFaster everything.",
      publishedAt: "2026-10-12T09:00:00Z",
      checkedAt: "2026-10-13T10:00:00Z",
      infraChange: null,
      updatesPath: "/settings/updates",
    });
  });

  it("predicts the Cloud Shell route only when decided against the running release (#817)", async () => {
    const release = { latest: "99.0.0", url: null, notes: null, publishedAt: null };
    await setCache({ ...release, infraChange: true, infraChangeFrom: CAELO_VERSION });
    expect((await status(SYSTEM)).infraChange).toBe(true);
    await setCache({ ...release, infraChange: false, infraChangeFrom: CAELO_VERSION });
    expect((await status(SYSTEM)).infraChange).toBe(false);
    // Decided before this install was upgraded: not known for what runs now.
    await setCache({ ...release, infraChange: true, infraChangeFrom: "0.0.1" });
    expect((await status(SYSTEM)).infraChange).toBeNull();
  });

  it("is up to date when the newest release is this build", async () => {
    await setCache({ latest: CAELO_VERSION, url: null, notes: null, publishedAt: null });
    const s = await status(SYSTEM);
    expect(s.upgradeAvailable).toBe(false);
    expect(s.latestVersion).toBe(CAELO_VERSION);
  });

  it("reads the migration's epoch seed as 'never checked'", async () => {
    const s = await status(SYSTEM);
    expect(s.latestVersion).toBeNull();
    expect(s.checkedAt).toBeNull();
    expect(s.upgradeAvailable).toBe(false);
  });

  it("notifications.aggregate sends the release notice to Settings → Updates", async () => {
    await setCache({ latest: "99.0.0", url: null, notes: null, publishedAt: null });
    const r = await execute(registry, adapter, SYSTEM, "notifications.aggregate", {});
    expect(r.ok).toBe(true);
    const v = (r as { value: { upgradeAvailable: boolean; updatesPath: string } }).value;
    expect(v.upgradeAvailable).toBe(true);
    expect(v.updatesPath).toBe("/settings/updates");
  });

  it("get_caelo_version tells the AI to send the operator to the page", async () => {
    await setCache({ latest: "99.0.0", url: null, notes: "long notes", publishedAt: null });
    const r = await getCaeloVersionTool.handler(AI, {}, { adapter, registry } as ToolContext);
    expect(r.ok).toBe(true);
    expect(r.content).toContain("Newest release: 99.0.0");
    expect(r.content).toContain("/settings/updates");
    // The notes stay out of the transcript (includeValue: false).
    expect("value" in r).toBe(false);
  });
});
