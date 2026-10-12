// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #634 — the visitor paths that failed for every visitor once the
 * gateway ran as `gateway_role` (#613):
 *
 *   1. POST /api/variant/assign — its experiment ops were never in the
 *      gateway's operation registry, and gateway_role could not read them.
 *   2. comments `list_approved` — `ctx.cms.call("comment_archive.list_for_page")`
 *      hit the same empty registry.
 *   3. comments `submit` — `ctx.captcha.requireProof` accepted only the
 *      literal "dev" token in production, so a visitor whose proof the
 *      gateway had verified was still refused.
 *
 * Drives each path through `handleRequest` exactly as production wires it:
 * gateway_role on cms_admin, public_role on cms_public, the registry from
 * `registerGatewayOperations`, the real comments plugin attached by the
 * dispatch-only host. The adversarial block proves the new grants
 * (migration 0252) reach only active experiments and approved comments.
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
import { pickVariant } from "./ab-router.js";
import { hashVisitorId } from "./middleware/captcha.js";
import { invalidateRateLimitSpecCache } from "./middleware/rate-limit.js";
import { verifySignedCookie } from "./middleware/signed-cookie.js";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  parseCookies,
  setGatewayAdapter,
  setGatewayRegistry,
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
const ACTIVE_EXP = `${P}-active`;
const DRAFT_EXP = `${P}-draft`;

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pageId = "";
let activeExperimentId = "";
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
    await tx`DELETE FROM experiments WHERE slug LIKE ${`${P}-%`}`;
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
  // an active and a draft experiment, approved + rejected comments. ---
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
      VALUES (${`${P}-page`}, 'Experiment page', ${tpl.id}::uuid, ${`/${P}-page`})
      RETURNING id::text AS id`) as { id: string }[];
    pageId = page?.id ?? "";
    const variants = JSON.stringify([
      { label: "control", weight: 0.5 },
      { label: "b", weight: 0.5, htmlPatches: [{ find: "Sign up", replace: "Try it" }] },
    ]);
    const [active] = (await tx`
      INSERT INTO experiments (slug, page_id, variants, status, started_at)
      VALUES (${ACTIVE_EXP}, ${pageId}::uuid, (${variants}::text)::jsonb, 'active', now())
      RETURNING id::text AS id`) as { id: string }[];
    activeExperimentId = active?.id ?? "";
    await tx`
      INSERT INTO experiments (slug, page_id, variants, status)
      VALUES (${DRAFT_EXP}, ${pageId}::uuid, (${variants}::text)::jsonb, 'draft')`;
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
  setGatewayRegistry(registry);
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

describe("POST /api/variant/assign as gateway_role (#634, #649)", () => {
  /** What /api/variant.js sends: no body, only the cookies the browser holds. */
  function assign(slug: string, cookie?: string): Request {
    clientIp++;
    return new Request(`http://localhost/api/variant/assign?exp=${slug}`, {
      method: "POST",
      headers: {
        "X-Forwarded-For": `203.0.113.${clientIp % 250}`,
        ...(cookie ? { cookie } : {}),
      },
    });
  }

  async function impressionRows(): Promise<
    { variant_label: string; impressions: number; visitor_id_hash: string }[]
  > {
    return asAdmin(
      async (tx) =>
        (await tx`SELECT variant_label, impressions, visitor_id_hash FROM experiment_assignments
                  WHERE experiment_id = ${activeExperimentId}::uuid`) as {
          variant_label: string;
          impressions: number;
          visitor_id_hash: string;
        }[],
    );
  }

  it("assigns a first-time visitor from the cookie alone and keeps them in that variant", async () => {
    await asAdmin(async (tx) => {
      await tx`DELETE FROM experiment_assignments WHERE experiment_id = ${activeExperimentId}::uuid`;
    });
    const secret = await asAdmin(
      async (tx) =>
        (
          (await tx`SELECT gateway_cookie_secret AS s FROM site_settings WHERE id = 1`) as {
            s: string;
          }[]
        )[0]?.s ?? "",
    );

    // No cookie, no body — exactly the browser's first request (#649).
    const first = await handleRequest(assign(ACTIVE_EXP));
    await expectStatus(first, 200);
    const { variant } = ((await first.json()) as { data: { variant: string } }).data;
    expect(["control", "b"]).toContain(variant);

    // The gateway minted the id it bucketed on, and page script cannot read it.
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toStartWith("caelo_visitor_id=");
    expect(setCookie).toContain("HttpOnly");
    const signed = parseCookies(setCookie.split(";")[0] ?? null).caelo_visitor_id ?? "";
    const verified = await verifySignedCookie({ signed, secret });
    const visitorId = verified?.value ?? "";
    expect(visitorId).toMatch(/^[0-9a-f-]{36}$/);
    expect(variant).toBe(
      pickVariant(visitorId, ACTIVE_EXP, [
        { label: "control", weight: 0.5 },
        { label: "b", weight: 0.5 },
      ]) ?? "",
    );

    // Reload: the browser sends the cookie back, same variant, no new cookie.
    const cookie = `caelo_visitor_id=${signed}`;
    for (let i = 0; i < 3; i++) {
      const again = await handleRequest(assign(ACTIVE_EXP, cookie));
      await expectStatus(again, 200);
      expect(again.headers.get("set-cookie")).toBeNull();
      expect(((await again.json()) as { data: { variant: string } }).data.variant).toBe(variant);
    }

    // Bucketing and the impression row use the same verified id.
    expect(await impressionRows()).toEqual([
      { variant_label: variant, impressions: 4, visitor_id_hash: hashVisitorId(visitorId) },
    ]);
  });

  it("ignores a client-supplied visitorId — only the signed cookie decides", async () => {
    const minted = await handleRequest(assign(ACTIVE_EXP));
    await expectStatus(minted, 200);
    const cookie = minted.headers.get("set-cookie")?.split(";")[0] ?? "";
    const expected = ((await minted.json()) as { data: { variant: string } }).data.variant;
    for (const visitorId of ["attacker-1", "attacker-2", "attacker-3", "attacker-4"]) {
      const r = await handleRequest(
        post(
          `/api/variant/assign?exp=${ACTIVE_EXP}`,
          { visitorId, page: `/${P}-page` },
          { cookie },
        ),
      );
      await expectStatus(r, 200);
      expect(((await r.json()) as { data: { variant: string } }).data.variant).toBe(expected);
    }
  });

  it("treats a tampered cookie as a new visitor and re-mints it", async () => {
    const r = await handleRequest(
      assign(ACTIVE_EXP, `caelo_visitor_id=${"0".repeat(36)}.forged-signature`),
    );
    await expectStatus(r, 200);
    expect(r.headers.get("set-cookie") ?? "").toStartWith("caelo_visitor_id=");
  });

  it("answers 400 for a draft experiment — drafts are not served, and no cookie is minted", async () => {
    const r = await handleRequest(assign(DRAFT_EXP));
    await expectStatus(r, 400);
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(((await r.json()) as { error: { message: string } }).error.message).toBe(
      "no active experiment",
    );
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

  it("sees active experiments only, and none of their authoring columns", async () => {
    expect(await attempt(sql`SELECT slug FROM experiments WHERE slug LIKE ${`${P}-%`}`)).toEqual([
      { slug: ACTIVE_EXP },
    ]);
    for (const column of ["page_id", "created_by", "winning_variant", "started_at"]) {
      expect(await attempt(sql.raw(`SELECT ${column} FROM experiments`))).toMatch(
        /permission denied/,
      );
    }
    expect(await attempt(sql`UPDATE experiments SET status = 'active'`)).toMatch(
      /permission denied/,
    );
    expect(await attempt(sql`DELETE FROM experiment_assignments`)).toMatch(/permission denied/);
  });

  it("cannot count impressions for an experiment that is not active", async () => {
    const draftId = await asAdmin(
      async (tx) =>
        (
          (await tx`SELECT id::text AS id FROM experiments WHERE slug = ${DRAFT_EXP}`) as {
            id: string;
          }[]
        )[0]?.id ?? "",
    );
    expect(
      await attempt(sql`INSERT INTO experiment_assignments (experiment_id, variant_label, visitor_id_hash)
                        VALUES (${draftId}::uuid, 'b', 'probe')`),
    ).toMatch(/row-level security/);
  });

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
    expect(await attempt(sql`SELECT id FROM experiment_pending_actions LIMIT 1`)).toMatch(
      /permission denied/,
    );
  });

  it("the registry holds only the gateway's operations — a plugin cannot reach the archive write", async () => {
    const registry = new OperationRegistry();
    registerGatewayOperations(registry);
    expect([...registry.names()].sort()).toEqual([
      "comment_archive.list_for_page",
      "experiments.get_active",
      "experiments.record_assignment",
    ]);
  });
});
