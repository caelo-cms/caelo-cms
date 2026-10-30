// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1277 — AI-facing errors are complete and patchable:
 *
 *   - `pages.build_page` reports every pre-write problem in ONE result,
 *     each in `errors[]` at its absolute input path, and the text renders
 *     the same paths;
 *   - a nested op that THROWS a unique violation is reported under
 *     `modules[i]` with no SQLSTATE, constraint or table name;
 *   - bulk ops report every failing index, not the first;
 *   - the content-value validator collects every bad field, rejects
 *     undeclared keys, and no longer passes silently when the module is
 *     missing (§2).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  DatabaseAdapter,
  type ErrorDetail,
  execute,
  formatErrorPath,
  OperationRegistry,
} from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { validateNestedRefs } from "../ops/content/content-instances.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "ai-errors-1277-test",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `i1277-tpl-${TS}`;
const MISSING = "00000000-0000-4000-8000-0000000012a7";
let templateId = "";
let moduleId = "";
const instanceIds: string[] = [];

async function admin<T>(fn: (sql: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await fn(sql);
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await admin((sql) =>
    sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`i1277-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`i1277-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${"I1277 %"})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"I1277 %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    }),
  );
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL!, publicDatabaseUrl: PUBLIC_URL! });
  registry = new OperationRegistry();
  registerAdminOps(registry);

  const tpl = await execute(registry, adapter, systemCtx, "templates.create", {
    slug: TPL_SLUG,
    displayName: "I1277 TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
    pageType: "home",
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, systemCtx, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });

  const mod = await execute(registry, adapter, systemCtx, "modules.create", {
    slug: `i1277-mod-${TS}`,
    displayName: "I1277 Stat",
    html: "<p>{{title}} {{count}}</p>",
    fields: [
      { name: "title", kind: "text", label: "Title" },
      { name: "count", kind: "number", label: "Count" },
    ],
  });
  if (!mod.ok) throw new Error(`module seed failed: ${JSON.stringify(mod.error)}`);
  moduleId = (mod.value as { moduleId: string }).moduleId;
  for (const title of ["a", "b", "c"]) {
    const ci = await execute(registry, adapter, systemCtx, "content_instances.create", {
      moduleId,
      values: { title, count: 1 },
    });
    if (!ci.ok) throw new Error(`instance seed failed: ${JSON.stringify(ci.error)}`);
    instanceIds.push((ci.value as { contentInstanceId: string }).contentInstanceId);
  }
});

afterAll(async () => {
  await admin((sql) => sql.unsafe("DROP TRIGGER IF EXISTS i1277_clash ON modules"));
  await admin((sql) => sql.unsafe("DROP FUNCTION IF EXISTS i1277_clash()"));
  await wipe();
  await adapter.close();
});

function errorsOf(error: unknown): ErrorDetail[] {
  return ((error as { errors?: ErrorDetail[] }).errors ?? []) as ErrorDetail[];
}

function messageOf(error: unknown): string {
  return (error as { message?: string }).message ?? "";
}

describe("pages.build_page — every pre-write problem in one result", () => {
  it("reports three independent problems at their absolute paths, nothing written", async () => {
    const slug = `i1277-three-${TS}`;
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug, title: "I1277 three", templateId },
      modules: [
        // 1. a module id that does not exist
        { blockName: "content", moduleId: MISSING },
        // 2. a block the template does not have
        {
          blockName: "nope",
          displayName: "I1277 Hero",
          description: "hero",
          kind: "hero",
          html: "<h1>{{hero_title}}</h1>",
          fields: [{ name: "hero_title", kind: "text", label: "Title" }],
          content: { source: "inline", values: { hero_title: "Hi" } },
        },
        // 3. an existing content instance that does not exist
        {
          blockName: "content",
          moduleId,
          content: { source: "existing", contentInstanceId: MISSING, syncMode: "synced" },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = errorsOf(r.error).map((e) => JSON.stringify(e.path));
    expect(paths).toContain(JSON.stringify(["modules", 0, "moduleId"]));
    expect(paths).toContain(JSON.stringify(["modules", 1, "blockName"]));
    expect(paths).toContain(JSON.stringify(["modules", 2, "content", "contentInstanceId"]));
    // Text and structure agree: every path is rendered in the message.
    for (const e of errorsOf(r.error))
      expect(messageOf(r.error)).toContain(formatErrorPath(e.path));
    const block = errorsOf(r.error).find((e) => e.path[2] === "blockName");
    expect(block?.allowed).toEqual(["content"]);
    const pages = await admin(
      (sql) => sql`SELECT 1 FROM pages WHERE slug = ${slug}` as Promise<unknown[]>,
    );
    expect(pages.length).toBe(0);
  });

  it("an existing instance bound through a {$ref} to a placed module passes the pre-write check", async () => {
    const slug = `i1277-ref-${TS}`;
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug, title: "I1277 ref", templateId },
      modules: [
        {
          blockName: "content",
          moduleId,
          ref: "stat",
          content: { source: "inline", values: { title: "t", count: 1 } },
        },
        {
          blockName: "content",
          moduleId: { $ref: "stat" },
          content: { source: "existing", contentInstanceId: instanceIds[0], syncMode: "synced" },
        },
      ],
    });
    expect(r.ok ? null : messageOf(r.error)).toBeNull();
  });

  it("collects every bad content field across entries after the writes started", async () => {
    const slug = `i1277-fields-${TS}`;
    const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
      page: { slug, title: "I1277 fields", templateId },
      modules: [
        {
          blockName: "content",
          moduleId,
          content: { source: "inline", values: { title: "x", count: "many" } },
        },
        {
          blockName: "content",
          moduleId,
          content: { source: "inline", values: { title: "y", subtitle: "z" } },
        },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = errorsOf(r.error).map((e) => JSON.stringify(e.path));
    expect(paths).toContain(JSON.stringify(["modules", 0, "content", "values", "count"]));
    expect(paths).toContain(JSON.stringify(["modules", 1, "content", "values", "subtitle"]));
    const undeclared = errorsOf(r.error).find((e) => e.path[4] === "subtitle");
    expect(undeclared?.allowed).toEqual(["title", "count"]);
    const pages = await admin(
      (sql) => sql`SELECT 1 FROM pages WHERE slug = ${slug}` as Promise<unknown[]>,
    );
    expect(pages.length).toBe(0);
  });

  it("names modules[i] for a nested unique violation, without SQLSTATE / constraint / table", async () => {
    // A real driver error from inside modules.create: the trigger raises
    // the unique violation Postgres would raise on a slug race.
    await admin((sql) =>
      sql.unsafe(`
        CREATE OR REPLACE FUNCTION i1277_clash() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'duplicate key value violates unique constraint "modules_slug_branch_uidx"'
            USING ERRCODE = '23505', DETAIL = 'Key (slug)=(' || NEW.slug || ') already exists.',
                  CONSTRAINT = 'modules_slug_branch_uidx', TABLE = 'modules';
        END $$;
        DROP TRIGGER IF EXISTS i1277_clash ON modules;
        CREATE TRIGGER i1277_clash BEFORE INSERT ON modules
          FOR EACH ROW WHEN (NEW.display_name = 'I1277 Clash') EXECUTE FUNCTION i1277_clash();
      `),
    );
    try {
      const r = await execute(registry, adapter, systemCtx, "pages.build_page", {
        page: { slug: `i1277-clash-${TS}`, title: "I1277 clash", templateId },
        modules: [
          { blockName: "content", moduleId, content: { source: "inline", values: { title: "t" } } },
          {
            blockName: "content",
            displayName: "I1277 Clash",
            description: "clash",
            kind: "content",
            html: "<p>{{body}}</p>",
            fields: [{ name: "body", kind: "text", label: "Body" }],
            content: { source: "inline", values: { body: "b" } },
          },
        ],
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const e = errorsOf(r.error);
      expect(e.length).toBe(1);
      expect(e[0]?.path).toEqual(["modules", 1]);
      expect(e[0]?.message).toContain("already exists");
      expect(e[0]?.next).toContain("displayName");
      const text = messageOf(r.error);
      expect(text).toContain("modules[1]");
      expect(text).not.toContain("SQLSTATE");
      expect(text).not.toContain("modules_slug_branch_uidx");
      expect(text).not.toContain("table=");
      expect(text).not.toContain("Failed query");
    } finally {
      await admin((sql) => sql.unsafe("DROP TRIGGER IF EXISTS i1277_clash ON modules"));
    }
  });
});

describe("bulk ops report every failing index", () => {
  it("content_instances.set_values_many names items[0] and items[2], nothing written", async () => {
    const r = await execute(registry, adapter, systemCtx, "content_instances.set_values_many", {
      items: [
        { id: MISSING, values: { title: "x" } },
        { id: instanceIds[1], values: { title: "SHOULD-NOT-PERSIST" } },
        { id: instanceIds[2], values: { title: "y", count: "lots" } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = errorsOf(r.error).map((e) => JSON.stringify(e.path));
    expect(paths).toContain(JSON.stringify(["items", 0]));
    expect(paths).toContain(JSON.stringify(["items", 2, "values", "count"]));
    expect(messageOf(r.error)).toContain("2 of 3 items failed");
    expect(messageOf(r.error).toLowerCase()).not.toContain("resend");
    const got = await execute(registry, adapter, systemCtx, "content_instances.get", {
      id: instanceIds[1],
    });
    if (!got.ok) throw new Error("read failed");
    expect(
      (got.value as { instance: { values: Record<string, unknown> } }).instance.values.title,
    ).toBe("b");
  });

  it("content_instances.create_many names every failing instance", async () => {
    const r = await execute(registry, adapter, systemCtx, "content_instances.create_many", {
      instances: [
        { moduleId, values: { title: "ok" } },
        { moduleId, values: { count: "NaN!" } },
        { moduleId, values: { headline: "?" } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = errorsOf(r.error).map((e) => JSON.stringify(e.path));
    expect(paths).toEqual([
      JSON.stringify(["instances", 1, "values", "count"]),
      JSON.stringify(["instances", 2, "values", "headline"]),
    ]);
  });
});

describe("content value validation — no silent pass (§2)", () => {
  it("a module that does not exist is a loud error, not ok", async () => {
    const out = await adapter.withAdminTransaction(systemCtx, (tx) =>
      validateNestedRefs(tx, null, MISSING, { title: "x" }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors[0]?.path).toEqual(["moduleId"]);
    expect(out.errors[0]?.next).toContain("list_modules");
  });

  it("keys already stored on the row stay writable (grandfathered)", async () => {
    const out = await adapter.withAdminTransaction(systemCtx, (tx) =>
      validateNestedRefs(tx, null, moduleId, { title: "x", legacy: "kept" }, { legacy: "old" }),
    );
    expect(out.ok).toBe(true);
  });
});
