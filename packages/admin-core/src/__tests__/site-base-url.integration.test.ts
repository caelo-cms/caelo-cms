// SPDX-License-Identifier: MPL-2.0
/**
 * #551 regression: the site base URL has no substituted default.
 * `site_defaults.get_seo` reports an unset value as null, and
 * `site_defaults.seed_site_base_url` (the admin's boot seed from
 * CAELO_SITE_URL) fills an unset value only — it never overwrites an
 * Owner's choice and is closed to every actor but the system.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "site-base-url-test",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "site-base-url-test-ai",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let baseBefore: string | null = null;

async function setBase(url: string | null): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`UPDATE site_defaults SET site_base_url = ${url} WHERE id = 1`;
    });
  } finally {
    await sql.end();
  }
}

async function getBase(): Promise<string | null> {
  const r = await execute(registry, adapter, SYSTEM, "site_defaults.get_seo", {});
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { siteBaseUrl: string | null }).siteBaseUrl;
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  baseBefore = await getBase();
});

afterAll(async () => {
  await setBase(baseBefore);
  await adapter.close();
});

describe("#551 site base URL", () => {
  it("get_seo reports an unset base URL as null, not a localhost substitute", async () => {
    await setBase(null);
    expect(await getBase()).toBeNull();
  });

  it("seed_site_base_url fills an unset value and records it", async () => {
    await setBase(null);
    const r = await execute(registry, adapter, SYSTEM, "site_defaults.seed_site_base_url", {
      siteBaseUrl: "https://seeded-551.example",
      source: "CAELO_SITE_URL",
    });
    expect(r.ok).toBe(true);
    expect((r.value as { seeded: boolean }).seeded).toBe(true);
    expect(await getBase()).toBe("https://seeded-551.example");
  });

  it("seed_site_base_url never overwrites a configured value", async () => {
    await setBase("https://owner-choice.example");
    const r = await execute(registry, adapter, SYSTEM, "site_defaults.seed_site_base_url", {
      siteBaseUrl: "https://seeded-551.example",
      source: "CAELO_SITE_URL",
    });
    expect(r.ok).toBe(true);
    expect((r.value as { seeded: boolean }).seeded).toBe(false);
    expect(await getBase()).toBe("https://owner-choice.example");
  });

  it("seed_site_base_url is system-only and validates the URL", async () => {
    await setBase(null);
    const ai = await execute(registry, adapter, AI, "site_defaults.seed_site_base_url", {
      siteBaseUrl: "https://ai-551.example",
      source: "chat",
    });
    expect(ai.ok).toBe(false);
    if (!ai.ok) expect(ai.error.kind).toBe("ActorScopeRejected");
    const bad = await execute(registry, adapter, SYSTEM, "site_defaults.seed_site_base_url", {
      siteBaseUrl: "not a url",
      source: "CAELO_SITE_URL",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe("ValidationFailed");
    expect(await getBase()).toBeNull();
  });
});
