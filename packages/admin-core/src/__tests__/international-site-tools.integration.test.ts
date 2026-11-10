// SPDX-License-Identifier: MPL-2.0

/**
 * #396 — the international-site AI tools: output shapes the AI plans
 * against (intl_status matrix), the create/link/unlink variant flow
 * with URL recomposition + 301s, set_locales validation, and the §11.A
 * gating markers on the tool specs.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  bootstrap,
  pluginToolsRegistry,
  resetPluginHost,
  runPluginOperation,
} from "@caelo-cms/plugin-host";
import intlPlugin from "@caelo-cms/plugin-international-site";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";
import { adoptTemplateIntoHomePageType } from "./_template-page-type.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SYS_CTX: ExecutionContext = {
  actorId: SYSTEM_ACTOR_ID,
  actorKind: "system",
  requestId: "t396",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
/** #1269 — the `pages.list` inputs while recording (null = not recording). */
let pageListInputs: unknown[] | null = null;
/** #1269 — the filters of the plugin's page_variants reads while recording. */
let variantReadFilters: (Record<string, unknown> | undefined)[] | null = null;

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
      "DELETE FROM pending_redirects WHERE from_path LIKE '/t396-%' OR from_path LIKE '/de/t396-%'",
    );
    await tx.unsafe(
      "DELETE FROM redirects WHERE from_path LIKE '/t396-%' OR from_path LIKE '/de/t396-%'",
    );
    // Actors stay (their audit + snapshot rows reference them — same
    // reasoning as the real uninstall, which relies on ON DELETE SET
    // NULL); the plugins-row delete detaches them.
    await tx.unsafe("DELETE FROM plugins WHERE slug = 'international-site'");
    await tx.unsafe("DELETE FROM pages WHERE slug LIKE 't396-%'");
    await tx.unsafe("DELETE FROM templates WHERE slug LIKE 't396-%'");
    await tx.unsafe("DELETE FROM layouts WHERE slug LIKE 't396-%'");
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  const runOperation = adapter.runOperation.bind(adapter);
  adapter.runOperation = ((o, ctx, input) => {
    if (o.name === "pages.list") pageListInputs?.push(input);
    const read = input as { table?: string; filter?: Record<string, unknown> };
    if (o.name === "plugin_storage.list" && read.table === "page_variants") {
      variantReadFilters?.push(read.filter);
    }
    return runOperation(o, ctx, input);
  }) as typeof adapter.runOperation;
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await cleanup();
  const report = await bootstrap({
    infra: { adapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: intlPlugin }],
  });
  if (report.failed.length > 0) throw new Error(JSON.stringify(report.failed));
});

afterAll(async () => {
  await cleanup();
  await adapter.close();
});

async function seedPage(slug: string, parentPageId?: string): Promise<string> {
  const templateId = await sqlSystem(async (tx) => {
    const lay = (await tx.unsafe(
      `INSERT INTO layouts (slug, display_name, html, css) VALUES ('${slug}-lay', 'L', '<html></html>', '') RETURNING id::text AS id`,
    )) as { id: string }[];
    const tpl = (await tx.unsafe(
      `INSERT INTO templates (slug, display_name, html, css, layout_id) VALUES ('${slug}-tpl', 'T', '<main></main>', '', '${lay[0]?.id}') RETURNING id::text AS id`,
    )) as { id: string }[];
    await adoptTemplateIntoHomePageType(tx, tpl[0]?.id ?? "");
    const id = tpl[0]?.id;
    if (!id) throw new Error("seed failed");
    return id;
  });
  const created = await execute(registry, adapter, SYS_CTX, "pages.create", {
    slug,
    title: slug,
    templateId,
    ...(parentPageId ? { parentPageId } : {}),
  });
  if (!created.ok) throw new Error(JSON.stringify(created.error));
  return (created.value as { pageId: string }).pageId;
}

async function op<T>(operationName: string, args: unknown): Promise<T> {
  const r = await runPluginOperation({
    invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
    pluginSlug: "international-site",
    operationName,
    args,
  });
  if (!r.ok) throw new Error(`${operationName}: ${r.error.kind}: ${r.error.message}`);
  return r.value as T;
}

describe("#396 — international-site AI tools", () => {
  it("set_locales validates; intl_status matrix; create_variant mints + links + moves URL; unlink reverses", async () => {
    const pricingId = await seedPage("t396-pricing");

    // set_locales validation: no default → loud.
    const bad = await runPluginOperation({
      invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
      pluginSlug: "international-site",
      operationName: "set_locales",
      args: {
        locales: [{ code: "en", displayName: "English", urlStrategy: "none", isDefault: false }],
      },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("exactly one locale must be isDefault");

    const set = await op<{ locales: number; nextStep: string }>("set_locales", {
      locales: [
        { code: "en", displayName: "English", urlStrategy: "none", isDefault: true },
        { code: "de", displayName: "Deutsch", urlStrategy: "subdirectory", isDefault: false },
      ],
    });
    expect(set.locales).toBe(2);
    expect(set.nextStep).toContain("propose_url_migration");

    // Status BEFORE any variants: pricing is unassigned.
    const before = await op<{
      locales: unknown[];
      groups: unknown[];
      unassignedPages: { pageId: string; slug: string }[];
      staleCounts: Record<string, number>;
    }>("intl_status", {});
    expect(before.locales).toHaveLength(2);
    expect(before.groups).toHaveLength(0);
    expect(before.unassignedPages.some((p) => p.pageId === pricingId)).toBe(true);

    // create_variant: draft counterpart with a LOCALIZED slug under /de/.
    const variant = await op<{
      pageId: string;
      groupId: string;
      path: string;
      pathMoved: boolean;
    }>("create_variant", {
      sourcePageId: pricingId,
      localeCode: "de",
      slug: "t396-preise",
      title: "Preise",
    });
    expect(variant.path).toBe("/de/t396-preise");
    expect(variant.pathMoved).toBe(true);

    const draft = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT status, current_path FROM pages WHERE id = '${variant.pageId}'`,
        )) as { status: string; current_path: string }[],
    );
    expect(draft[0]?.status).toBe("draft");
    expect(draft[0]?.current_path).toBe("/de/t396-preise");

    // Status AFTER: one group with source+de variants, pricing no longer unassigned.
    const after = await op<{
      groups: {
        groupId: string;
        variants: { pageId: string; locale: string; translationStatus: string }[];
      }[];
      unassignedPages: { pageId: string }[];
    }>("intl_status", {});
    expect(after.groups).toHaveLength(1);
    const group = after.groups[0];
    if (!group) throw new Error("no group");
    expect(group.variants.map((v) => v.locale).sort()).toEqual(["de", "en"]);
    expect(group.variants.find((v) => v.pageId === pricingId)?.translationStatus).toBe("source");
    expect(after.unassignedPages.some((p) => p.pageId === pricingId)).toBe(false);

    // Unlink: back to bare, with a 301 from the prefixed path.
    const unlinked = await op<{ path: string; pathMoved: boolean }>("unlink_page_variants", {
      pageId: variant.pageId,
    });
    expect(unlinked.path).toBe("/t396-preise");
    expect(unlinked.pathMoved).toBe(true);
    // #1550 — the move's 301 is Staged: live with the Publish live that ships it.
    const redirect = await sqlSystem(
      async (tx) =>
        (await tx.unsafe(
          `SELECT to_path FROM pending_redirects WHERE from_path = '/de/t396-preise' AND state = 'staged'`,
        )) as { to_path: string }[],
    );
    expect(redirect[0]?.to_path).toBe("/t396-preise");
  });

  it("#1269 — create_variant reads the pages it names, never the whole site", async () => {
    const parentId = await seedPage("t396-docs");
    const childId = await seedPage("t396-setup", parentId);
    pageListInputs = [];
    try {
      // The parent has no German counterpart yet: refused, naming the parent's path.
      const refused = await runPluginOperation({
        invocation: { origin: "system", actorId: "00000000-0000-0000-0000-000000000000" },
        pluginSlug: "international-site",
        operationName: "create_variant",
        args: { sourcePageId: childId, localeCode: "de", slug: "t396-einrichtung" },
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(refused.error.message).toContain("sits under /t396-docs");
      const parent = await op<{ path: string }>("create_variant", {
        sourcePageId: parentId,
        localeCode: "de",
        slug: "t396-doku",
      });
      expect(parent.path).toBe("/de/t396-doku");
      const child = await op<{ path: string }>("create_variant", {
        sourcePageId: childId,
        localeCode: "de",
        slug: "t396-einrichtung",
      });
      expect(child.path).toBe("/de/t396-doku/t396-einrichtung");
      expect(pageListInputs.length).toBeGreaterThan(0);
      for (const input of pageListInputs) {
        const i = input as { pageIds?: string[]; underPageId?: string; limit?: number };
        expect(i.pageIds !== undefined || i.underPageId !== undefined).toBe(true);
      }
    } finally {
      pageListInputs = null;
    }
  });

  it("#1269 — write_hints reads the home page's language versions, not the variant table", async () => {
    const homeId = await seedPage("t396-start");
    const prior = await sqlSystem(
      async (tx) =>
        (await tx.unsafe("SELECT home_page_id::text AS id FROM site_defaults WHERE id = 1")) as {
          id: string | null;
        }[],
    );
    if (prior.length === 0) throw new Error("no site_defaults row");
    await sqlSystem((tx) =>
      tx.unsafe(`UPDATE site_defaults SET home_page_id = '${homeId}' WHERE id = 1`),
    );
    try {
      const root = await op<{ pageId: string }>("create_variant", {
        sourcePageId: homeId,
        localeCode: "de",
      });
      variantReadFilters = [];
      const r = await op<{ hints: string[] }>("write_hints", {
        writes: [
          { kind: "values", moduleId: null, values: { switch: `caelo:page/${root.pageId}` } },
        ],
      });
      expect(r.hints).toHaveLength(1);
      expect(r.hints[0]).toContain("Deutsch home page");
      expect(variantReadFilters.length).toBeGreaterThan(0);
      for (const filter of variantReadFilters) {
        const keys = Object.keys(filter ?? {});
        expect(keys.some((k) => k === "page_id" || k === "group_id" || k === "anyOf")).toBe(true);
      }
    } finally {
      variantReadFilters = null;
      const before = prior[0]?.id;
      await sqlSystem((tx) =>
        tx.unsafe(
          `UPDATE site_defaults SET home_page_id = ${before ? `'${before}'` : "NULL"} WHERE id = 1`,
        ),
      );
    }
  });

  it("set_locales ships approval-gated; the other tools stay routine", () => {
    const specs = pluginToolsRegistry.list().map(({ spec }) => spec);
    const setLocales = specs.find((s) => s.name === "set_locales");
    expect(setLocales?.approvalMode).toBe("user-approval");
    expect(setLocales?.description).toContain("Approve");
    for (const name of [
      "intl_status",
      "create_variant",
      "link_page_variants",
      "unlink_page_variants",
    ]) {
      const spec = specs.find((s) => s.name === name);
      expect(spec).toBeDefined();
      expect(spec?.approvalMode).toBeUndefined();
    }
  });
});
