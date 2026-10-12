// SPDX-License-Identifier: MPL-2.0

/**
 * #657 — a redirect target must be a same-site path. Before the fix every
 * write path only checked "starts with /", so `/https://example.com/x`
 * (a pasted URL that browsers resolve as a path on the site itself) and
 * `//evil.example/x` (protocol-relative: an open redirect to another host)
 * were stored and served as 301s.
 *
 * Pins the rule on every write path that reaches the redirects table —
 * redirects.create, redirects.create_many, the bulk_create_redirects AI
 * tool, and pages.delete / pages.delete_many with disposition='redirect'
 * — and that a rejection writes nothing.
 *
 * Real Postgres per CLAUDE.md §6.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { describeError } from "../ai/tools/_describe-error.js";
import { bulkCreateRedirectsTool } from "../ai/tools/bulk-create-redirects.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "redir-target-int",
};

const PFX = "redirtgt";
let templateId: string;

const BAD_TARGETS = [
  "/https://example.com/x",
  "/http://example.com/x",
  "//evil.example/x",
  "/\\evil.example/x",
];

/** Rows whose from_path starts with `/<PFX>` (RLS needs caelo.actor_kind). */
async function redirectsUnderPrefix(): Promise<{ from_path: string; to_path: string }[]> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return (await tx`
        SELECT from_path, to_path FROM redirects
        WHERE from_path LIKE ${`/${PFX}-%`} ORDER BY from_path
      `) as unknown as { from_path: string; to_path: string }[];
    });
  } finally {
    await sql.end();
  }
}

async function isDeleted(pageId: string): Promise<boolean> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT deleted_at FROM pages WHERE id = ${pageId}::uuid
      `) as unknown as { deleted_at: Date | null }[];
      return rows[0]?.deleted_at != null;
    });
  } finally {
    await sql.end();
  }
}

async function makePage(slug: string): Promise<string> {
  const r = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug,
    title: `T ${slug}`,
    templateId,
  });
  if (!r.ok) throw new Error(`page seed ${slug}`);
  return (r.value as { pageId: string }).pageId;
}

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${PFX}-%`}`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`${PFX}-%`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`${PFX}-%`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`${PFX}-%`}`;
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
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `${PFX}-tpl`,
    displayName: "Redirect target T",
    html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("redirects.create — target validation (#657)", () => {
  it.each(BAD_TARGETS)(
    "rejects %p with an actionable message and writes nothing",
    async (toPath) => {
      const r = await execute(registry, adapter, SYSTEM, "redirects.create", {
        fromPath: `/${PFX}-single`,
        toPath,
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.kind).toBe("ValidationFailed");
      expect(describeError(r.error)).toMatch(/protocol-relative|embeds a full URL|backslash/);
      expect(await redirectsUnderPrefix()).toHaveLength(0);
    },
  );

  it("the embedded-URL message tells the caller which path to use instead", async () => {
    const r = await execute(registry, adapter, SYSTEM, "redirects.create", {
      fromPath: `/${PFX}-single`,
      toPath: "/https://example.com/pricing?plan=pro",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const msg = describeError(r.error);
    expect(msg).toContain("use its path '/pricing?plan=pro'");
    expect(msg).toContain("external (other-domain) redirect targets are not supported");
  });

  it.each(["/", "/a/b?c=d#e"])("accepts the same-site target %p", async (toPath) => {
    const fromPath = `/${PFX}-ok-${toPath.length}`;
    const r = await execute(registry, adapter, SYSTEM, "redirects.create", { fromPath, toPath });
    expect(r.ok).toBe(true);
    const rows = await redirectsUnderPrefix();
    expect(rows.find((x) => x.from_path === fromPath)?.to_path).toBe(toPath);
  });
});

describe("redirects.create_many — target validation (#657)", () => {
  it("rejects the whole batch when one target is unsafe (nothing written)", async () => {
    const before = (await redirectsUnderPrefix()).length;
    const r = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
      redirects: [
        { fromPath: `/${PFX}-many-good`, toPath: "/fine" },
        { fromPath: `/${PFX}-many-bad`, toPath: "//evil.example/x" },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("ValidationFailed");
    expect(describeError(r.error)).toContain("protocol-relative");
    expect(await redirectsUnderPrefix()).toHaveLength(before);
  });

  it("bulk_create_redirects surfaces the actionable reason to the AI", async () => {
    const parsed = bulkCreateRedirectsTool.schema.safeParse({
      redirects: [{ fromPath: `/${PFX}-tool-bad`, toPath: "/https://example.com/x" }],
    });
    // The tool's own schema rejects before the op is reached …
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("use its path '/x'");
    // … and the op rejects it too if a caller skips the tool schema.
    const res = await bulkCreateRedirectsTool.handler(
      SYSTEM,
      {
        redirects: [
          { fromPath: `/${PFX}-tool-bad`, toPath: "/https://example.com/x", statusCode: 301 },
        ],
        upsert: false,
      },
      { adapter, registry } as ToolContext,
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("use its path '/x'");
  });

  it("accepts a batch of same-site targets", async () => {
    const r = await execute(registry, adapter, SYSTEM, "redirects.create_many", {
      redirects: [
        { fromPath: `/${PFX}-many-a`, toPath: "/a/b?c=d#e" },
        { fromPath: `/${PFX}-many-b`, toPath: "/" },
      ],
    });
    expect(r.ok).toBe(true);
    expect((r.ok ? r.value : null) as { created: number } | null).toMatchObject({ created: 2 });
  });
});

describe("pages.delete(_many) disposition='redirect' — target validation (#657)", () => {
  it("pages.delete rejects an off-site redirectTo and leaves the page live", async () => {
    const id = await makePage(`${PFX}-del-single`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete", {
      pageId: id,
      disposition: "redirect",
      redirectTo: "//evil.example/",
    });
    expect(r.ok).toBe(false);
    expect(await isDeleted(id)).toBe(false);
    expect((await redirectsUnderPrefix()).some((x) => x.from_path === `/${PFX}-del-single`)).toBe(
      false,
    );
  });

  it("pages.delete_many rejects an embedded-URL redirectTo and deletes nothing", async () => {
    const a = await makePage(`${PFX}-del-many-a`);
    const b = await makePage(`${PFX}-del-many-b`);
    const r = await execute(registry, adapter, SYSTEM, "pages.delete_many", {
      deletions: [
        { pageId: a, disposition: "404" },
        { pageId: b, disposition: "redirect", redirectTo: "/https://example.com/new" },
      ],
    });
    expect(r.ok).toBe(false);
    expect(await isDeleted(a)).toBe(false);
    expect(await isDeleted(b)).toBe(false);
  });
});
