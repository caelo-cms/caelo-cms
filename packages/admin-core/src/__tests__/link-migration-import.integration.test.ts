// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout E) — internal links during a site import (rollout C
 * open point 1, maintainer decision: option b), against a real Postgres.
 *
 * While an import run is active on the rebuilding chat's branch:
 *   - a link to a page of the run that is not built yet (by path, or as
 *     an absolute URL on the migrated site's host) is kept literal and
 *     recorded against the run instead of refused;
 *   - a link to a path the run does not plan is still refused;
 *   - imports.resolve_links converts the recorded links whose pages now
 *     exist (on the chat's branch) and marks the rest unresolved;
 *   - get_run_report lists them; the run's cleanup finalises again and
 *     ends the leniency.
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
  requestId: "lmi-test",
};
const PFX = `lmi${Date.now().toString(36)}`;
const SOURCE = `https://${PFX}.source.test`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let ai: ExecutionContext;
let templateId = "";
let runId = "";
let moduleId = "";
let instanceId = "";
let laterPageId = "";

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

async function recorded(): Promise<{ value: string; status: string; source: string }[]> {
  return (await asSystem(
    (tx) =>
      tx`SELECT value, status, source FROM import_run_links WHERE run_id = ${runId}::uuid ORDER BY value COLLATE "C" DESC`,
  )) as { value: string; status: string; source: string }[];
}

async function wipe(): Promise<void> {
  await asSystem(async (tx) => {
    await tx`DELETE FROM import_runs WHERE source_url = ${SOURCE}`;
    await tx`DELETE FROM chat_sessions WHERE title LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`})`;
    await tx`DELETE FROM modules WHERE slug LIKE ${`${PFX}%`} OR display_name LIKE ${`${PFX}%`}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${`${PFX}-tpl`})`;
    await tx`DELETE FROM templates WHERE slug = ${`${PFX}-tpl`}`;
  });
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
    {
      title: `${PFX}-migration`,
    },
  );
  ai = {
    actorId: "00000000-0000-0000-0000-000000000a1a",
    actorKind: "ai",
    requestId: "lmi-ai",
    chatBranchId: session.chatBranchId,
  };
  const rows = (await asSystem(
    (tx) => tx`INSERT INTO import_runs (source_url, proposed_by, status, chat_session_id)
               VALUES (${SOURCE}, ${SYSTEM_ACTOR}::uuid, 'ready_for_review', ${session.chatSessionId}::uuid)
               RETURNING id::text AS id`,
  )) as { id: string }[];
  runId = rows[0]?.id ?? "";
  await asSystem(async (tx) => {
    for (const slug of ["later", "never"]) {
      await tx`INSERT INTO import_pages (run_id, source_url, proposed_slug, proposed_title)
               VALUES (${runId}::uuid, ${`${SOURCE}/${PFX}-${slug}`}, ${`${PFX}-${slug}`}, ${slug})`;
    }
  });
  moduleId = (
    await run<{ moduleId: string }>(
      "modules.create",
      {
        slug: `${PFX}-cta`,
        displayName: `${PFX} CTA`,
        html: '<div><a href="{{cta_href}}">Go</a>{{{body_html}}}</div>',
        fields: [
          { name: "cta_href", kind: "url", label: "CTA link" },
          { name: "body_html", kind: "richtext", label: "Body" },
        ],
      },
      ai,
    )
  ).moduleId;
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("links to pages an import has not built yet", () => {
  it("keeps a link to a planned page literal and records it against the run", async () => {
    instanceId = (
      await run<{ contentInstanceId: string }>(
        "content_instances.create",
        {
          moduleId,
          slug: `${PFX}-cta-1`,
          values: {
            cta_href: `/${PFX}-later`,
            body_html: `<p><a href="${SOURCE}/${PFX}-never">never built</a></p>`,
          },
        },
        ai,
      )
    ).contentInstanceId;
    expect(await recorded()).toEqual([
      { value: `${SOURCE}/${PFX}-never`, status: "pending", source: "build" },
      { value: `/${PFX}-later`, status: "pending", source: "build" },
    ]);
  });

  it("still refuses a path the run does not plan", async () => {
    const r = await execute(registry, adapter, ai, "content_instances.set_values", {
      id: instanceId,
      values: { cta_href: `/${PFX}-typo`, body_html: "" },
    });
    expect(r.ok).toBe(false);
    expect((r as { error: { message: string } }).error.message).toContain(
      "is not the path of any page",
    );
  });

  it("resolve_links converts the links whose page now exists and reports the rest", async () => {
    laterPageId = (
      await run<{ pageId: string }>(
        "pages.build_page",
        {
          page: { slug: `${PFX}-later`, title: "Later", templateId, status: "published" },
          modules: [
            {
              blockName: "content",
              displayName: `${PFX} later body`,
              description: "Body.",
              kind: "content",
              html: "<p>{{t}}</p>",
              fields: [{ name: "t", kind: "text", label: "T" }],
              content: { source: "inline", values: { t: "later" } },
            },
          ],
        },
        ai,
      )
    ).pageId;
    // An AI on another branch cannot write into this run's chat branch.
    const other = await run<{ chatBranchId: string }>("chat.create_session", {
      title: `${PFX}-other`,
      isolation: "experiment",
    });
    const foreign = await execute(
      registry,
      adapter,
      { ...ai, requestId: "lmi-other", chatBranchId: other.chatBranchId },
      "imports.resolve_links",
      { runId },
    );
    expect(foreign.ok).toBe(false);
    expect((foreign as { error: { message: string } }).error.message).toContain(
      "rebuilt in another chat",
    );
    expect((await recorded()).every((r) => r.status === "pending")).toBe(true);

    const out = await run<{ converted: number; resolved: number; unresolved: number }>(
      "imports.resolve_links",
      { runId },
      ai,
    );
    expect(out).toMatchObject({ converted: 1, resolved: 1, unresolved: 1 });

    // The chat's pending state now stores the reference; main is untouched (AI scope).
    const states = (await asSystem(
      (tx) => tx`SELECT cis.state FROM content_instance_snapshots cis
                   JOIN site_snapshots ss ON ss.id = cis.site_snapshot_id
                  WHERE cis.content_instance_id = ${instanceId}::uuid
                  ORDER BY ss.created_at DESC LIMIT 1`,
    )) as { state: unknown }[];
    const state = states[0]?.state;
    const values = (typeof state === "string" ? JSON.parse(state) : state) as {
      values: { cta_href: string; body_html: string };
    };
    expect(values.values.cta_href).toBe(`caelo:page/${laterPageId}`);
    expect(values.values.body_html).toContain(`${SOURCE}/${PFX}-never`);

    expect(await recorded()).toEqual([
      { value: `${SOURCE}/${PFX}-never`, status: "unresolved", source: "build" },
      { value: `/${PFX}-later`, status: "resolved", source: "build" },
    ]);

    const report = await run<{
      internalLinks: {
        pending: number;
        resolved: number;
        unresolved: { value: string; location: string }[];
      };
    }>("imports.get_run_report", { runId }, ai);
    expect(report.internalLinks.pending).toBe(0);
    expect(report.internalLinks.resolved).toBe(1);
    expect(report.internalLinks.unresolved.map((u) => u.value)).toEqual([`${SOURCE}/${PFX}-never`]);
    expect(report.internalLinks.unresolved[0]?.location).toContain("body_html");
  });

  it("is safe to repeat, and the run's cleanup ends the leniency", async () => {
    const again = await run<{ converted: number; resolved: number; unresolved: number }>(
      "imports.resolve_links",
      { runId },
      ai,
    );
    expect(again).toMatchObject({ converted: 0, resolved: 0, unresolved: 1 });
    await run("imports.cleanup_run", { runId });
    const r = await execute(registry, adapter, ai, "content_instances.set_values", {
      id: instanceId,
      values: { cta_href: `/${PFX}-never`, body_html: "" },
    });
    expect(r.ok).toBe(false);
  });
});
