// SPDX-License-Identifier: MPL-2.0

/**
 * issue #375 — growth-time design drafts against the real Postgres
 * pair (no mocked DB per CLAUDE.md §6): scoped add/list/select with
 * variant-set grouping + per-set selection, the scope/target pairing
 * rules, the render op's theme-shell composition, and the migration's
 * skill wiring (design-preview seed + genesis→design tool rename).
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
let sqlc: SQL;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000375a1",
  actorKind: "ai",
  requestId: "issue-375-design-preview-test",
};

const MODULE_ID = "00000000-0000-4000-8000-0000000375b1";
const PAGE_ID = "00000000-0000-4000-8000-0000000375b2";

const FRAGMENT = `<section class="hero-v"><h1>Real headline from the page</h1><p>${"y".repeat(160)}</p><style>.hero-v{background:var(--color-primary);padding:var(--spacing-lg,4rem) 2rem}</style></section>`;
const DOCUMENT = `<!doctype html><html><head><style>body{background:#4f46e5;font-family:"Inter",sans-serif}</style></head><body><h1>Site draft</h1><p>${"z".repeat(160)}</p></body></html>`;

beforeAll(async () => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL as string,
    publicDatabaseUrl: PUBLIC_URL as string,
  });
  sqlc = new SQL(ADMIN_URL as string);
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      INSERT INTO actors (id, kind, display_name)
      VALUES (${AI.actorId}::uuid, 'ai', 'issue-375 design-preview test')
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sqlc.end({ timeout: 5 }).catch(() => {});
  await adapter.close?.();
});

async function addModuleVariant(
  direction: string,
  variantSetId?: string,
): Promise<{ draftId: string; variantSetId: string }> {
  const r = await execute(registry, adapter, AI, "genesis.add_draft", {
    direction,
    rationale: `${direction} — issue375`,
    html: FRAGMENT,
    scope: "module",
    targetModuleId: MODULE_ID,
    ...(variantSetId ? { variantSetId } : {}),
  });
  expect(r.ok).toBe(true);
  return r.value as { draftId: string; variantSetId: string };
}

describe("design-preview ops (issue #375)", () => {
  it("groups a round's module variants into one set and selects per set", async () => {
    const first = await addModuleVariant("issue375 warm contrast");
    const second = await addModuleVariant("issue375 airy minimal", first.variantSetId);
    expect(second.variantSetId).toBe(first.variantSetId);

    // A site draft coexists — its selection must survive per-set picks.
    const site = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 site direction",
      rationale: "",
      html: DOCUMENT,
    });
    expect(site.ok).toBe(true);
    const siteId = (site.value as { draftId: string }).draftId;
    const selSite = await execute(registry, adapter, AI, "genesis.select_draft", {
      draftId: siteId,
    });
    expect(selSite.ok).toBe(true);

    const list = await execute(registry, adapter, AI, "genesis.list_drafts", {
      variantSetId: first.variantSetId,
    });
    expect(list.ok).toBe(true);
    const drafts = (
      list.value as {
        drafts: { id: string; scope: string; format: string; targetModuleId: string | null }[];
      }
    ).drafts;
    expect(drafts).toHaveLength(2);
    for (const d of drafts) {
      expect(d.scope).toBe("module");
      expect(d.format).toBe("fragment"); // derived, never client-supplied
      expect(d.targetModuleId).toBe(MODULE_ID);
    }

    // Pick one, then the other — demotion stays inside the set.
    const selA = await execute(registry, adapter, AI, "genesis.select_draft", {
      draftId: first.draftId,
    });
    expect(selA.ok).toBe(true);
    const selB = await execute(registry, adapter, AI, "genesis.select_draft", {
      draftId: second.draftId,
    });
    expect(selB.ok).toBe(true);
    expect((selB.value as { previousSelectedId: string | null }).previousSelectedId).toBe(
      first.draftId,
    );

    const conn = await sqlc.reserve();
    try {
      await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
      const selected = (await conn`
        SELECT id::text AS id, scope FROM genesis_drafts
        WHERE status = 'selected' AND direction LIKE 'issue375%'
        ORDER BY scope
      `) as unknown as { id: string; scope: string }[];
      // One selected module variant AND the untouched site selection.
      expect(selected).toEqual([
        { id: second.draftId, scope: "module" },
        { id: siteId, scope: "site" },
      ]);
    } finally {
      conn.release();
    }
  });

  it("rejects scope/target mismatches and byod outside site scope", async () => {
    const noTarget = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 missing target",
      rationale: "",
      html: FRAGMENT,
      scope: "page",
    });
    expect(noTarget.ok).toBe(false);

    const byodModule = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 byod module",
      rationale: "",
      html: FRAGMENT,
      scope: "module",
      targetModuleId: MODULE_ID,
      sourceKind: "byod_html",
    });
    expect(byodModule.ok).toBe(false);

    const siteWithTarget = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 site with target",
      rationale: "",
      html: DOCUMENT,
      scope: "site",
      targetPageId: PAGE_ID,
    });
    expect(siteWithTarget.ok).toBe(false);
  });

  it("refuses to mix targets inside one variant set", async () => {
    const first = await addModuleVariant("issue375 set-guard");
    const mixed = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 wrong sibling",
      rationale: "",
      html: FRAGMENT,
      scope: "page",
      targetPageId: PAGE_ID,
      variantSetId: first.variantSetId,
    });
    expect(mixed.ok).toBe(false);
    if (!mixed.ok) {
      expect((mixed.error as { message?: string }).message).toContain("variantSetId");
    }
  });

  it("renders a fragment inside the real theme shell and a document as-is", async () => {
    const variant = await addModuleVariant("issue375 shell render");
    const rendered = await execute(registry, adapter, AI, "genesis.render_draft", {
      draftId: variant.draftId,
    });
    expect(rendered.ok).toBe(true);
    const frag = rendered.value as { html: string; format: string; missingSlots: string[] };
    expect(frag.format).toBe("fragment");
    expect(frag.html).toStartWith("<!doctype html>");
    // The site's compiled theme + technical baseline wrap the fragment.
    expect(frag.html).toContain('<style data-source="theme">');
    expect(frag.html).toContain('<style data-source="base">');
    expect(frag.html).toContain('class="hero-v"');
    expect(frag.html).toContain("Real headline from the page");

    const site = await execute(registry, adapter, AI, "genesis.add_draft", {
      direction: "issue375 doc render",
      rationale: "",
      html: DOCUMENT,
    });
    expect(site.ok).toBe(true);
    const renderedDoc = await execute(registry, adapter, AI, "genesis.render_draft", {
      draftId: (site.value as { draftId: string }).draftId,
    });
    expect(renderedDoc.ok).toBe(true);
    const doc = renderedDoc.value as { html: string; format: string };
    expect(doc.format).toBe("document");
    expect(doc.html).toBe(DOCUMENT); // pass-through, no shell
  });

  it("ships the design-preview skill and the genesis→design tool rename", async () => {
    const conn = await sqlc.reserve();
    try {
      await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
      const preview = (await conn`
        SELECT status, body, allowlisted_tools::text AS allowlist
        FROM skills WHERE slug = 'design-preview'
      `) as unknown as { status: string; body: string; allowlist: string }[];
      expect(preview).toHaveLength(1);
      expect(preview[0]?.status).toBe("active");
      expect(preview[0]?.body).toContain("save_design_draft");
      expect(preview[0]?.allowlist).toContain("present_design_variants");

      const genesis = (await conn`
        SELECT body FROM skills WHERE slug = 'site-genesis'
      `) as unknown as { body: string }[];
      expect(genesis[0]?.body).toContain("save_design_draft");
      expect(genesis[0]?.body).not.toContain("save_genesis_draft");
      expect(genesis[0]?.body).toContain("issue #375");

      const quality = (await conn`
        SELECT body FROM skills WHERE slug = 'design-quality'
      `) as unknown as { body: string }[];
      expect(quality[0]?.body).toContain("design-preview skill loop");
    } finally {
      conn.release();
    }
  });
});
