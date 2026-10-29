// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C, maintainer decision on open point 1: option b) —
 * internal links during a site import, against a real Postgres.
 *
 * While an import run is active for the rebuilding chat:
 *   - a two-page migration where page 1 links to page 2 BEFORE page 2 is
 *     built writes without a refusal; the link is recorded against the
 *     run, and resolve_links stores it as a reference to page 2 — even
 *     though page 2 was rebuilt under a translated slug (its source path
 *     names it), in content values and module HTML alike;
 *   - a path outside the run's plan is still refused;
 *   - a planned page that is never built is a finding of the run (the
 *     resolve output and the run report), with where it is;
 *   - an AI in another chat cannot finalise the run; outside the chat the
 *     strict refusal holds; after the run's cleanup it holds again.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM_ACTOR = "00000000-0000-0000-0000-00000000ffff";
const SYSTEM: ExecutionContext = {
  actorId: SYSTEM_ACTOR,
  actorKind: "system",
  requestId: "lip-test",
};
const PFX = `lip${Date.now().toString(36)}`;
const SOURCE = `https://${PFX}.source.test`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let ai: ExecutionContext;
let templateId = "";
let runId = "";
let homeImportId = "";
let pricingImportId = "";
let homePageId = "";
let pricingPageId = "";

async function asSystem<T>(query: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return query(tx);
    });
  } finally {
    await sql.end();
  }
}

async function run<T>(op: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (!r.ok) throw new Error(`${op}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** A module whose HTML carries one internal link (a link-carrying surface). */
function linkModule(name: string, href: string): Record<string, unknown> {
  return {
    slug: `${PFX}-${name}`,
    displayName: name,
    html: `<a href="${href}">link</a>{{note}}`,
    // Declared fields: the extractor would otherwise lift the link out.
    fields: [{ name: "note", kind: "text", label: "Note" }],
  };
}

async function refusal(op: string, input: unknown, ctx: ExecutionContext): Promise<string> {
  const r = await execute(registry, adapter, ctx, op, input);
  if (r.ok) throw new Error(`${op} unexpectedly succeeded`);
  return (r.error as { message?: string }).message ?? JSON.stringify(r.error);
}

async function recorded(): Promise<{ value: string; status: string; entity_kind: string }[]> {
  return (await asSystem(
    (tx) =>
      tx`SELECT value, status, entity_kind FROM import_run_links
          WHERE run_id = ${runId}::uuid ORDER BY entity_kind, value COLLATE "C"`,
  )) as { value: string; status: string; entity_kind: string }[];
}

/** Latest branch state of an entity's snapshot table (the chat's view). */
async function branchState(table: string, idColumn: string, id: string): Promise<unknown> {
  const rows = (await asSystem((tx) =>
    tx.unsafe(
      `SELECT t.state FROM ${table} t JOIN site_snapshots ss ON ss.id = t.site_snapshot_id
        WHERE t.${idColumn} = $1::uuid AND ss.chat_branch_id = $2::uuid
        ORDER BY ss.created_at DESC LIMIT 1`,
      [id, ai.chatBranchId],
    ),
  )) as { state: unknown }[];
  const s = rows[0]?.state;
  return typeof s === "string" ? JSON.parse(s) : s;
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
}

function pageBody(name: string, html: string, fields: object[], values: object) {
  return {
    blockName: "content",
    displayName: `${PFX} ${name} body`,
    description: "Body.",
    kind: "content",
    html,
    fields,
    content: { source: "inline", values },
  };
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  templateId = (
    await run<{ templateId: string }>("templates.create", {
      slug: `${PFX}-tpl`,
      displayName: `${PFX} TPL`,
      html: `<html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    })
  ).templateId;
  await run("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const session = await run<{ chatSessionId: string; chatBranchId: string }>(
    "chat.create_session",
    { title: `${PFX}-migration` },
  );
  ai = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "lip-ai",
    chatBranchId: session.chatBranchId,
    chatTaskId: session.chatSessionId,
  };
  // The import run the chat rebuilds: two crawled pages, plus a third
  // the homepage's crawled navigation links to (never built here).
  runId = (
    (await asSystem(
      (tx) => tx`INSERT INTO import_runs (source_url, proposed_by, status, chat_session_id)
                 VALUES (${SOURCE}, ${SYSTEM_ACTOR}::uuid, 'ready_for_review', ${session.chatSessionId}::uuid)
                 RETURNING id::text AS id`,
    )) as { id: string }[]
  )[0]?.id as string;
  const crawled = async (slug: string, html: string): Promise<string> =>
    (
      (await asSystem(
        (
          tx,
        ) => tx`INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title, proposed_modules)
                   VALUES (${runId}::uuid, ${`${SOURCE}/${PFX}-${slug}`}, ${`${PFX}-${slug}`}, ${slug},
                           (${JSON.stringify([{ blockName: "content", position: 0, html, displayName: "Body" }])}::text)::jsonb)
                   RETURNING id::text AS id`,
      )) as { id: string }[]
    )[0]?.id as string;
  homeImportId = await crawled(
    "home",
    `<nav><a href="/${PFX}-pricing">Pricing</a><a href="${SOURCE}/${PFX}-team">Team</a></nav>`,
  );
  pricingImportId = await crawled("pricing", "<p>Prices</p>");
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("links to pages an import run has not built yet", () => {
  it("a page linking to a page built later writes without a refusal", async () => {
    homePageId = (
      await run<{ pageId: string }>(
        "pages.build_page",
        {
          page: {
            slug: `${PFX}-home`,
            title: "Home",
            templateId,
            status: "published",
            importPageId: homeImportId,
          },
          modules: [
            // #1028 — a nested entry whose only link sits in rich text.
            {
              ref: "faq_box",
              displayName: `${PFX} faq box`,
              description: "Hint box.",
              kind: "content",
              html: '<div class="box">{{{box_html}}}</div>',
              fields: [{ name: "box_html", kind: "richtext", label: "Box" }],
              content: {
                source: "inline",
                values: { box_html: `<p>See the <a href="/${PFX}-pricing#faq">FAQ</a>.</p>` },
              },
            },
            pageBody(
              "home",
              `<section><a class="nav" href="/${PFX}-pricing#plans">Pricing</a>{{{intro_html}}}<a href="{{cta_href}}">Go</a>{{#boxes}}{{/boxes}}</section>`,
              [
                { name: "intro_html", kind: "richtext", label: "Intro" },
                { name: "cta_href", kind: "url", label: "CTA" },
                { name: "boxes", kind: "module-list", label: "Boxes" },
              ],
              {
                intro_html: `<p>Meet the <a href="${SOURCE}/${PFX}-team">team</a>.</p>`,
                cta_href: `/${PFX}-pricing`,
                boxes: [{ $ref: "faq_box" }],
              },
            ),
          ],
        },
        ai,
      )
    ).pageId;
    expect((await recorded()).map((r) => [r.entity_kind, r.value, r.status])).toEqual([
      ["content_instance", `/${PFX}-pricing`, "pending"],
      ["content_instance", `/${PFX}-pricing#faq`, "pending"],
      ["content_instance", `${SOURCE}/${PFX}-team`, "pending"],
      ["module", `/${PFX}-pricing#plans`, "pending"],
    ]);
  });

  it("still refuses a path outside the run's plan", async () => {
    const message = await refusal("modules.create", linkModule("typo", `/${PFX}-pricng`), ai);
    expect(message).toContain(`"/${PFX}-pricng" is not the path of any page`);
    // ...and outside the import's chat, a planned path is no exception.
    const outside = await refusal(
      "modules.create",
      linkModule("outside", `/${PFX}-pricing`),
      SYSTEM,
    );
    expect(outside).toContain("is not the path of any page");
  });

  it("resolve_links stores every recorded link as a reference once page 2 exists", async () => {
    // Page 2, rebuilt under a translated slug: its source path still names it.
    pricingPageId = (
      await run<{ pageId: string }>(
        "pages.build_page",
        {
          page: {
            slug: `${PFX}-preise`,
            title: "Preise",
            templateId,
            status: "published",
            importPageId: pricingImportId,
          },
          modules: [
            pageBody("pricing", "<p>{{t}}</p>", [{ name: "t", kind: "text", label: "T" }], {
              t: "Prices",
            }),
          ],
        },
        ai,
      )
    ).pageId;

    // An AI in another chat cannot finalise this chat's run.
    const other = await run<{ chatBranchId: string }>("chat.create_session", {
      title: `${PFX}-other`,
      isolation: "experiment",
    });
    expect(
      await refusal(
        "imports.resolve_links",
        { runId },
        {
          ...ai,
          requestId: "lip-other",
          chatBranchId: other.chatBranchId,
        },
      ),
    ).toContain("rebuilt in another chat");

    const out = await run<{
      resolved: number;
      unresolved: { value: string; entityKind: string; location: string }[];
    }>("imports.resolve_links", { runId }, ai);
    expect(out.resolved).toBe(3);
    expect(out.unresolved.map((u) => [u.entityKind, u.value])).toEqual([
      ["content_instance", `${SOURCE}/${PFX}-team`],
    ]);
    expect(out.unresolved[0]?.location).toBe("values.intro_html");

    const homeModule = (
      await asSystem(
        (tx) => tx`SELECT id::text AS id FROM modules WHERE display_name = ${`${PFX} home body`}`,
      )
    )[0] as { id: string };
    const moduleState = (await branchState("module_snapshots", "module_id", homeModule.id)) as {
      html: string;
    };
    expect(moduleState.html).toContain(`href="caelo:page/${pricingPageId}#plans"`);

    const instance = (
      await asSystem(
        (tx) =>
          tx`SELECT id::text AS id FROM content_instances WHERE module_id = ${homeModule.id}::uuid`,
      )
    )[0] as { id: string };
    // #1028 — the nested rich-text entry is finalised like the placement.
    const boxInstance = (
      await asSystem(
        (tx) =>
          tx`SELECT ci.id::text AS id FROM content_instances ci JOIN modules m ON m.id = ci.module_id
              WHERE m.display_name = ${`${PFX} faq box`}`,
      )
    )[0] as { id: string };
    const boxValues = (
      (await branchState("content_instance_snapshots", "content_instance_id", boxInstance.id)) as {
        values: { box_html: string };
      }
    ).values;
    expect(boxValues.box_html).toContain(`href="caelo:page/${pricingPageId}#faq"`);
    const values = (
      (await branchState("content_instance_snapshots", "content_instance_id", instance.id)) as {
        values: { cta_href: string; intro_html: string };
      }
    ).values;
    expect(values.cta_href).toBe(`caelo:page/${pricingPageId}`);
    // The never-built page stays as written — a finding, not a guess.
    expect(values.intro_html).toContain(`href="${SOURCE}/${PFX}-team"`);

    // Reads show the built page's path, never an id (CLAUDE.md §1A).
    const got = await run<{ instance: { values: Record<string, unknown> } }>(
      "content_instances.get",
      { id: instance.id },
      ai,
    );
    expect(got.instance.values.cta_href).toBe(`/${PFX}-preise`);

    expect((await recorded()).map((r) => [r.entity_kind, r.value, r.status])).toEqual([
      ["content_instance", `/${PFX}-pricing`, "resolved"],
      ["content_instance", `/${PFX}-pricing#faq`, "resolved"],
      ["content_instance", `${SOURCE}/${PFX}-team`, "unresolved"],
      ["module", `/${PFX}-pricing#plans`, "resolved"],
    ]);

    const report = await run<{
      internalLinks: {
        pending: number;
        resolved: number;
        unresolved: { value: string; location: string }[];
        nextStep: string | null;
      };
    }>("imports.get_run_report", { runId }, ai);
    expect(report.internalLinks.pending).toBe(0);
    expect(report.internalLinks.resolved).toBe(3);
    expect(report.internalLinks.unresolved.map((u) => u.value)).toEqual([`${SOURCE}/${PFX}-team`]);
    expect(report.internalLinks.nextStep).toContain("resolve_import_links");
  });

  it("is safe to repeat, and after the run's cleanup the strict refusal holds again", async () => {
    const again = await run<{ resolved: number; unresolved: unknown[] }>(
      "imports.resolve_links",
      { runId },
      ai,
    );
    expect(again.resolved).toBe(0);
    expect(again.unresolved).toHaveLength(1);
    await run("imports.cleanup_run", { runId });
    expect((await recorded()).find((r) => r.value === `${SOURCE}/${PFX}-team`)?.status).toBe(
      "unresolved",
    );
    expect(await refusal("modules.create", linkModule("after", `/${PFX}-team`), ai)).toContain(
      "is not the path of any page",
    );
    expect(await refusal("imports.resolve_links", { runId }, ai)).toContain(
      "its links were finalised when it ended",
    );
    expect(homePageId).not.toBe("");
  });
});
