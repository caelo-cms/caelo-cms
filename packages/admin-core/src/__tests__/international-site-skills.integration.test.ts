// SPDX-License-Identifier: MPL-2.0

/**
 * #399 — the plugin-shipped skills (translate-page, add-language,
 * localize-slugs): registered at awaiting_activation on boot, bodies
 * carry the load-bearing behavioural contracts, and a re-boot never
 * demotes a skill the Owner activated.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { bootstrap, resetPluginHost } from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SKILL_SLUGS = ["translate-page", "add-language", "localize-slugs"];

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function sqlSystem<T>(fn: (tx: Bun.SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as Bun.SQL);
    });
  } finally {
    await sql.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  await sqlSystem(async (tx) => {
    await tx.unsafe('DROP SCHEMA IF EXISTS "plugin_international_site" CASCADE');
    await tx.unsafe(
      `DELETE FROM skills WHERE slug IN (${SKILL_SLUGS.map((s) => `'${s}'`).join(", ")})`,
    );
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
  });
}

async function boot(): Promise<void> {
  resetPluginHost();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  await boot();
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

interface SkillRow {
  slug: string;
  status: string;
  plugin_id: string | null;
  body: string;
  auto_engagement_hints: { keywords?: string[] } | null;
}

async function loadSkillRows(): Promise<Map<string, SkillRow>> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx.unsafe(
        `SELECT slug, status, plugin_id::text AS plugin_id, body, auto_engagement_hints
         FROM skills WHERE slug IN (${SKILL_SLUGS.map((s) => `'${s}'`).join(", ")})`,
      )) as SkillRow[],
  );
  return new Map(rows.map((r) => [r.slug, r]));
}

describe("#399 — plugin-shipped i18n skills", () => {
  it("registers all three at awaiting_activation, attributed to the plugin, with the load-bearing contracts in the bodies", async () => {
    const skills = await loadSkillRows();
    expect([...skills.keys()].sort()).toEqual([...SKILL_SLUGS].sort());
    for (const slug of SKILL_SLUGS) {
      const row = skills.get(slug);
      expect(row?.status).toBe("awaiting_activation");
      expect(row?.plugin_id).not.toBeNull();
    }

    // The contracts that must survive any future copy-editing:
    const translate = skills.get("translate-page");
    expect(translate?.body).toContain("intl_status FIRST");
    expect(translate?.body).toContain("never edit shared module HTML");
    expect(translate?.body).toContain("DRAFT");
    expect(translate?.body).toContain("set_glossary_term");
    expect(translate?.auto_engagement_hints?.keywords).toContain("übersetzen");

    const addLang = skills.get("add-language");
    expect(addLang?.body).toContain("TWO-APPROVAL");
    expect(addLang?.body).toContain("propose_url_migration");
    expect(addLang?.body).toContain("clean 404, never a fallback");

    const slugs = skills.get("localize-slugs");
    expect(slugs?.body).toContain("NEVER derived from matching slugs");
    expect(slugs?.body).toContain("301");
  });

  it("re-boot preserves an Owner-activated skill and refreshes the body", async () => {
    await sqlSystem(async (tx) => {
      await tx.unsafe(`UPDATE skills SET status = 'active' WHERE slug = 'translate-page'`);
    });
    await boot();
    const skills = await loadSkillRows();
    // Owner's site-wide activation survives the upsert…
    expect(skills.get("translate-page")?.status).toBe("active");
    // …while never-activated siblings stay awaiting the click.
    expect(skills.get("add-language")?.status).toBe("awaiting_activation");
    expect(skills.get("localize-slugs")?.status).toBe("awaiting_activation");
  });
});
