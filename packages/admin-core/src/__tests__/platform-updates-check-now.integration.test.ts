// SPDX-License-Identifier: MPL-2.0

/**
 * "Check now" on Settings → Updates against real Postgres (§6). GitHub is
 * replaced at the fetcher boundary only (`fetchImpl`); everything from the
 * status read to the cache write and the audit row runs for real.
 *
 *   - a check that reaches GitHub stores the release and audits it;
 *   - a failed check (GitHub rate limit) clears the release, stamps the time
 *     and comes back with the reason — the page then says "Last check failed";
 *   - within a minute of the last check the click is refused BEFORE any
 *     request goes to GitHub, and the op itself refuses a write that slipped
 *     past (a second click racing the first);
 *   - humans only: the AI is rejected by scope; a human without settings.read
 *     is refused (and audited).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { PlatformUpdateStatus } from "../ops/platform-updates.js";
import { checkReleasesNow, type ReleaseFetch } from "../platform-updates/release-check.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const P = `check-now-${Date.now()}`;
const READER_EMAIL = `${P}-reader@example.com`;
const NOBODY_EMAIL = `${P}-nobody@example.com`;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-system`,
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: `${P}-ai`,
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let reader: ExecutionContext;
let nobody: ExecutionContext;

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const db = new SQL(ADMIN_URL as string);
  try {
    let result!: T;
    await db.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await db.end();
  }
}

/** Put the last check `minutesAgo` back (null = never checked, the migration's seed). */
async function lastCheck(minutesAgo: number | null, latest: string | null = null): Promise<void> {
  await admin(
    (tx) => tx`
      UPDATE release_check_cache
         SET latest_version = ${latest}, release_url = NULL, release_notes = NULL,
             published_at = NULL,
             fetched_at = ${
               minutesAgo === null
                 ? new Date(0).toISOString()
                 : new Date(Date.now() - minutesAgo * 60_000).toISOString()
             }::timestamptz
       WHERE id = 1`,
  );
}

async function status(): Promise<PlatformUpdateStatus> {
  const r = await execute(registry, adapter, SYSTEM, "platform_updates.status", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value as PlatformUpdateStatus;
}

async function audits(actorId: string): Promise<{ succeeded: boolean; summary: string }[]> {
  return admin(
    (tx) => tx`
      SELECT succeeded, result_summary AS summary FROM audit_events
       WHERE actor_id = ${actorId}::uuid AND operation = 'platform_updates.check_now'
       ORDER BY created_at`,
  );
}

async function createUser(email: string, roleNames: string[]): Promise<ExecutionContext> {
  const r = await execute(registry, adapter, SYSTEM, "users.create", {
    email,
    password: "harbor-lantern-quill-71",
    displayName: email.split("@")[0],
    roleNames,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  const { userId } = r.value as { userId: string };
  return { actorId: userId, actorKind: "human", requestId: `${P}-${email}` };
}

/** A GitHub stand-in that counts its calls. */
function github(respond: () => Response): { fetchImpl: ReleaseFetch; calls: () => number } {
  let n = 0;
  return {
    fetchImpl: async () => {
      n += 1;
      return respond();
    },
    calls: () => n,
  };
}

const RELEASE = () =>
  Response.json({
    tag_name: "v99.1.0",
    html_url: "https://github.com/caelo-cms/caelo-cms/releases/tag/v99.1.0",
    body: "## Highlights\n\nChecked on demand.",
    published_at: "2026-10-14T08:00:00Z",
  });

async function wipeUsers(): Promise<void> {
  await admin(async (tx) => {
    for (const email of [READER_EMAIL, NOBODY_EMAIL]) {
      await tx`DELETE FROM user_roles WHERE user_id IN (SELECT id FROM users WHERE email = ${email})`;
      await tx`DELETE FROM users WHERE email = ${email}`;
    }
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await wipeUsers();
  // The Reviewer role holds settings.read (it may open Settings → Updates).
  reader = await createUser(READER_EMAIL, ["reviewer"]);
  nobody = await createUser(NOBODY_EMAIL, []);
});
beforeEach(() => lastCheck(null));
afterAll(async () => {
  await lastCheck(null);
  await wipeUsers();
  await adapter.close();
});

describe("checkReleasesNow + platform_updates.check_now", () => {
  it("stores the release GitHub names and audits the check", async () => {
    await lastCheck(40, "0.0.1");
    const gh = github(RELEASE);
    const r = await checkReleasesNow({ registry, adapter, ctx: reader, fetchImpl: gh.fetchImpl });
    expect(r).toEqual({ ok: true, latestVersion: "99.1.0" });
    expect(gh.calls()).toBe(1);

    const s = await status();
    expect(s.latestVersion).toBe("99.1.0");
    expect(s.upgradeAvailable).toBe(true);
    expect(s.releaseNotes).toContain("Checked on demand.");
    expect(s.publishedAt).toBe("2026-10-14T08:00:00Z");
    expect(Date.now() - Date.parse(s.checkedAt ?? "")).toBeLessThan(60_000);

    const rows = await audits(reader.actorId);
    expect(rows.at(-1)).toEqual({ succeeded: true, summary: "newest release v99.1.0" });
  });

  it("a failed check clears the release, stamps the time and says why", async () => {
    await lastCheck(40, "0.0.1");
    const gh = github(
      () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1791993600" },
        }),
    );
    const r = await checkReleasesNow({ registry, adapter, ctx: reader, fetchImpl: gh.fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("check_failed");
    expect(r.message).toContain("GitHub is limiting how often");

    const s = await status();
    // Not "Up to date": the page reads latestVersion=null + checkedAt as a failed check.
    expect(s.latestVersion).toBeNull();
    expect(s.checkedAt).not.toBeNull();
    const rows = await audits(reader.actorId);
    expect(rows.at(-1)?.summary).toContain("check failed (rate_limited)");
  });

  it("refuses within a minute of the last check without asking GitHub", async () => {
    await lastCheck(0.5, "99.0.0");
    const gh = github(RELEASE);
    const r = await checkReleasesNow({ registry, adapter, ctx: reader, fetchImpl: gh.fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("cooldown");
    expect(r.message).toContain("less than a minute ago");
    expect(gh.calls()).toBe(0);
    expect((await status()).latestVersion).toBe("99.0.0");
  });

  it("the op refuses a write inside the cooldown (a racing second click)", async () => {
    await lastCheck(0.5, "99.0.0");
    const r = await execute(registry, adapter, reader, "platform_updates.check_now", {
      outcome: {
        reached: true,
        latestVersion: "99.9.9",
        releaseUrl: null,
        releaseNotes: null,
        publishedAt: null,
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("RateLimited");
    const retry = (r.error as { retryAfterMs?: number }).retryAfterMs ?? 0;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60_000);
    expect((await status()).latestVersion).toBe("99.0.0");
    expect((await audits(reader.actorId)).at(-1)?.succeeded).toBe(false);
  });

  it("is not open to the AI", async () => {
    await lastCheck(40);
    const r = await execute(registry, adapter, AI, "platform_updates.check_now", {
      outcome: { reached: false, problem: "unreachable", message: "x" },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ActorScopeRejected");
  });

  it("refuses (and audits) a human without settings.read", async () => {
    await lastCheck(40, "99.0.0");
    const gh = github(RELEASE);
    const r = await checkReleasesNow({ registry, adapter, ctx: nobody, fetchImpl: gh.fetchImpl });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.message).toContain("permission_denied");
    expect((await status()).latestVersion).toBe("99.0.0");
    const rows = await audits(nobody.actorId);
    expect(rows.at(-1)?.succeeded).toBe(false);
  });
});
