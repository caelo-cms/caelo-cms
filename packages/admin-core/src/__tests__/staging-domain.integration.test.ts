// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #650 — the protected staging domain, end to end on gcp-firebase
 * (real generator, real Postgres, an in-memory fake of the Firebase
 * Hosting REST API — no network, no credentials):
 *
 *   - Stage renders `https://staging.<domain>` into canonical / sitemap /
 *     robots, records a host-normalised parity manifest, points the gate at
 *     the new preview channel and retires the older ones; operators are
 *     shown the staging host, never the channel;
 *   - Publish live rebuilds with the live host, passes the parity guard,
 *     releases the rebuild on the live channel and retires the last
 *     preview;
 *   - a change merged after the Stage blocks Publish live and names the
 *     file;
 *   - the access settings ops and their §11.A proposals.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { deriveStagingCredential, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import * as realGoogleAuth from "google-auth-library";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

const realGoogleAuthExports = { ...realGoogleAuth };
mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "test-token" }) };
    }
  },
}));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const LIVE = "https://example.com";
const STAGING = "https://staging.example.com";
const GATE_SECRET = "integration-gate-secret";
const SITE = "test-site";
const API = "https://firebasehosting.googleapis.com/v1beta1/";
const UPLOAD = "https://upload.test/";

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "staging-domain-test",
};

const TPL_SLUG = "stg-domain-tpl";
const MOD_SLUG = "stg-domain-mod";
const PAGE_SLUG = "stg-domain-about";
const SLUGS = [PAGE_SLUG, "home"];

/** Just enough Firebase Hosting for Stage, Publish live and pruning. */
class FakeFirebase {
  versions = new Map<string, { config: unknown; files: Record<string, string> }>();
  channels = new Map<string, string>(); // channelId → url
  live: string[] = [];
  blobs = new Map<string, Buffer>();
  private seq = 0;

  body(versionName: string, path: string): string {
    const v = this.versions.get(versionName.split("/").pop() ?? "");
    const hash = v?.files[path];
    const gz = hash ? this.blobs.get(hash) : undefined;
    if (!gz) throw new Error(`no ${path} in ${versionName}`);
    return gunzipSync(gz).toString("utf8");
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(API) && !url.startsWith(UPLOAD)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    if (url.startsWith(UPLOAD)) {
      this.blobs.set(url.split("/").pop() ?? "", Buffer.from(init?.body as Uint8Array));
      return json({});
    }
    const [route = "", query = ""] = url.slice(API.length).split("?");
    const params = new URLSearchParams(query);
    if (method === "POST" && route === `sites/${SITE}/versions`) {
      const id = `v${++this.seq}`;
      this.versions.set(id, { config: parsed.config, files: {} });
      return json({ name: `sites/${SITE}/versions/${id}` });
    }
    const populate = route.match(/versions\/([^/:]+):populateFiles$/);
    if (populate) {
      const v = this.versions.get(populate[1] ?? "");
      if (!v) throw new Error("populate on unknown version");
      v.files = parsed.files;
      return json({
        uploadRequiredHashes: Object.values(v.files).filter((h) => !this.blobs.has(h)),
        uploadUrl: `${UPLOAD}${populate[1]}`,
      });
    }
    if (method === "PATCH" && /versions\/[^/]+$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${SITE}/channels`) {
      const id = params.get("channelId") ?? "";
      const channelUrl = `https://${SITE}--${id}-x1y2.web.app`;
      this.channels.set(id, channelUrl);
      return json({ name: `sites/${SITE}/channels/${id}`, url: channelUrl });
    }
    if (method === "GET" && route === `sites/${SITE}/channels`) {
      return json({
        channels: [...this.channels.keys(), "live"].map((id) => ({
          name: `sites/${SITE}/channels/${id}`,
        })),
      });
    }
    const channel = route.match(/^sites\/[^/]+\/channels\/([^/]+)$/);
    if (method === "DELETE" && channel) {
      this.channels.delete(channel[1] ?? "");
      return new Response("", { status: 200 });
    }
    if (method === "POST" && /channels\/[^/]+\/releases$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${SITE}/releases`) {
      this.live.unshift(params.get("versionName") ?? "");
      return json({});
    }
    throw new Error(`unhandled ${method} ${url}`);
  };
}

const realFetch = globalThis.fetch;
const fake = new FakeFirebase();
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;
let moduleId = "";
const ENV = {
  CAELO_PROVIDER: "gcp-firebase",
  CAELO_STAGING_GATE_SECRET: GATE_SECRET,
  CAELO_FIREBASE_SITE: SITE,
  CAELO_GATEWAY_SERVICE: "gateway",
  CAELO_GATEWAY_REGION: "europe-west1",
  CAELO_SKIP_STAGING_SERVE_CHECK: "1",
} as const;
const savedEnv: Record<string, string | undefined> = {};
let restoreSiteBaseUrl: (() => Promise<void>) | null = null;
let restoreSiteLanguage: (() => Promise<void>) | null = null;

async function withSql<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    return await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx);
    });
  } finally {
    await sql.end();
  }
}

async function wipe(): Promise<void> {
  await withSql(async (tx) => {
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM owner_settings_pending_actions`;
    await tx`UPDATE staging_access SET cookie_enabled = true, basic_auth_enabled = false,
               basic_auth_user = 'caelo', basic_auth_nonce = NULL, header_enabled = false,
               header_name = 'X-Caelo-Staging-Key', header_nonce = NULL, ip_allowlist = '{}',
               origin_url = NULL, origin_run_id = NULL, staging_host = NULL WHERE id = 1`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug IN ${tx(SLUGS)})`;
    await tx`DELETE FROM pages WHERE slug IN ${tx(SLUGS)}`;
    await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
    await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
  });
}

/** #553 — Publish live is gated on the staged build's audit; record a pass. */
async function markAudited(deployRunId: string): Promise<void> {
  await withSql(
    (tx) => tx`
      INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
      VALUES (${deployRunId}::uuid, ${SYSTEM.actorId}::uuid, 'passed',
              '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`,
  );
}

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function stagingRow() {
  return withSql(
    (tx) =>
      tx`SELECT origin_url, origin_run_id::text AS origin_run_id FROM staging_access WHERE id = 1`,
  ) as Promise<{ origin_url: string | null; origin_run_id: string | null }[]>;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  globalThis.fetch = fake.fetch as typeof fetch;
  await wipe();
  restoreSiteBaseUrl = await pinSiteBaseUrl(ADMIN_URL!, LIVE);
  restoreSiteLanguage = await pinSiteLanguage(ADMIN_URL!, "en");
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-staging-domain-"));
  // What the admin does at boot with CAELO_STAGING_HOST (provisioning's
  // staging host setting).
  expect(
    await ok<{ seeded: boolean }>("staging_access.seed_host", { host: "staging.example.com" }),
  ).toEqual({ seeded: true });

  const { templateId } = await ok<{ templateId: string }>("templates.create", {
    slug: TPL_SLUG,
    displayName: "T",
    html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    css: "",
  });
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  moduleId = (
    await ok<{ moduleId: string }>("modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>staged copy</p>",
      fields: [],
    })
  ).moduleId;
  for (const slug of SLUGS) {
    const { pageId } = await ok<{ pageId: string }>("pages.create", {
      slug,
      title: slug,
      templateId,
    });
    await ok("pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [moduleId] }],
    });
    await ok("pages.update", { pageId, status: "published" });
  }
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  mock.module("google-auth-library", () => realGoogleAuthExports);
  await wipe();
  await restoreSiteBaseUrl?.();
  await restoreSiteLanguage?.();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("Stage → Publish live with a protected staging domain (gcp-firebase)", () => {
  it("Stage renders the staging host, points the gate at the new channel and prunes older ones", async () => {
    const first = await ok<{ runId: string; previewUrl?: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    const second = await ok<{ runId: string; previewUrl?: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    // Operators and the AI are shown the staging host, never the channel.
    expect(second.previewUrl).toBe(`${STAGING}/`);

    const [run] = (await withSql(
      (tx) => tx`SELECT site_url, parity_manifest, publish_summary
                 FROM deploy_runs WHERE id = ${second.runId}::uuid`,
    )) as {
      site_url: string;
      parity_manifest: Record<string, string>;
      publish_summary: { location: string; previewUrl: string };
    }[];
    expect(run?.site_url).toBe(STAGING);
    expect(Object.keys(run?.parity_manifest ?? {})).toContain(`${PAGE_SLUG}/index.html`);
    expect(Object.keys(run?.parity_manifest ?? {})).not.toContain("robots.txt");

    const page = fake.body(run!.publish_summary.location, `/${PAGE_SLUG}/index.html`);
    expect(page).toContain(`${STAGING}/${PAGE_SLUG}/`);
    expect(page).not.toContain(`"${LIVE}/`);
    expect(fake.body(run!.publish_summary.location, "/sitemap.xml")).toContain(STAGING);

    const [row] = await stagingRow();
    expect(row?.origin_url).toBe(run!.publish_summary.previewUrl);
    expect(row?.origin_run_id).toBe(second.runId);
    // Only the current Stage's channel is left.
    expect([...fake.channels.keys()]).toEqual([`runid-${second.runId}`]);
    expect(first.runId).not.toBe(second.runId);
  });

  it("Publish live rebuilds with the live host, passes the parity guard and retires the preview", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const promoted = await ok<{ toRunId: string; buildId: string }>("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    // "Live matches staging" keeps working: the live run names the Stage.
    expect(promoted.buildId).toBe(staged.runId);
    const liveVersion = fake.live[0]!;
    const page = fake.body(liveVersion, `/${PAGE_SLUG}/index.html`);
    expect(page).toContain(`${LIVE}/${PAGE_SLUG}/`);
    expect(page).not.toContain("staging.example.com");
    expect(fake.body(liveVersion, "/robots.txt")).toContain(`Sitemap: ${LIVE}/sitemap.xml`);

    const [run] = (await withSql(
      (tx) => tx`SELECT status, site_url, publish_summary->>'location' AS location
                 FROM deploy_runs WHERE id = ${promoted.toRunId}::uuid`,
    )) as { status: string; site_url: string; location: string }[];
    expect(run).toEqual({ status: "succeeded", site_url: LIVE, location: liveVersion });
    // Nothing is staged any more; no public preview is left.
    expect(await stagingRow()).toEqual([{ origin_url: null, origin_run_id: null }]);
    expect(fake.channels.size).toBe(0);
  });

  it("a change merged after the Stage blocks Publish live and names the file", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const liveBefore = fake.live.length;
    await ok("modules.update", { moduleId, html: "<p>changed after the stage</p>" });
    const r = await execute(registry, adapter, SYSTEM, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(r.ok).toBe(false);
    const message = JSON.stringify(r.ok ? null : r.error);
    expect(message).toContain("Publish live stopped");
    expect(message).toContain(`${PAGE_SLUG}/index.html`);
    expect(message).toContain("Stage again");
    expect(fake.live.length).toBe(liveBefore);
    // The staged build stays served — nothing was published.
    expect((await stagingRow())[0]?.origin_run_id).toBe(staged.runId);
  });
});

describe("the staging host setting", () => {
  it("seeding never overwrites; set_host validates and the gateway-facing row follows", async () => {
    expect(
      await ok<{ seeded: boolean }>("staging_access.seed_host", { host: "other.example.com" }),
    ).toEqual({ seeded: false });
    for (const bad of ["example.com", "https://x.example.com", "nodot"]) {
      const r = await execute(registry, adapter, SYSTEM, "staging_access.set_host", { host: bad });
      expect(r.ok).toBe(false);
    }
    const proposal = await ok<{ proposalId: string; preview: { summary: string } }>(
      "owner_settings.propose_set_staging_host",
      { host: "Preview.Other-Domain.de" },
    );
    expect(proposal.preview.summary).toBe(
      "staging host: staging.example.com → preview.other-domain.de",
    );
    await ok("owner_settings.execute_proposal", { proposalId: proposal.proposalId });
    const v = await ok<{ stagingUrl: string; stagingHost: string }>("staging_access.get", {});
    expect(v).toMatchObject({
      stagingUrl: "https://preview.other-domain.de",
      stagingHost: "preview.other-domain.de",
    });
    const again = await execute(registry, adapter, SYSTEM, "staging_access.set_host", {
      host: "preview.other-domain.de",
    });
    expect(again.ok).toBe(false);
    const back = await ok<{ host: string; nextSteps: string }>("staging_access.set_host", {
      host: "staging.example.com",
    });
    expect(back.nextSteps).toContain(
      "cms-provision staging-domain enable --staging-domain staging.example.com",
    );
  });
});

describe("staging access settings", () => {
  it("get reports the staging URL and modes; credentials are for humans with settings.write only", async () => {
    const v = await ok<{ stagingUrl: string; settings: { cookieEnabled: boolean } }>(
      "staging_access.get",
      {},
    );
    expect(v.stagingUrl).toBe(STAGING);
    expect(v.settings.cookieEnabled).toBe(true);
    const r = await execute(registry, adapter, SYSTEM, "staging_access.get", {
      includeCredentials: true,
    });
    expect(r.ok).toBe(false);
  });

  it("set generates a credential on first enable, keeps it, validates, and rotate replaces it", async () => {
    await ok("staging_access.set", {
      cookieEnabled: true,
      basicAuthEnabled: true,
      basicAuthUser: "searchviu",
      headerEnabled: false,
      headerName: "X-Caelo-Staging-Key",
      ipAllowlist: ["198.51.100.0/24", " 2001:db8::/48 "],
    });
    const nonce = async () =>
      (
        (await withSql(
          (tx) => tx`SELECT basic_auth_nonce, header_nonce, ip_allowlist FROM staging_access`,
        )) as {
          basic_auth_nonce: string | null;
          header_nonce: string | null;
          ip_allowlist: string[];
        }[]
      )[0]!;
    const first = await nonce();
    expect(first.basic_auth_nonce).not.toBeNull();
    expect(first.header_nonce).toBeNull();
    expect(first.ip_allowlist).toEqual(["198.51.100.0/24", "2001:db8::/48"]);

    await ok("staging_access.set", {
      cookieEnabled: false,
      basicAuthEnabled: true,
      basicAuthUser: "searchviu",
      headerEnabled: false,
      headerName: "X-Caelo-Staging-Key",
      ipAllowlist: [],
    });
    expect((await nonce()).basic_auth_nonce).toBe(first.basic_auth_nonce);

    const bad = await execute(registry, adapter, SYSTEM, "staging_access.set", {
      cookieEnabled: false,
      basicAuthEnabled: false,
      basicAuthUser: "x",
      headerEnabled: false,
      headerName: "Authorization",
      ipAllowlist: ["not-an-ip"],
    });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad.ok ? null : bad.error)).toContain("not an IPv4/IPv6 address");

    await ok("staging_access.rotate_credentials", { which: "basic-auth" });
    const rotated = await nonce();
    expect(rotated.basic_auth_nonce).not.toBe(first.basic_auth_nonce);
    expect(
      await deriveStagingCredential(GATE_SECRET, "basic-auth", rotated.basic_auth_nonce!),
    ).not.toBe(await deriveStagingCredential(GATE_SECRET, "basic-auth", first.basic_auth_nonce!));
  });

  it("issue_open_link signs a short-lived link on the staging host — only while the cookie mode is on", async () => {
    const off = await execute(registry, adapter, SYSTEM, "staging_access.issue_open_link", {
      path: "/about/",
    });
    expect(off.ok).toBe(false);
    await ok("owner_settings.execute_proposal", {
      proposalId: (
        await ok<{ proposalId: string }>("owner_settings.propose_set_staging_access", {
          cookieEnabled: true,
        })
      ).proposalId,
    });
    const link = await ok<{ url: string }>("staging_access.issue_open_link", {
      path: "/about/",
    });
    expect(link.url.startsWith(`${STAGING}/_caelo/staging-access?t=open.`)).toBe(true);
    expect(link.url).toContain(`next=${encodeURIComponent("/about/")}`);
  });

  it("the §11.A proposals refuse no-op patches and apply rotations through execute_proposal", async () => {
    const noop = await execute(
      registry,
      adapter,
      SYSTEM,
      "owner_settings.propose_set_staging_access",
      { cookieEnabled: true },
    );
    expect(noop.ok).toBe(false);
    const before = (
      (await withSql((tx) => tx`SELECT header_nonce FROM staging_access`)) as {
        header_nonce: string | null;
      }[]
    )[0]?.header_nonce;
    const p = await ok<{ proposalId: string; preview: { summary: string } }>(
      "owner_settings.propose_rotate_staging_credentials",
      { which: "header", reason: "shared with a former contractor" },
    );
    expect(p.preview.summary).toContain("secret header");
    await ok("owner_settings.execute_proposal", { proposalId: p.proposalId });
    const after = (
      (await withSql((tx) => tx`SELECT header_nonce FROM staging_access`)) as {
        header_nonce: string | null;
      }[]
    )[0]?.header_nonce;
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it("keeps one staging credential rotation pending at a time, whichever credential (Codex review on #652)", async () => {
    const first = await ok<{ proposalId: string }>(
      "owner_settings.propose_rotate_staging_credentials",
      { which: "basic-auth", reason: "the crawler vendor changed" },
    );
    // A different reason (payload hash differs) and an overlapping kind.
    for (const which of ["basic-auth", "both", "header"] as const) {
      const again = await execute(
        registry,
        adapter,
        SYSTEM,
        "owner_settings.propose_rotate_staging_credentials",
        { which, reason: `another reason for ${which}` },
      );
      expect(again.ok).toBe(false);
      expect(JSON.stringify(again.ok ? null : again.error)).toContain(first.proposalId);
    }
    // The index holds it even past the op's read (a racing insert).
    let raced: unknown = null;
    try {
      await withSql(
        (
          tx,
        ) => tx`INSERT INTO owner_settings_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
                   VALUES ('rotate_staging_credentials', ${SYSTEM.actorId}::uuid,
                           '{"which":"header","reason":"raced past the read"}'::jsonb, '{}'::jsonb,
                           'pending', 'race-hash')`,
      );
    } catch (e) {
      raced = e;
    }
    expect(String(raced)).toContain("one_staging_rotation_uniq");
    await withSql(
      (tx) => tx`DELETE FROM owner_settings_pending_actions WHERE id = ${first.proposalId}::uuid`,
    );
  });
});
