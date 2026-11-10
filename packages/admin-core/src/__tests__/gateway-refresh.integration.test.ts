// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's refresh pings to the gateways (gateway-refresh.ts), on real
 * Postgres: a publish that wrote a gateway's database pings that gateway,
 * on the CPU of the write's own request, at the URL the admin knows for it
 * and with an ID token for its audience; every outcome is recorded and
 * shown with the gateway settings; a failed ping never fails the publish.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import {
  GATEWAY_REFRESH_TOKEN_HEADER,
  type GatewayRefreshTarget,
  gatewayRefreshAudience,
} from "@caelo-cms/shared";
import { SQL } from "bun";
import { createGatewayRefresher } from "../gateway-refresh.js";
import { getGatewaySettingsOp } from "../ops/gateway.js";
import { gatewayRefreshTargetsOp, recordGatewayRefreshOp } from "../ops/gateway-refresh.js";
import { rotateStagingCredentialsOp } from "../ops/staging_access.js";
import { createPublicProjectionPublisher, stagingPublicAdapter } from "../public-projection.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const SYSTEM = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system" as const,
  requestId: "gateway-refresh-test",
};
const GCP = { CAELO_PROVIDER: "gcp", CAELO_ENV: "test" };
const LIVE_URL = "https://site.example/api/_caelo/refresh";
const STAGING_PING_URL = "https://staging.site.example/api/_caelo/refresh";

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
const registry = new OperationRegistry();
registry.register(gatewayRefreshTargetsOp);
registry.register(recordGatewayRefreshOp);
let saved: { base: string | null; host: string | null };

async function admin<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    return (await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await sql.end();
  }
}

/** A fetch that records each ping and answers what `answer` says per URL. */
function fakeGateways(
  answer: (url: string) => Response | Error = () => Response.json({ ok: true }),
) {
  const pings: { url: string; method: string; token: string | null }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    pings.push({
      url,
      method: init?.method ?? "GET",
      token: headers.get(GATEWAY_REFRESH_TOKEN_HEADER),
    });
    const a = answer(url);
    if (a instanceof Error) throw a;
    return a;
  }) as typeof fetch;
  return { pings, fetchImpl };
}

const tokenFor = async (audience: string) => `id-token-for:${audience}`;

async function recorded() {
  const r = await adapter.runOperation(getGatewaySettingsOp, SYSTEM, {});
  if (!r.ok) throw new Error("gateway.get_settings failed");
  const byTarget = new Map(r.value.refreshPings.map((p) => [p.target, p]));
  return (t: GatewayRefreshTarget) => byTarget.get(t);
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_URL);
  saved = await admin(async (tx) => {
    const [d] = (await tx`SELECT site_base_url FROM site_defaults WHERE id = 1`) as {
      site_base_url: string | null;
    }[];
    const [s] = (await tx`SELECT staging_host FROM staging_access WHERE id = 1`) as {
      staging_host: string | null;
    }[];
    return { base: d?.site_base_url ?? null, host: s?.staging_host ?? null };
  });
});

beforeEach(async () => {
  await admin(async (tx) => {
    await tx`UPDATE site_defaults SET site_base_url = 'https://site.example' WHERE id = 1`;
    await tx`UPDATE staging_access SET staging_host = 'staging.site.example' WHERE id = 1`;
    await tx`DELETE FROM gateway_refresh_state`;
  });
});

afterAll(async () => {
  await admin(async (tx) => {
    await tx`UPDATE site_defaults SET site_base_url = ${saved.base} WHERE id = 1`;
    await tx`UPDATE staging_access SET staging_host = ${saved.host} WHERE id = 1`;
    await tx`DELETE FROM gateway_refresh_state`;
  });
  await adapter.close();
  await staging.close();
});

describe("the admin's refresh pings", () => {
  it("an op that changes what a gateway serves pings it before the op returns", async () => {
    const gateways = fakeGateways();
    const refresher = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: tokenFor,
      fetch: gateways.fetchImpl,
    });
    expect(refresher).not.toBeNull();
    const publisher = createPublicProjectionPublisher({
      adapter,
      stagingAdapter: staging,
      declarations: () => new Map(),
      ...(refresher ? { afterPublish: refresher } : {}),
    });
    try {
      // The staging gate's credentials are published to the staging
      // gateway's database: the write's own drain publishes and pings.
      const result = await adapter.runOperation(rotateStagingCredentialsOp, SYSTEM, {
        which: "both",
      });
      expect(result.ok).toBe(true);
      const staged = gateways.pings.find((p) => p.url === STAGING_PING_URL);
      expect(staged).toEqual({
        url: STAGING_PING_URL,
        method: "POST",
        token: `id-token-for:${gatewayRefreshAudience("test", "staging")}`,
      });
      // Any other ping went to the live gateway, with the live audience.
      for (const p of gateways.pings.filter((p) => p.url !== STAGING_PING_URL)) {
        expect(p).toEqual({
          url: LIVE_URL,
          method: "POST",
          token: `id-token-for:${gatewayRefreshAudience("test", "live")}`,
        });
      }
      const of = await recorded();
      expect(of("staging")).toMatchObject({ url: STAGING_PING_URL, lastError: null });
      expect(of("staging")?.lastOkAt).not.toBeNull();
    } finally {
      publisher.stop();
    }
  });

  it("pings each gateway whose database a publish wrote, and nothing for a publish that wrote neither", async () => {
    const gateways = fakeGateways();
    const refresher = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: tokenFor,
      fetch: gateways.fetchImpl,
    });
    await refresher?.({ sections: { live: [], staging: [] } });
    expect(gateways.pings).toEqual([]);
    await refresher?.({ sections: { live: ["plugins"], staging: [] } });
    expect(gateways.pings.map((p) => p.url)).toEqual([LIVE_URL]);
    await refresher?.({ sections: { live: ["settings"], staging: ["staging_site"] } });
    expect(gateways.pings.map((p) => p.url).sort()).toEqual([LIVE_URL, LIVE_URL, STAGING_PING_URL]);
  });

  it("records a gateway that refuses or does not answer, never throws, and keeps the last miss on record", async () => {
    const refusing = fakeGateways((url) =>
      url === LIVE_URL
        ? new Response("not found", { status: 404 })
        : new Error("connect ETIMEDOUT"),
    );
    const refresher = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: tokenFor,
      fetch: refusing.fetchImpl,
    });
    await refresher?.({ sections: { live: ["plugins"], staging: ["plugins"] } });
    let of = await recorded();
    expect(of("live")?.lastError).toContain("refused the ping (HTTP 404)");
    expect(of("live")?.lastOkAt).toBeNull();
    expect(of("staging")?.lastError).toBe("the gateway did not answer: connect ETIMEDOUT");

    const answering = fakeGateways();
    const later = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: tokenFor,
      fetch: answering.fetchImpl,
    });
    await later?.({ sections: { live: ["plugins"], staging: [] } });
    of = await recorded();
    const live = of("live");
    expect(live?.lastOkAt).not.toBeNull();
    // The miss stays on record, older than the success.
    expect(live?.lastError).toContain("HTTP 404");
    expect(new Date(live?.lastErrorAt ?? 0) <= new Date(live?.lastOkAt ?? 0)).toBe(true);
  });

  it("records a token the metadata server would not mint, and a live site without a base URL", async () => {
    const gateways = fakeGateways();
    const noToken = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: async () => {
        throw new Error("the metadata server answered HTTP 404");
      },
      fetch: gateways.fetchImpl,
    });
    await noToken?.({ sections: { live: ["plugins"], staging: [] } });
    expect(gateways.pings).toEqual([]);
    expect((await recorded())("live")?.lastError).toBe(
      "no ID token for the ping: the metadata server answered HTTP 404",
    );

    await admin(async (tx) => {
      await tx`UPDATE site_defaults SET site_base_url = NULL WHERE id = 1`;
      await tx`UPDATE staging_access SET staging_host = NULL WHERE id = 1`;
    });
    const refresher = createGatewayRefresher({
      adapter,
      registry,
      env: GCP,
      idToken: tokenFor,
      fetch: gateways.fetchImpl,
    });
    await refresher?.({ sections: { live: ["plugins"], staging: ["plugins"] } });
    expect(gateways.pings).toEqual([]);
    const of = await recorded();
    expect(of("live")?.lastError).toContain("the live site has no base URL");
    // No staging host: the staging gateway is off and stays off, nothing to tell it.
    expect(of("staging")).toBeUndefined();
  });

  it("pings only where the gateways run on request-billed CPU", () => {
    for (const env of [{}, { CAELO_PROVIDER: "self-hosted" }, { CAELO_PROVIDER: "aws" }]) {
      expect(createGatewayRefresher({ adapter, registry, env })).toBeNull();
    }
    for (const provider of ["gcp", "gcp-firebase"]) {
      expect(
        createGatewayRefresher({ adapter, registry, env: { CAELO_PROVIDER: provider } }),
      ).not.toBeNull();
    }
  });
});
