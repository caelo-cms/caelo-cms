// SPDX-License-Identifier: MPL-2.0

/**
 * #1330 / #1331 — the staging gateway end to end on real Postgres: the
 * admin publishes the gate, its key and the served build into
 * cms_public_staging only; a gateway running as public_staging_role serves
 * the staged files behind the gate on every host, and nothing of it reaches
 * the live database.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishProjectionOnce, stagingPublicAdapter } from "@caelo-cms/admin-core";
import { DatabaseAdapter } from "@caelo-cms/query-api";
import {
  SESSION_ENTRY,
  sessionCookieValue,
  signStagingToken,
  stagedManifestKey,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import {
  handleRequest,
  invalidateGatewaySettings,
  setGatewayAdapter,
  setStagingSite,
} from "./server.js";
import { directoryStagingStorage } from "./staging/storage.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_ADMIN_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
const STAGING_ROLE_URL = process.env.PUBLIC_STAGING_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_ADMIN_URL || !STAGING_ROLE_URL) {
  throw new Error("DB URLs required");
}

const GATE_SECRET = "staging-site-int-gate-secret";
const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-00000000ffff";
const RUN_ID = "0b7c0d6e-1330-4330-8330-133013301330";
const LOCATION = `builds/${RUN_ID}`;

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let gateway: DatabaseAdapter;
let root: string;
const savedSecret = process.env.CAELO_STAGING_GATE_SECRET;

async function asSystem(url: string, fn: (tx: SQL) => Promise<unknown>): Promise<unknown> {
  const sql = new SQL(url);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function publish(): Promise<void> {
  await publishProjectionOnce(adapter, staging, { declarations: new Map() });
  invalidateGatewaySettings();
}

beforeAll(async () => {
  process.env.CAELO_TRUSTED_PROXY_HOPS = "1";
  process.env.CAELO_STAGING_GATE_SECRET = GATE_SECRET;
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_ADMIN_URL);
  gateway = new DatabaseAdapter({
    adminDatabaseUrl: null,
    publicDatabaseUrl: STAGING_ROLE_URL,
    publicDatabase: "cms_public_staging",
    expectedRoles: { admin: null, public: ["public_staging_role"] },
  });
  // A staged build as a self-hosted Stage leaves it: the run's directory
  // and its manifest next to it.
  root = await mkdtemp(join(tmpdir(), "caelo-staging-site-"));
  await mkdir(join(root, LOCATION, "about"), { recursive: true });
  await writeFile(
    join(root, LOCATION, "about", "index.html"),
    '<a href="https://example.com/">home</a>',
  );
  await writeFile(
    join(root, stagedManifestKey(LOCATION)),
    JSON.stringify({
      version: 1,
      runId: RUN_ID,
      pageUrlStyle: "directory",
      files: { "about/index.html": { type: "text/html; charset=utf-8", hash: RUN_ID } },
    }),
  );
  await asSystem(ADMIN_URL, async (tx) => {
    const targets = (await tx`SELECT id FROM deploy_targets WHERE name = 'staging'`) as {
      id: string;
    }[];
    await tx`INSERT INTO deploy_runs (id, target_id, actor_id, status, site_url, finished_at)
             VALUES (${RUN_ID}::uuid, ${targets[0]?.id}::uuid, ${SYSTEM_ACTOR_ID}::uuid,
                     'succeeded', 'https://example.com', now())
             ON CONFLICT (id) DO NOTHING`;
    await tx`UPDATE staging_access SET staging_host = 'staging.example.com', cookie_enabled = true,
               origin_run_id = ${RUN_ID}::uuid, served_location = ${LOCATION} WHERE id = 1`;
  });
  await publish();
  setGatewayAdapter(gateway);
  setStagingSite(directoryStagingStorage(root));
});

afterAll(async () => {
  setStagingSite(null);
  await asSystem(ADMIN_URL, async (tx) => {
    await tx`UPDATE staging_access SET staging_host = NULL, origin_run_id = NULL,
               served_location = NULL WHERE id = 1`;
    await tx`DELETE FROM deploy_runs WHERE id = ${RUN_ID}::uuid`;
  });
  await publish();
  if (savedSecret === undefined) delete process.env.CAELO_STAGING_GATE_SECRET;
  else process.env.CAELO_STAGING_GATE_SECRET = savedSecret;
  await rm(root, { recursive: true, force: true });
  await adapter.close();
  await staging.close();
  await gateway.close();
});

const req = (host: string, path: string, headers: Record<string, string> = {}) =>
  new Request(`https://${host}${path}`, {
    headers: { "x-forwarded-for": "198.51.100.7", ...headers },
  });

describe("#1330 the staging gateway on real Postgres", () => {
  it("publishes the gate key and the served build into the staging database only", async () => {
    const read = async (url: string) =>
      (await asSystem(
        url,
        (tx) => tx`SELECT gate_secret, served_location, build_origin FROM published_staging_site`,
      )) as { gate_secret: string; served_location: string; build_origin: string }[];
    expect(await read(STAGING_ADMIN_URL)).toEqual([
      { gate_secret: GATE_SECRET, served_location: LOCATION, build_origin: "https://example.com" },
    ]);
    expect(await read(PUBLIC_URL)).toEqual([]);
    // The staging database takes plugin posts from the staging origin only.
    const settings = (await asSystem(
      STAGING_ADMIN_URL,
      (tx) => tx`SELECT live_origins FROM published_gateway_settings`,
    )) as { live_origins: string[] }[];
    expect(settings[0]?.live_origins ?? []).toEqual(
      settings.length ? ["https://staging.example.com"] : [],
    );
  });

  it("serves nothing without the gate, on the staging host and on run.app alike", async () => {
    for (const host of ["staging.example.com", "caelo-production-staging-gateway-x.a.run.app"]) {
      const r = await handleRequest(req(host, "/about/"));
      expect(r.status).toBe(403);
      expect(await r.text()).not.toContain("home");
    }
    expect((await handleRequest(req("x.a.run.app", "/healthz"))).status).toBe(200);
  });

  it("serves the staged page behind the gate, rewritten to the staging host", async () => {
    const token = await signStagingToken(
      GATE_SECRET,
      "session",
      Math.floor(Date.now() / 1000) + 600,
    );
    const cookie = `__session=${sessionCookieValue(
      new Map([
        [SESSION_ENTRY.staging, { value: token, expiresAt: Math.floor(Date.now() / 1000) + 600 }],
      ]),
    )}`;
    const r = await handleRequest(
      req("caelo-production-staging-gateway-x.a.run.app", "/about/", { cookie }),
    );
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('<a href="https://staging.example.com/">home</a>');
    expect(r.headers.get("x-robots-tag")).toBe("noindex");
  });

  it("the gate key changes nothing for the admin: an access change is published at once", async () => {
    await asSystem(
      ADMIN_URL,
      (tx) => tx`UPDATE staging_access SET cookie_enabled = false WHERE id = 1`,
    );
    await publish();
    const token = await signStagingToken(
      GATE_SECRET,
      "session",
      Math.floor(Date.now() / 1000) + 600,
    );
    const cookie = `__session=${sessionCookieValue(
      new Map([
        [SESSION_ENTRY.staging, { value: token, expiresAt: Math.floor(Date.now() / 1000) + 600 }],
      ]),
    )}`;
    expect((await handleRequest(req("staging.example.com", "/about/", { cookie }))).status).toBe(
      403,
    );
    await asSystem(
      ADMIN_URL,
      (tx) => tx`UPDATE staging_access SET cookie_enabled = true WHERE id = 1`,
    );
    await publish();
  });
});
