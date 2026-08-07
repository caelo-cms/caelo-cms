// SPDX-License-Identifier: MPL-2.0

/**
 * #399 — the plugin-shipped skills (translate-page, add-language,
 * localize-slugs): live the moment the plugin is, bodies
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
  activated_at: string | Date | null;
  plugin_id: string | null;
  body: string;
  auto_engagement_hints: { keywords?: string[] } | null;
}

async function loadSkillRows(): Promise<Map<string, SkillRow>> {
  const rows = await sqlSystem(
    async (tx) =>
      (await tx.unsafe(
        `SELECT slug, status, activated_at, plugin_id::text AS plugin_id, body, auto_engagement_hints
         FROM skills WHERE slug IN (${SKILL_SLUGS.map((s) => `'${s}'`).join(", ")})`,
      )) as SkillRow[],
  );
  return new Map(rows.map((r) => [r.slug, r]));
}

describe("#399 — plugin-shipped i18n skills", () => {
  it("registers all three ACTIVE, attributed to the plugin, with the load-bearing contracts in the bodies", async () => {
    const skills = await loadSkillRows();
    expect([...skills.keys()].sort()).toEqual([...SKILL_SLUGS].sort());
    for (const slug of SKILL_SLUGS) {
      const row = skills.get(slug);
      // A plugin's skills are part of what the plugin IS: loading the
      // plugin already required an activation decision, and a second
      // click would leave the AI able to CALL the plugin's tools while
      // the `## Skills` index — the only surface that announces them —
      // stayed silent. That gap is what let the AI improvise a
      // translation with core tools in the #400 livedit run.
      expect(row?.status).toBe("active");
      expect(row?.activated_at).not.toBeNull();
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

  it("re-boot refreshes bodies without re-stamping activated_at, and an Owner's archive sticks", async () => {
    const before = await loadSkillRows();
    const stampBefore = before.get("translate-page")?.activated_at;
    expect(stampBefore).not.toBeNull();

    // An Owner archived one skill individually — the per-skill decision
    // is still theirs, and boot must not undo it.
    await sqlSystem(async (tx) => {
      await tx.unsafe(
        `UPDATE skills SET status = 'archived', activated_at = NULL WHERE slug = 'localize-slugs'`,
      );
    });
    await boot();
    const after = await loadSkillRows();

    expect(after.get("translate-page")?.status).toBe("active");
    // The stamp must NOT move on a re-boot: it drives the new-skill
    // notice, so re-stamping would re-announce every plugin skill to
    // every open chat on every restart.
    expect(String(after.get("translate-page")?.activated_at)).toBe(String(stampBefore));
    expect(after.get("add-language")?.status).toBe("active");
    expect(after.get("localize-slugs")?.status).toBe("archived");
  });
});
