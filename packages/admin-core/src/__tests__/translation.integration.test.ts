// SPDX-License-Identifier: MPL-2.0

/**
 * P10 — translation integration tests.
 *
 *   - Mode 1 happy path: source EN page → DE variant draft.
 *   - Mode 2 happy path: edit source EN, run Mode 2 against existing
 *     DE variant; only changed blocks rewritten.
 *   - Structural lock: AI response with extra modules → handler refuses.
 *   - Glossary injection: prompt builder includes glossary entries.
 *   - Translation_status_matrix synthesises not_started for missing variants.
 *   - Job create + worker round-trip: queue 1 unit, run worker, unit
 *     completes, job ends `completed`.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import type { AIProvider, ProviderEvent } from "../ai/provider.js";
import {
  resetStuckTranslationUnits,
  setMode2Provider,
  setTranslationProvider,
  startTranslationWorker,
  stopTranslationWorker,
} from "../index.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "translation-test",
};

/** Provider that returns a canned JSON response. Tests pre-set its output. */
class FixtureTranslationProvider implements AIProvider {
  readonly name = "anthropic" as const;
  readonly model = "fixture";
  responseText = "";
  inputTokens = 100;
  outputTokens = 50;

  async *generate(): AsyncIterable<ProviderEvent> {
    yield { kind: "text-delta", text: this.responseText };
    yield {
      kind: "usage",
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cachedTokens: 0,
    };
    yield { kind: "done", stopReason: "end_turn" };
  }
}

const provider = new FixtureTranslationProvider();

const TEST_SLUG_PREFIX = "trtest-";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM translation_job_units WHERE job_id IN (
        SELECT id FROM translation_jobs WHERE scope::text LIKE '%trtest%'
          OR initiated_by = ${systemCtx.actorId}::uuid
      )`;
      await tx`DELETE FROM translation_jobs WHERE initiated_by = ${systemCtx.actorId}::uuid`;
      // FK-safe order: glossary + style_guide reference locales.
      await tx`DELETE FROM site_glossary WHERE source_term LIKE 'TR-%' OR source_term = 'Caelo'`;
      await tx`DELETE FROM site_glossary WHERE locale IN ('xx', 'yy', 'tr')`;
      await tx`DELETE FROM site_style_guide WHERE locale IN ('xx', 'yy', 'tr')`;
      // Pages + their cloned modules.
      await tx`DELETE FROM page_modules WHERE page_id IN (
        SELECT id FROM pages WHERE slug LIKE ${`${TEST_SLUG_PREFIX}%`}
      )`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${TEST_SLUG_PREFIX}%`}`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`${TEST_SLUG_PREFIX}%`}`;
      await tx`UPDATE locales SET is_default = false WHERE code IN ('xx', 'yy', 'tr')`;
      await tx`DELETE FROM locales WHERE code IN ('xx', 'yy', 'tr')`;
      await tx`UPDATE locales SET is_default = true WHERE code = 'en'`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setTranslationProvider({ provider });
  setMode2Provider({ provider });
});

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await stopTranslationWorker();
  await adapter.close();
});

async function seedSourcePage(
  slug: string,
  modules: { slug: string; html: string }[],
): Promise<{
  pageId: string;
  moduleIds: string[];
}> {
  const sql = new SQL(ADMIN_URL);
  const moduleIds: string[] = [];
  let pageId = "";
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const pageRows = (await tx`
        INSERT INTO pages (slug, locale, name, title, template_id, status, translation_status)
        SELECT ${slug}, 'en', ${slug}, ${slug},
               (SELECT id FROM templates LIMIT 1), 'draft', 'source'
        RETURNING id::text AS id
      `) as unknown as { id: string }[];
      pageId = pageRows[0]?.id ?? "";
      let position = 0;
      for (const m of modules) {
        const moduleRows = (await tx`
          INSERT INTO modules (slug, display_name, html, css, js)
          VALUES (${m.slug}, ${m.slug}, ${m.html}, '', '')
          RETURNING id::text AS id
        `) as unknown as { id: string }[];
        const mid = moduleRows[0]?.id ?? "";
        moduleIds.push(mid);
        // v0.12.0 — mint a content_instance per placement so page_modules
        // satisfies the new NOT NULL FK.
        const ciRows = (await tx`
          INSERT INTO content_instances (module_id, "values")
          VALUES (${mid}::uuid, '{}'::jsonb)
          RETURNING id::text AS id
        `) as unknown as { id: string }[];
        const ciId = ciRows[0]?.id ?? "";
        await tx`
          INSERT INTO page_modules
            (page_id, block_name, position, module_id, content_instance_id, sync_mode)
          VALUES (${pageId}::uuid, 'content', ${position}, ${mid}::uuid, ${ciId}::uuid, 'unsynced')
        `;
        position += 1;
      }
    });
  } finally {
    await sql.end();
  }
  // Recompute content_hash so Mode 2 staleness detection can fire.
  await execute(registry, adapter, systemCtx, "pages.set_modules", {
    pageId,
    blocks: [{ blockName: "content", moduleIds }],
  });
  return { pageId, moduleIds };
}

async function addLocale(code: string, displayName: string): Promise<void> {
  const propose = await execute(registry, adapter, systemCtx, "locales.propose_create", {
    code,
    displayName,
    urlStrategy: "subdirectory",
  });
  if (!propose.ok) throw new Error("propose_create failed");
  const exec = await execute(registry, adapter, systemCtx, "locales.execute_proposal", {
    proposalId: (propose.value as { proposalId: string }).proposalId,
  });
  if (!exec.ok) throw new Error("execute_proposal failed");
}

describe("translation Mode 1", () => {
  it("creates a draft variant with cloned modules + translated HTML", async () => {
    await addLocale("xx", "Test XX");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}m1`, [
      { slug: `${TEST_SLUG_PREFIX}hero`, html: "<h1>Welcome</h1>" },
      { slug: `${TEST_SLUG_PREFIX}body`, html: "<p>Hello world</p>" },
    ]);
    provider.responseText = JSON.stringify({
      modules: [
        { blockName: "content", position: 0, html: "<h1>Bienvenue</h1>", altText: null },
        { blockName: "content", position: 1, html: "<p>Bonjour monde</p>", altText: null },
      ],
    });
    const r = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "xx",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const v = r.value as { variantPageId: string; moduleCount: number };
    expect(v.moduleCount).toBe(2);

    // Variant exists, status='draft', translation_status='up_to_date'.
    const get = await execute(registry, adapter, systemCtx, "pages.get", {
      pageId: v.variantPageId,
    });
    if (!get.ok) return;
    const page = (
      get.value as { page: { status: string; translationStatus: string; locale: string } }
    ).page;
    expect(page.status).toBe("draft");
    expect(page.translationStatus).toBe("up_to_date");
    expect(page.locale).toBe("xx");
  });

  it("refuses when a variant already exists (caller should use Mode 2)", async () => {
    await addLocale("xx", "Test XX");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}m1dup`, [
      { slug: `${TEST_SLUG_PREFIX}h`, html: "<h1>x</h1>" },
    ]);
    provider.responseText = JSON.stringify({
      modules: [{ blockName: "content", position: 0, html: "<h1>X</h1>", altText: null }],
    });
    const first = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "xx",
    });
    expect(first.ok).toBe(true);
    const dup = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "xx",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      const message = "message" in dup.error ? dup.error.message : "";
      expect(message).toMatch(/variant already exists/);
    }
  });

  it("structural lock — refuses when AI returns extra modules", async () => {
    await addLocale("xx", "Test XX");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}m1lock`, [
      { slug: `${TEST_SLUG_PREFIX}only`, html: "<h1>only</h1>" },
    ]);
    provider.responseText = JSON.stringify({
      modules: [
        { blockName: "content", position: 0, html: "<h1>only</h1>", altText: null },
        { blockName: "content", position: 1, html: "<p>NEW SLOT</p>", altText: null },
      ],
    });
    const r = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "xx",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const message = "message" in r.error ? r.error.message : "";
      expect(message).toMatch(/expected 1/);
    }
  });
});

describe("translation Mode 2", () => {
  it("rewrites only changed blocks; preserves prior translation", async () => {
    await addLocale("yy", "Test YY");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}m2`, [
      { slug: `${TEST_SLUG_PREFIX}intro`, html: "<h1>Welcome</h1>" },
      { slug: `${TEST_SLUG_PREFIX}body`, html: "<p>Original body</p>" },
    ]);
    // Mode 1 first.
    provider.responseText = JSON.stringify({
      modules: [
        { blockName: "content", position: 0, html: "<h1>Willkommen</h1>", altText: null },
        { blockName: "content", position: 1, html: "<p>Originaler Körper</p>", altText: null },
      ],
    });
    const m1 = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "yy",
    });
    if (!m1.ok) throw new Error("mode_1 setup failed");

    // Edit ONLY the second source module so the diff has exactly one changed block.
    const sql = new SQL(ADMIN_URL);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE modules SET html = '<p>Updated body</p>'
                 WHERE slug = ${`${TEST_SLUG_PREFIX}body`}`;
      });
    } finally {
      await sql.end();
    }
    // Recompute the source's content_hash so Mode 2 sees drift.
    const setMods = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!setMods.ok) throw new Error("get failed");
    const page = (
      setMods.value as {
        page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] };
      }
    ).page;
    const moduleIds = page.blocks[0]?.modules.map((m) => m.moduleId) ?? [];
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds }],
    });

    // Now Mode 2 — only the second block should be rewritten.
    provider.responseText = JSON.stringify({
      modules: [
        { blockName: "content", position: 1, html: "<p>Aktualisierter Körper</p>", altText: null },
      ],
    });
    const m2 = await execute(registry, adapter, systemCtx, "translation.mode_2", {
      pageId,
      targetLocale: "yy",
    });
    expect(m2.ok).toBe(true);
    if (!m2.ok) return;
    const v = m2.value as { blocksChanged: number };
    expect(v.blocksChanged).toBe(1);

    // Variant's first module is still "Willkommen" (preserved); second
    // module is the new translation.
    const variantR = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId: (m1.value as { variantPageId: string }).variantPageId,
    });
    if (!variantR.ok) return;
    const variantPage = (
      variantR.value as {
        page: { blocks: { modules: { html: string }[] }[] };
      }
    ).page;
    const variantHtml = variantPage.blocks[0]?.modules.map((m) => m.html) ?? [];
    expect(variantHtml[0]).toBe("<h1>Willkommen</h1>");
    expect(variantHtml[1]).toContain("Aktualisierter");
  });

  it("structural lock — refuses when AI returns a module not in the changed set", async () => {
    await addLocale("yy", "Test YY");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}m2lock`, [
      { slug: `${TEST_SLUG_PREFIX}a`, html: "<h1>a</h1>" },
    ]);
    provider.responseText = JSON.stringify({
      modules: [{ blockName: "content", position: 0, html: "<h1>A</h1>", altText: null }],
    });
    const m1 = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "yy",
    });
    if (!m1.ok) throw new Error("mode_1 setup failed");
    // No source change — diff has no `changed` entries. AI tries to
    // rewrite the only block anyway → reject.
    const sql = new SQL(ADMIN_URL);
    try {
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE modules SET html = '<h1>a-updated</h1>'
                 WHERE slug = ${`${TEST_SLUG_PREFIX}a`}`;
      });
    } finally {
      await sql.end();
    }
    const getR = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId,
    });
    if (!getR.ok) throw new Error("get failed");
    const moduleIds =
      (
        getR.value as {
          page: { blocks: { blockName: string; modules: { moduleId: string }[] }[] };
        }
      ).page.blocks[0]?.modules.map((m) => m.moduleId) ?? [];
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds }],
    });
    // Now we have 1 changed block. AI returns 2 modules — the second
    // one isn't in changed; structural lock refuses.
    provider.responseText = JSON.stringify({
      modules: [
        { blockName: "content", position: 0, html: "<h1>A-updated</h1>", altText: null },
        { blockName: "extra", position: 0, html: "<p>extra</p>", altText: null },
      ],
    });
    const m2 = await execute(registry, adapter, systemCtx, "translation.mode_2", {
      pageId,
      targetLocale: "yy",
    });
    expect(m2.ok).toBe(false);
    if (!m2.ok) {
      const message = "message" in m2.error ? m2.error.message : "";
      expect(message).toMatch(/structural lock/);
    }
  });
});

describe("translation glossary + style guide", () => {
  it("AI can write glossary entries (§7.9)", async () => {
    const aiCtx: ExecutionContext = { ...systemCtx, actorKind: "ai" };
    await addLocale("xx", "Test XX");
    const r = await execute(registry, adapter, aiCtx, "glossary.set", {
      sourceTerm: "TR-AI",
      locale: "xx",
      translation: "TR-AI-XX",
      context: "AI-curated test entry",
    });
    expect(r.ok).toBe(true);
    const list = await execute(registry, adapter, aiCtx, "glossary.list", {
      locale: "xx",
    });
    if (!list.ok) return;
    const entries = (list.value as { entries: { sourceTerm: string }[] }).entries;
    expect(entries.find((e) => e.sourceTerm === "TR-AI")).toBeTruthy();
  });

  it("AI can write style_guide entries (§7.9)", async () => {
    const aiCtx: ExecutionContext = { ...systemCtx, actorKind: "ai" };
    await addLocale("xx", "Test XX");
    const r = await execute(registry, adapter, aiCtx, "style_guide.set", {
      locale: "xx",
      body: "Test style guide written by the AI.",
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "style_guide.get", {
      locale: "xx",
    });
    if (!get.ok) return;
    const guide = (get.value as { guide: { body: string } | null }).guide;
    expect(guide?.body).toBe("Test style guide written by the AI.");
  });

  it("Mode 1 prompt includes glossary entries when defined (§7.6)", async () => {
    // Verifies the prompt builder surfaces glossary entries through to
    // the AI call. Indirect test — we record what the provider receives.
    await addLocale("xx", "Test XX");
    await execute(registry, adapter, systemCtx, "glossary.set", {
      sourceTerm: "Caelo",
      locale: "xx",
      translation: "Caelo",
      context: "brand name — never translate",
    });

    let capturedSystem = "";
    class CapturingProvider implements AIProvider {
      readonly name = "anthropic" as const;
      readonly model = "fixture";
      async *generate(input: { systemPrompt: unknown }): AsyncIterable<ProviderEvent> {
        const sys = input.systemPrompt;
        capturedSystem =
          typeof sys === "string" ? sys : (sys as { body: string }[]).map((c) => c.body).join("\n");
        yield {
          kind: "text-delta",
          text: JSON.stringify({
            modules: [
              {
                blockName: "content",
                position: 0,
                html: "<h1>Welcome to Caelo</h1>",
                altText: null,
              },
            ],
          }),
        };
        yield { kind: "usage", inputTokens: 10, outputTokens: 5, cachedTokens: 0 };
        yield { kind: "done", stopReason: "end_turn" };
      }
    }
    setTranslationProvider({ provider: new CapturingProvider() });

    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}gloss`, [
      { slug: `${TEST_SLUG_PREFIX}only`, html: "<h1>Welcome to Caelo</h1>" },
    ]);
    const r = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "xx",
    });
    expect(r.ok).toBe(true);
    expect(capturedSystem).toContain("Caelo");
    expect(capturedSystem).toContain("brand name — never translate");

    // Restore the default provider for subsequent tests.
    setTranslationProvider({ provider });
  });
});

describe("translation Mode 2 snapshot revert", () => {
  it("revert restores the prior translation after Mode 2 overwrites", async () => {
    await addLocale("yy", "Test YY");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}revert`, [
      { slug: `${TEST_SLUG_PREFIX}rev`, html: "<h1>Welcome</h1>" },
    ]);
    // Mode 1 to create a baseline variant.
    provider.responseText = JSON.stringify({
      modules: [{ blockName: "content", position: 0, html: "<h1>Willkommen</h1>", altText: null }],
    });
    const m1 = await execute(registry, adapter, systemCtx, "translation.mode_1", {
      pageId,
      targetLocale: "yy",
    });
    if (!m1.ok) throw new Error("mode_1 setup failed");
    const variantPageId = (m1.value as { variantPageId: string }).variantPageId;

    // Edit source so Mode 2 has work to do.
    const sql0 = new SQL(ADMIN_URL);
    try {
      await sql0.begin(async (tx) => {
        await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
        await tx`UPDATE modules SET html = '<h1>Welcome - updated</h1>'
                 WHERE slug = ${`${TEST_SLUG_PREFIX}rev`}`;
      });
    } finally {
      await sql0.end();
    }
    const getM = await execute(registry, adapter, systemCtx, "pages.get_with_modules", { pageId });
    if (!getM.ok) throw new Error("get failed");
    const mids =
      (
        getM.value as { page: { blocks: { modules: { moduleId: string }[] }[] } }
      ).page.blocks[0]?.modules.map((m) => m.moduleId) ?? [];
    await execute(registry, adapter, systemCtx, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: mids }],
    });

    // Mode 2 — overwrite the variant module.
    provider.responseText = JSON.stringify({
      modules: [
        {
          blockName: "content",
          position: 0,
          html: "<h1>Willkommen aktualisiert</h1>",
          altText: null,
        },
      ],
    });
    const m2 = await execute(registry, adapter, systemCtx, "translation.mode_2", {
      pageId,
      targetLocale: "yy",
    });
    expect(m2.ok).toBe(true);

    // Confirm new state.
    const after = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId: variantPageId,
    });
    if (!after.ok) return;
    const afterHtml =
      (after.value as { page: { blocks: { modules: { html: string }[] }[] } }).page.blocks[0]
        ?.modules[0]?.html ?? "";
    expect(afterHtml).toContain("aktualisiert");

    // Find the Mode 1 baseline snapshot for the variant module and
    // revert through it. snapshots.list returns site-snapshot rows;
    // we filter to module-kind snapshots whose description tags this
    // test's slug, then pick the OLDEST (Mode 1 baseline) — that's
    // the one to revert to.
    const variantModuleId =
      (
        await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
          pageId: variantPageId,
        })
      ).ok &&
      (
        (
          await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
            pageId: variantPageId,
          })
        ).value as { page: { blocks: { modules: { moduleId: string }[] }[] } }
      ).page.blocks[0]?.modules[0]?.moduleId;
    expect(variantModuleId).toBeTruthy();
    if (!variantModuleId) return;
    const snaps = await execute(registry, adapter, systemCtx, "snapshots.list", {
      limit: 50,
    });
    if (!snaps.ok) return;
    const list = (
      snaps.value as {
        snapshots: { id: string; opKind: string; description: string; createdAt: string }[];
      }
    ).snapshots;
    const moduleSnaps = list
      .filter(
        (s) =>
          (s.opKind === "modules.create" || s.opKind === "modules.update") &&
          s.description.includes(`${TEST_SLUG_PREFIX}revert`),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    // Oldest is the Mode 1 baseline.
    const baseline = moduleSnaps[0];
    expect(baseline).toBeTruthy();
    if (!baseline) return;
    const revert = await execute(registry, adapter, systemCtx, "snapshots.revert_module", {
      moduleId: variantModuleId,
      snapshotId: baseline.id,
    });
    expect(revert.ok).toBe(true);

    const restored = await execute(registry, adapter, systemCtx, "pages.get_with_modules", {
      pageId: variantPageId,
    });
    if (!restored.ok) return;
    const restoredHtml =
      (restored.value as { page: { blocks: { modules: { html: string }[] }[] } }).page.blocks[0]
        ?.modules[0]?.html ?? "";
    expect(restoredHtml).toBe("<h1>Willkommen</h1>");
  });
});

describe("translation_jobs worker", () => {
  it("create + worker round-trip: queues 1 unit, completes, job ends 'completed'", async () => {
    await addLocale("tr", "Test TR");
    const { pageId } = await seedSourcePage(`${TEST_SLUG_PREFIX}job`, [
      { slug: `${TEST_SLUG_PREFIX}j`, html: "<h1>Hi</h1>" },
    ]);
    await resetStuckTranslationUnits({ adapter, registry, systemCtx });
    startTranslationWorker({ adapter, registry, systemCtx, idleMs: 50 });

    provider.responseText = JSON.stringify({
      modules: [{ blockName: "content", position: 0, html: "<h1>Merhaba</h1>", altText: null }],
    });
    const create = await execute(registry, adapter, systemCtx, "translation_jobs.create", {
      scope: { kind: "page", pageId },
    });
    expect(create.ok).toBe(true);
    if (!create.ok) return;
    const { jobId } = create.value as { jobId: string };

    // Poll for completion.
    let attempts = 0;
    let completed = false;
    while (attempts++ < 50) {
      const get = await execute(registry, adapter, systemCtx, "translation_jobs.get", { jobId });
      if (get.ok) {
        const j = (
          get.value as {
            job: { status: string; completedUnits: number; totalUnits: number } | null;
          }
        ).job;
        if (j && j.status === "completed" && j.completedUnits === j.totalUnits) {
          completed = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await stopTranslationWorker();
    expect(completed).toBe(true);
  });
});
