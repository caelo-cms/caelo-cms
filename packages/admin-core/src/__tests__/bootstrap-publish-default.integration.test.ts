// SPDX-License-Identifier: MPL-2.0

/**
 * Regression: a bootstrap homepage was created `draft` (the static
 * `.default("draft")`), so the very next Stage failed with
 * "0 published pages for env='staging' — nothing to serve". That bug only
 * surfaced in the slow/flaky live-AI e2e (the AI is *told* to publish when
 * bootstrapping but doesn't reliably). It is a DETERMINISTIC op rule, so it
 * belongs here — real Postgres, no AI: create_page with `status` omitted
 * ships `published` on a bootstrap site (0 live published pages) and `draft`
 * on an established one; an explicit status always wins.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
const SYS: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "bootstrap-publish",
};

async function wipePages(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM pages WHERE slug LIKE 'bpd-%'`;
    });
  } finally {
    await sql.end();
  }
}

async function createStatus(slug: string, status?: "draft" | "published"): Promise<string> {
  const r = await execute(registry, adapter, SYS, "pages.create", {
    slug,
    title: slug,
    ...(status ? { status } : {}),
  });
  if (!r.ok) throw new Error(`create ${slug}: ${JSON.stringify(r.error)}`);
  const got = await execute(registry, adapter, SYS, "pages.get", {
    pageId: (r.value as { pageId: string }).pageId,
  });
  if (!got.ok) throw new Error(`get ${slug}`);
  return (got.value as { page: { status: string } }).page.status;
}

beforeAll(async () => {
  await wipePages();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});
afterAll(async () => {
  await wipePages();
  await adapter.close();
});

describe("pages.create context-aware status default", () => {
  it("bootstrap (0 live published pages): omitted status → published", async () => {
    // The homepage of a fresh site must ship, or Stage has nothing to serve.
    expect(await createStatus("bpd-home")).toBe("published");
  });

  it("established (>=1 published): omitted status → draft (review-first)", async () => {
    // bpd-home from the previous test is now the one live published page.
    expect(await createStatus("bpd-about")).toBe("draft");
  });

  it("an explicit status always wins over the context default", async () => {
    expect(await createStatus("bpd-explicit-draft", "draft")).toBe("draft");
    expect(await createStatus("bpd-explicit-pub", "published")).toBe("published");
  });
});
