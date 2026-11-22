// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1644 (#1651, #1340) — the site search's `record` operation is a
 * declaration the gateway runs, no plugin code. A visitor's search is kept
 * only while the Owner turned counting on (the switch the admin projects),
 * text that looks like personal data is dropped before storage, a filled
 * honeypot stores nothing, and every one of those answers the same, so a
 * client cannot tell what was kept. Runs the real plugin on the gateway's
 * own database identity, with the proof-of-work the runtime solves.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
  drainProjectionOnce,
  registerAdminOps,
  releaseProjectionForTests,
  stagingPublicAdapter,
} from "@caelo-cms/admin-core";
import {
  bootstrap,
  bootstrapDispatchOnly,
  releaseManifestDigest,
  resetDispatchOnlyHost,
  resetPluginHost,
} from "@caelo-cms/plugin-host";
import { manifestFromDefinition } from "@caelo-cms/plugin-sdk";
import siteSearch from "@caelo-cms/plugin-site-search";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import { SQL } from "bun";
import {
  GATEWAY_DATABASE_ROLES,
  gatewayDatabaseUrls,
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
} from "./server.js";
import { registerTestLiveOrigin, TEST_LIVE_ORIGIN } from "./test-support.js";

const STAGING_ADAPTER = stagingPublicAdapter(process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL ?? "");
const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_ADMIN_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_ADMIN_URL || !PUBLIC_URL) {
  throw new Error(
    "ADMIN_DATABASE_URL, PUBLIC_ADMIN_DATABASE_URL and PUBLIC_DATABASE_URL are required",
  );
}

const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const SLUG = "site-search";
const SCHEMA = "plugin_site_search";
const RECORD = `/api/plugin/${SLUG}/record`;

let adminAdapter: DatabaseAdapter;
let gatewayAdapter: DatabaseAdapter;
let pluginId = "";
let before: {
  status: string;
  approved_capabilities: string[] | null;
  approved_manifest_digest: string | null;
} | null = null;
let captchaBefore: { captcha_provider: string; captcha_pow_target_prefix: string } | undefined;

async function onDb<T>(url: string, fn: (tx: SQL) => Promise<T>, pluginScope?: string): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      if (pluginScope) await tx`SELECT set_config('caelo.plugin_id', ${pluginScope}, true)`;
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** The Owner's counting switch, released as a Stage plus Publish live does. */
async function setCounting(on: boolean): Promise<void> {
  await onDb(
    ADMIN_URL as string,
    async (tx) => {
      await tx.unsafe(`DELETE FROM ${SCHEMA}.public_settings`);
      await tx.unsafe(`INSERT INTO ${SCHEMA}.public_settings (counting) VALUES (${on})`);
    },
    pluginId,
  );
  await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER, undefined, "as-loaded");
  invalidateGatewaySettings();
}

let client = 0;

/** A visitor's call from its own address, with the proof the runtime solves. */
async function record(body: Record<string, unknown>, withProof = true): Promise<Response> {
  client++;
  const ip = `203.0.113.${client % 250}`;
  let proof: Record<string, unknown> = {};
  if (withProof) {
    const c = await handleRequest(
      new Request("http://localhost/api/captcha/challenge", { headers: { "X-Forwarded-For": ip } }),
    );
    expect(c.status).toBe(200);
    const { challenge, target } = (
      (await c.json()) as { data: { challenge: string; target: string } }
    ).data;
    let nonce = 0;
    while (
      !new Bun.CryptoHasher("sha256")
        .update(`${challenge}|${SLUG}.record|${nonce}`)
        .digest("hex")
        .startsWith(target)
    )
      nonce++;
    proof = { _caelo_captcha: { challenge, nonce: String(nonce) } };
  }
  return handleRequest(
    new Request(`http://localhost${RECORD}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: TEST_LIVE_ORIGIN,
        "X-Forwarded-For": ip,
      },
      body: JSON.stringify({ ...body, ...proof }),
    }),
  );
}

async function stored(): Promise<
  { kind: string; text: string; previous: string | null; day: string }[]
> {
  return onDb(
    PUBLIC_ADMIN_URL as string,
    async (tx) =>
      (await tx.unsafe(
        `SELECT kind, text, previous, day::text AS day FROM ${SCHEMA}.search_events ORDER BY created_at`,
      )) as { kind: string; text: string; previous: string | null; day: string }[],
    pluginId,
  );
}

async function clearEvents(): Promise<void> {
  await onDb(
    PUBLIC_ADMIN_URL as string,
    async (tx) => {
      await tx.unsafe(`DELETE FROM ${SCHEMA}.search_events`);
    },
    pluginId,
  );
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "1";
  // The Owner activates this build of the plugin and approves what it asks
  // for; a changed manifest is a new artifact (#1332).
  const manifest = manifestFromDefinition(siteSearch);
  before = await onDb(ADMIN_URL as string, async (tx) => {
    const rows = (await tx`SELECT status, approved_capabilities, approved_manifest_digest
        FROM plugins WHERE slug = ${SLUG}`) as NonNullable<typeof before>[];
    await tx`UPDATE plugins SET status = 'active',
      approved_capabilities = ARRAY(SELECT jsonb_array_elements_text(
        (${JSON.stringify(manifest.requestedCapabilities ?? [])}::text)::jsonb)),
      approved_manifest_digest = ${releaseManifestDigest(manifest)}
      WHERE slug = ${SLUG}`;
    const [c] = (await tx`SELECT captcha_provider, captcha_pow_target_prefix
        FROM site_settings WHERE id = 1`) as NonNullable<typeof captchaBefore>[];
    captchaBefore = c;
    // One hex digit keeps the proof cheap in a test; the runtime solves the same.
    await tx`UPDATE site_settings SET captcha_provider = 'pow', captcha_pow_target_prefix = '0' WHERE id = 1`;
    return rows[0] ?? null;
  });

  adminAdapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL,
    publicDatabaseUrl: PUBLIC_ADMIN_URL,
  });
  // The plugin's list types are stored through the admin's own ops.
  const adminRegistry = new OperationRegistry();
  registerAdminOps(adminRegistry);
  const report = await bootstrap({
    infra: {
      adapter: adminAdapter,
      registry: adminRegistry,
      stagingAdapter: STAGING_ADAPTER,
    },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: siteSearch }],
  });
  expect(report.failed).toEqual([]);
  pluginId = await onDb(
    ADMIN_URL as string,
    async (tx) =>
      ((await tx`SELECT id::text AS id FROM plugins WHERE slug = ${SLUG}`) as { id: string }[])[0]
        ?.id ?? "",
  );
  await registerTestLiveOrigin(ADMIN_URL as string);
  await drainProjectionOnce(adminAdapter, STAGING_ADAPTER);
  await setCounting(true);
  resetPluginHost();

  const urls = gatewayDatabaseUrls({
    PUBLIC_DATABASE_URL: PUBLIC_URL,
    CAELO_GATEWAY_ENVIRONMENT: "live",
  });
  gatewayAdapter = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: urls.public,
    expectedRoles: GATEWAY_DATABASE_ROLES,
  });
  await gatewayAdapter.verifyRoles();
  setGatewayAdapter(gatewayAdapter);
  invalidateGatewaySettings();
  const gw = await bootstrapDispatchOnly({
    infra: { adapter: gatewayAdapter, registry: new OperationRegistry() },
    pluginsRoot: "/dev/null/unused",
    systemActorId: SYSTEM_ACTOR_ID,
    testPlugins: [{ definition: siteSearch }],
  });
  expect(gw.loaded.map((p) => p.slug)).toEqual([SLUG]);
  await clearEvents();
});

afterAll(async () => {
  await clearEvents();
  await onDb(
    ADMIN_URL as string,
    async (tx) => {
      await tx.unsafe(`DELETE FROM ${SCHEMA}.public_settings`);
    },
    pluginId,
  );
  await onDb(ADMIN_URL as string, async (tx) => {
    await tx`UPDATE site_settings SET captcha_provider = ${captchaBefore?.captcha_provider ?? "pow"},
      captcha_pow_target_prefix = ${captchaBefore?.captcha_pow_target_prefix ?? "000fff"} WHERE id = 1`;
    if (before) {
      const approved = JSON.stringify(before.approved_capabilities);
      await tx`UPDATE plugins SET status = ${before.status},
        approved_capabilities = CASE WHEN (${approved}::text)::jsonb = 'null'::jsonb THEN NULL
          ELSE ARRAY(SELECT jsonb_array_elements_text((${approved}::text)::jsonb)) END,
        approved_manifest_digest = ${before.approved_manifest_digest}
        WHERE slug = ${SLUG}`;
    } else {
      // This file created the row: take it out again, with what it brought.
      await tx`DELETE FROM site_snapshots WHERE actor_id IN (SELECT id FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG}))`;
      await tx`DELETE FROM actors WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM list_types WHERE plugin_id IN (SELECT id FROM plugins WHERE slug = ${SLUG})`;
      await tx`DELETE FROM plugins WHERE slug = ${SLUG}`;
    }
  });
  await releaseProjectionForTests(adminAdapter, STAGING_ADAPTER, undefined, "as-loaded");
  resetDispatchOnlyHost();
  resetPluginHost();
  await gatewayAdapter?.close();
  await adminAdapter?.close();
});

describe("site search `record`, declared and run by the gateway (#1340)", () => {
  it("keeps a search with the query before it, trimmed and dated today", async () => {
    await clearEvents();
    const r = await record({
      kind: "search",
      text: "  rabatte  ",
      lang: "de",
      results: 1,
      previous: "rabat",
      website: "",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "search", text: "rabatte", previous: "rabat" });
    expect(rows[0]?.day).toBe(new Date().toISOString().slice(0, 10));
  });

  it("a first search names no query before it", async () => {
    await clearEvents();
    const r = await record({ kind: "search", text: "kontakt", lang: "de", results: 1 });
    expect(r.status).toBe(200);
    expect((await stored()).map((e) => e.previous)).toEqual([null]);
  });

  it("drops what looks like personal data, with the same answer", async () => {
    await clearEvents();
    for (const text of ["max@example.com", "+49 170 1234567", "4111111111111111"]) {
      const r = await record({ kind: "search", text, lang: "de", results: 0 });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    }
    expect(await stored()).toEqual([]);
  });

  it("drops a search whose query before looks like personal data", async () => {
    await clearEvents();
    const r = await record({
      kind: "search",
      text: "preise",
      lang: "de",
      results: 1,
      previous: "max@example.com",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    expect(await stored()).toEqual([]);
  });

  it("a filled honeypot stores nothing and answers the same", async () => {
    await clearEvents();
    const r = await record({
      kind: "search",
      text: "preise",
      lang: "de",
      results: 1,
      website: "x",
    });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
    expect(await stored()).toEqual([]);
  });

  it("refuses a field the declaration does not name, and a call without proof", async () => {
    await clearEvents();
    const extra = await record({
      kind: "search",
      text: "preise",
      lang: "de",
      results: 1,
      ip: "1.2.3.4",
    });
    expect(extra.status).toBe(400);
    const unproven = await record(
      { kind: "search", text: "preise", lang: "de", results: 1 },
      false,
    );
    expect(unproven.status).toBe(403);
    expect(await stored()).toEqual([]);
  });

  it("keeps nothing while counting is off, and says so no differently", async () => {
    await clearEvents();
    await setCounting(false);
    try {
      const r = await record({
        kind: "click",
        text: "preise",
        lang: "de",
        results: 1,
        target: "/preise/",
      });
      expect(r.status).toBe(200);
      expect(((await r.json()) as { data: unknown }).data).toEqual({ recorded: true });
      expect(await stored()).toEqual([]);
    } finally {
      await setCounting(true);
    }
  });
});
