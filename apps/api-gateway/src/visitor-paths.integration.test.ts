// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #634 — the visitor paths that failed for every visitor once the
 * gateway ran as `gateway_role` (#613):
 *
 *   1. comments `list_approved` — `ctx.cms.call("comment_archive.list_for_page")`
 *      hit an empty operation registry.
 *   2. comments `submit` — `ctx.captcha.requireProof` accepted only the
 *      literal "dev" token in production, so a visitor whose proof the
 *      gateway had verified was still refused.
 *
 * Drives each path through `handleRequest` exactly as production wires it:
 * gateway_role on cms_admin, public_role on cms_public, the registry from
 * `registerGatewayOperations`, the real comments plugin attached by the
 * dispatch-only host. The adversarial block proves the grants (migrations
 * 0252, 0259) reach only approved comments.
 *
 * Core A/B testing is gone (epic #676, migration 0259): the gateway serves
 * no `/api/variant*` route and its registry holds no experiment operation.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import commentsPlugin from "@caelo-cms/plugin-comments";
import {
  bootstrap,
  bootstrapDispatchOnly,
  registerGatewayOperations,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { invalidateRateLimitSpecCache } from "./middleware/rate-limit.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const GATEWAY_URL = process.env.GATEWAY_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !GATEWAY_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL, GATEWAY_DATABASE_URL and PUBLIC_DATABASE_URL are required (bootstrap.sh creates gateway_role)",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const P = "t634";

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pageId = "";
let savedCaptcha: { provider: string; prefix: string } | null = null;

async function asAdmin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const conn = new SQL(ADMIN_URL as string);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

async function cleanup(): Promise<void> {
  resetPluginHost();
  resetDispatchOnlyHost();
  await asAdmin(async (tx) => {
    await tx`DELETE FROM comment_archive WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`${P}-%`})`;
    await tx`DELETE FROM pages WHERE slug LIKE ${`${P}-%`}`;
    await tx`DELETE FROM audit_events WHERE actor_id IN (
      SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'comments'))`;
    await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'comments')`;
    await tx`DELETE FROM plugin_schema_migrations WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = 'comments')`;
    await tx`DELETE FROM plugins WHERE slug = 'comments'`;
    await tx`DELETE FROM gateway_request_log WHERE plugin_slug = 'comments'`;
    await tx`DELETE FROM rate_limit_buckets WHERE key LIKE '%comments%'`;
  });
  const pub = new SQL(PUBLIC_ADMIN_URL as string);
  try {
    await pub.unsafe("DROP SCHEMA IF EXISTS plugin_comments CASCADE");
  } finally {
    await pub.end();
  }
}

async function setCaptcha(provider: "off" | "pow"): Promise<void> {
  // One hex digit keeps the proof cheap to compute in a test.
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${provider}, captcha_pow_target_prefix = '0' WHERE id = 1`;
  });
  invalidateGatewaySettings();
}

let clientIp = 0;

/** A visitor POST from its own client IP (cookie-less requests share an IP bucket). */
function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  clientIp++;
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Forwarded-For": `203.0.113.${clientIp % 250}`,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function expectStatus(r: Response, status: number): Promise<void> {
  if (r.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${r.status}: ${await r.clone().text()}`);
  }
}

/** Fetch a challenge from the gateway and solve it, as the component kit does. */
async function solvedProof(): Promise<{ challenge: string; nonce: string }> {
  const c = await handleRequest(new Request("http://localhost/api/captcha/challenge"));
  await expectStatus(c, 200);
  const { challenge, target } = (
    (await c.json()) as { data: { challenge: string; target: string } }
  ).data;
  for (let nonce = 0; ; nonce++) {
    const hex = new Bun.CryptoHasher("sha256").update(`${challenge}${nonce}`).digest("hex");
    if (hex.startsWith(target)) return { challenge, nonce: String(nonce) };
  }
}

beforeAll(async () => {
  await cleanup();
  savedCaptcha = await asAdmin(async (tx) => {
    const [row] =
      (await tx`SELECT captcha_provider AS provider, captcha_pow_target_prefix AS prefix FROM site_settings WHERE id = 1`) as {
        provider: string;
        prefix: string;
      }[];
    return row ?? null;
  });

  // --- Admin side: the comments plugin registered + provisioned, a page,
  // approved + rejected comments. ---
  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  const adminReport = await bootstrap({
    infra: { adapter: adminAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: commentsPlugin }],
  });
  expect(adminReport.failed).toEqual([]);
  resetPluginHost();

  await asAdmin(async (tx) => {
    const [tpl] = (await tx`SELECT id::text AS id FROM templates LIMIT 1`) as { id: string }[];
    if (!tpl) throw new Error("no seeded template");
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path)
      VALUES (${`${P}-page`}, 'Comments page', ${tpl.id}::uuid, ${`/${P}-page`})
      RETURNING id::text AS id`) as { id: string }[];
    pageId = page?.id ?? "";
    await tx`
      INSERT INTO comment_archive (public_row_id, page_id, author_name, content, status, submitted_at)
      VALUES (gen_random_uuid(), ${pageId}::uuid, 'Ada', 'Lovely post', 'approved', now() - interval '1 hour'),
             (gen_random_uuid(), ${pageId}::uuid, 'Spammer', 'buy now', 'spam', now()),
             (gen_random_uuid(), ${pageId}::uuid, 'Troll', 'rejected text', 'rejected', now())`;
  });

  // --- Gateway side: production wiring. ---
  const urls = gatewayDatabaseUrls({
    GATEWAY_DATABASE_URL: GATEWAY_URL,
    PUBLIC_DATABASE_URL: PUBLIC_URL,
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: urls.gateway,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  const registry = new OperationRegistry();
  registerGatewayOperations(registry);
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  invalidateRateLimitSpecCache();
  const report = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: commentsPlugin }],
  });
  expect(report.failed).toEqual([]);
  expect(report.loaded.map((p) => p.slug)).toEqual(["comments"]);
});

afterAll(async () => {
  await asAdmin(async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${savedCaptcha?.provider ?? "pow"},
             captcha_pow_target_prefix = ${savedCaptcha?.prefix ?? "000fff"} WHERE id = 1`;
  });
  invalidateGatewaySettings();
  await cleanup();
  await gatewayAdapter.close();
  await adminAdapter.close();
});

describe("core A/B testing is gone (epic #676)", () => {
  it("answers 404 for the former /api/variant.js and /api/variant/assign routes", async () => {
    const script = await handleRequest(new Request("http://localhost/api/variant.js"));
    await expectStatus(script, 404);
    expect(script.headers.get("set-cookie")).toBeNull();
    const assign = await handleRequest(post("/api/variant/assign?exp=anything", {}));
    await expectStatus(assign, 404);
    expect(assign.headers.get("set-cookie")).toBeNull();
  });
});

describe("comments list_approved through the gateway (#634)", () => {
  it("returns the approved comments and nothing else", async () => {
    const r = await handleRequest(post("/api/plugin/comments/list_approved", { pageId }));
    await expectStatus(r, 200);
    const comments = ((await r.json()) as { data: { comments: { author_name: string }[] } }).data
      .comments;
    expect(comments.map((c) => c.author_name)).toEqual(["Ada"]);
  });
});

describe("comments submit: ctx.captcha.requireProof follows the gateway's verdict (#634)", () => {
  it("succeeds for a visitor whose proof the gateway verified", async () => {
    await setCaptcha("pow");
    const proof = await solvedProof();
    const r = await handleRequest(
      post("/api/plugin/comments/submit", {
        pageId,
        authorName: "Grace",
        content: "Great read",
        _caelo_captcha: proof,
      }),
    );
    await expectStatus(r, 200);
    expect(((await r.json()) as { data: { status: string } }).data.status).toBe("pending");
  });

  it("refuses a submission without a proof, even with the old 'dev' token", async () => {
    await setCaptcha("pow");
    const r = await handleRequest(
      post("/api/plugin/comments/submit", {
        pageId,
        authorName: "Bot",
        content: "spam",
        captchaToken: "dev",
      }),
    );
    expect(r.status).not.toBe(200);
    expect(await r.text()).toContain("captcha verification failed");
  });

  it("refuses a forged proof at the gateway", async () => {
    await setCaptcha("pow");
    const r = await handleRequest(
      post("/api/plugin/comments/submit", {
        pageId,
        authorName: "Bot",
        content: "spam",
        _caelo_captcha: { challenge: "f".repeat(32), nonce: "0" },
      }),
    );
    await expectStatus(r, 403);
  });

  it("refuses a replayed proof", async () => {
    await setCaptcha("pow");
    const proof = await solvedProof();
    const body = { pageId, authorName: "Grace", content: "once", _caelo_captcha: proof };
    await expectStatus(await handleRequest(post("/api/plugin/comments/submit", body)), 200);
    await expectStatus(await handleRequest(post("/api/plugin/comments/submit", body)), 403);
  });

  it("accepts a submission without a proof when the Owner turned the captcha off", async () => {
    await setCaptcha("off");
    const r = await handleRequest(
      post("/api/plugin/comments/submit", { pageId, authorName: "Lin", content: "no captcha" }),
    );
    await expectStatus(r, 200);
  });
});

describe("the new grants reach only what the visitor paths need (#634, adversarial)", () => {
  /** Run `query` as gateway_role; resolve to its rows, or the error message. */
  async function attempt(
    query: ReturnType<typeof sql>,
    actorKind: "system" | "plugin" = "system",
  ): Promise<unknown[] | string> {
    try {
      return await gatewayAdapter.withAdminTransaction(
        { actorId: SYSTEM_ACTOR_ID, actorKind, requestId: "t634" },
        async (tx) => (await tx.execute(query)) as unknown as unknown[],
      );
    } catch (e) {
      const err = e as { message?: string; cause?: { message?: string } };
      return `${err.message ?? ""} ${err.cause?.message ?? ""}`;
    }
  }

  it("sees approved comments only, and cannot write the archive", async () => {
    const rows = await attempt(
      sql`SELECT status FROM comment_archive WHERE page_id = ${pageId}::uuid`,
      "plugin",
    );
    expect(rows).toEqual([{ status: "approved" }]);
    expect(
      await attempt(
        sql`INSERT INTO comment_archive (public_row_id, page_id, author_name, content, status, submitted_at)
            VALUES (gen_random_uuid(), ${pageId}::uuid, 'x', 'y', 'approved', now())`,
        "plugin",
      ),
    ).toMatch(/permission denied/);
    expect(await attempt(sql`UPDATE comment_archive SET content = 'x'`, "plugin")).toMatch(
      /permission denied/,
    );
  });

  it("still cannot read pages or any other authoring table", async () => {
    expect(await attempt(sql`SELECT id FROM pages LIMIT 1`)).toMatch(/permission denied/);
    expect(await attempt(sql`SELECT id FROM modules LIMIT 1`)).toMatch(/permission denied/);
  });

  it("the registry holds only the gateway's operations — a plugin cannot reach the archive write", async () => {
    const registry = new OperationRegistry();
    registerGatewayOperations(registry);
    expect([...registry.names()].sort()).toEqual(["comment_archive.list_for_page"]);
  });
});
