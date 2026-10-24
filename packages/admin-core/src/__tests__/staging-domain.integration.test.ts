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
 *   - the access settings ops and their §11.A proposals;
 *   - #969: the served preview is kept alive by TTL refreshes (Stage,
 *     Publish live, deploy.refresh_staging_preview) — the fake refuses the
 *     expireTime clear exactly like the live API.
 */

import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import { CAELO_VERSION, deriveStagingCredential, type ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import * as realGoogleAuth from "google-auth-library";
import { STAGING_PUBLICATION_LOCK_KEY } from "../deploy/staging-publication-lock.js";
import { SERVED_PREVIEW_CHANNEL_TTL } from "../deploy/static-publisher-firebase.js";
import { setDeployBridge } from "../ops/deploy.js";
import { configureMcpBridge } from "../ops/security/mcp_tokens.js";
import { registerAdminOps } from "../register.js";
import { FakeChannelLifetimes } from "./fixtures/firebase-channel-lifetime.js";
import { ensureRoleUser } from "./fixtures/role-user.js";
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
const DAY_MS = 24 * 60 * 60 * 1000;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "staging-domain-test",
};

const TPL_SLUG = "stg-domain-tpl";
const MOD_SLUG = "stg-domain-mod";
const PAGE_SLUG = "stg-domain-about";
const DRAFT_SLUG = "stg-domain-draft";
const SLUGS = [PAGE_SLUG, "home", DRAFT_SLUG];
/** #678 — an Owner and an Editor driving the Power-MCP surface. */
const OWNER_ID = "00000000-0000-0000-0000-0000000678a1";
const EDITOR_ID = "00000000-0000-0000-0000-0000000678a2";

/** Just enough Firebase Hosting for Stage, Publish live and pruning. */
class FakeFirebase {
  versions = new Map<string, { config: unknown; files: Record<string, string> }>();
  channels = new Map<string, string>(); // channelId → url
  /** When each channel expires, as the live API keeps it (#969). */
  lifetimes = new FakeChannelLifetimes();
  live: string[] = [];
  blobs = new Map<string, Buffer>();
  /** #1003 — runs while a Stage uploads (populateFiles), i.e. mid-run. */
  onPopulate: (() => Promise<void>) | null = null;
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
      await this.onPopulate?.();
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
      this.lifetimes.create(id, parsed.ttl);
      return json({ name: `sites/${SITE}/channels/${id}`, url: channelUrl });
    }
    if (method === "GET" && route === `sites/${SITE}/channels`) {
      return json({
        channels: [...this.channels.keys(), "live"].map((id) => ({
          name: `sites/${SITE}/channels/${id}`,
          expireTime: this.lifetimes.expireTime(id),
        })),
      });
    }
    const channel = route.match(/^sites\/[^/]+\/channels\/([^/]+)$/);
    if (method === "DELETE" && channel) {
      this.channels.delete(channel[1] ?? "");
      this.lifetimes.forget(channel[1] ?? "");
      return new Response("", { status: 200 });
    }
    if (method === "GET" && channel) {
      if (!this.channels.has(channel[1] ?? "")) return new Response("{}", { status: 404 });
      return json({
        name: `sites/${SITE}/channels/${channel[1]}`,
        expireTime: this.lifetimes.expireTime(channel[1] ?? ""),
      });
    }
    if (method === "PATCH" && channel) {
      // The live API would implicitly create a missing channel; Caelo must not.
      if (!this.channels.has(channel[1] ?? "")) throw new Error("patch on unknown channel");
      return this.lifetimes.patch(SITE, channel[1] ?? "", params.get("updateMask"), parsed);
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
    await tx`DELETE FROM mcp_tokens WHERE actor_id IN (${OWNER_ID}::uuid, ${EDITOR_ID}::uuid)`;
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
  for (const slug of [PAGE_SLUG, "home"]) {
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
    // Builds refuse published pages without a meta description.
    await ok("pages_seo.autofill", { pageId, metaDescription: `The ${slug} page.` });
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
    // Only the current Stage's channel is left, refreshed to the 30-day
    // maximum: staging must not turn into a 404 after an idle week (#969 —
    // with the live API's refusal of the expireTime clear in the fake).
    expect([...fake.channels.keys()]).toEqual([`runid-${second.runId}`]);
    expect(fake.lifetimes.remainingMs(`runid-${second.runId}`)).toBeGreaterThan(29 * DAY_MS);
    expect(first.runId).not.toBe(second.runId);
  });

  it("Publish live rebuilds with the live host, passes the parity guard and keeps staging on the published build", async () => {
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
    // Staging keeps serving the build that just went live instead of
    // answering every page with "nothing staged"; only its channel is left.
    const [stagedRun] = (await withSql(
      (tx) => tx`SELECT publish_summary->>'previewUrl' AS preview_url
                 FROM deploy_runs WHERE id = ${staged.runId}::uuid`,
    )) as { preview_url: string }[];
    expect(await stagingRow()).toEqual([
      { origin_url: stagedRun!.preview_url, origin_run_id: staged.runId },
    ]);
    expect([...fake.channels.keys()]).toEqual([`runid-${staged.runId}`]);
  });

  it("#1003 a Stage and a Publish live record where their time went, step by step", async () => {
    type TimedRun = {
      phase_timings: { phase: string; ms: number }[];
      publish_summary: Record<string, unknown>;
      took_ms: number;
    };
    const timedRun = async (runId: string): Promise<TimedRun> => {
      const [run] = (await withSql(
        (tx) => tx`SELECT phase_timings, publish_summary,
                          (EXTRACT(EPOCH FROM finished_at - started_at) * 1000)::int AS took_ms
                   FROM deploy_runs WHERE id = ${runId}::uuid`,
      )) as TimedRun[];
      if (!run) throw new Error(`no deploy run ${runId}`);
      return run;
    };
    const topLevel = (r: TimedRun) =>
      r.phase_timings.map((p) => p.phase).filter((p) => !p.includes("."));
    const names = (r: TimedRun) => r.phase_timings.map((p) => p.phase);

    const staged = await ok<{ runId: string; phases: { phase: string; ms: number }[] }>(
      "deploy.trigger",
      { targetName: "staging", repoRoot: testRoot },
    );
    const stageRun = await timedRun(staged.runId);
    expect(staged.phases).toEqual(stageRun.phase_timings);
    expect(topLevel(stageRun)).toEqual([
      "prepare",
      "generator",
      "lock-wait",
      "publish",
      "parity",
      "select-preview",
      "finish",
    ]);
    // The generator's passes and the upload's steps come along as breakdowns.
    expect(names(stageRun)).toEqual(
      expect.arrayContaining([
        "generator.load-pages",
        "generator.compose",
        "generator.media",
        "generator.write",
        "publish.hash",
        "publish.populate",
        "publish.upload",
        "publish.channel",
      ]),
    );
    // started_at / finished_at are real clock times, not the transaction
    // start twice: the run's span covers its steps.
    const stepsMs = stageRun.phase_timings
      .filter((p) => !p.phase.includes("."))
      .reduce((n, p) => n + p.ms, 0);
    expect(stageRun.took_ms).toBeGreaterThan(0);
    expect(stageRun.took_ms).toBeGreaterThanOrEqual(stepsMs - 5);
    // Timings live in their own column, not in the publisher's summary.
    expect(stageRun.publish_summary).not.toHaveProperty("phases");
    // Nothing on Firebase serves `<outDir>/current/`, so the build is not
    // mirrored into it (the largest step of a Stage before #1003).
    expect(names(stageRun)).not.toContain("generator.sync-current");
    expect(existsSync(join(testRoot, "output", "staging", "current"))).toBe(false);
    expect(existsSync(join(testRoot, "output", "staging", "builds", staged.runId))).toBe(true);

    await markAudited(staged.runId);
    const promoted = await ok<{ toRunId: string }>("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    const liveRun = await timedRun(promoted.toRunId);
    expect(topLevel(liveRun)).toEqual([
      "prepare",
      "lock-wait",
      "select-preview",
      "generator",
      "parity",
      "publish",
      // Hold release and the completion write: inside the stored span (#1003).
      "finish",
    ]);
    expect(names(liveRun)).toEqual(
      expect.arrayContaining([
        "generator.compose",
        "publish.hash",
        "publish.upload",
        "publish.release",
      ]),
    );
    const liveStepsMs = liveRun.phase_timings
      .filter((p) => !p.phase.includes("."))
      .reduce((n, p) => n + p.ms, 0);
    expect(liveRun.took_ms).toBeGreaterThanOrEqual(liveStepsMs - 5);
    expect(liveRun.publish_summary).not.toHaveProperty("phases");
  });

  it("#1003 a running Stage is visible with its progress, also when the AI started it", async () => {
    type RunRow = { status: string; progress: { pagesDone: number; pagesTotal: number } | null };
    const runRows = (runId?: string) =>
      withSql(
        (tx) =>
          (runId
            ? tx`SELECT status, progress FROM deploy_runs WHERE id = ${runId}::uuid`
            : tx`SELECT status, progress FROM deploy_runs WHERE status = 'running'`) as Promise<
            RunRow[]
          >,
      );
    let midRun: RunRow[] = [];
    fake.onPopulate = async () => {
      // Another connection, while the build transaction is still open.
      midRun = await runRows();
    };
    try {
      const r = await execute(registry, adapter, { ...SYSTEM, actorKind: "ai" }, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(r.ok).toBe(true);
      const { runId, pageCount } = (r.ok ? r.value : null) as { runId: string; pageCount: number };
      // Before #1003 the row was invisible until commit and every progress
      // write matched no row: the deployments page never showed a Stage.
      expect(midRun).toEqual([
        { status: "running", progress: { pagesDone: pageCount, pagesTotal: pageCount } },
      ]);
      expect(await runRows(runId)).toEqual([
        { status: "succeeded", progress: { pagesDone: pageCount, pagesTotal: pageCount } },
      ]);
    } finally {
      fake.onPopulate = null;
    }
  });

  it("#1003 a run that died mid-build is marked failed by the next one; one still building is left alone", async () => {
    const { ORPHANED_RUN_MESSAGE } = await import("../ops/deploy-run-lifecycle.js");
    const [{ id: targetId } = { id: "" }] = (await withSql(
      (tx) => tx`SELECT id::text AS id FROM deploy_targets WHERE name = 'staging'`,
    )) as { id: string }[];
    const orphan = crypto.randomUUID();
    const alive = crypto.randomUUID();
    await withSql(
      (tx) => tx`
        INSERT INTO deploy_runs (id, target_id, actor_id, status)
        VALUES (${orphan}::uuid, ${targetId}::uuid, ${SYSTEM.actorId}::uuid, 'running'),
               (${alive}::uuid, ${targetId}::uuid, ${SYSTEM.actorId}::uuid, 'running')`,
    );
    // `alive` is still being built elsewhere: another transaction holds its run lock.
    const { DEPLOY_RUN_LOCK_PREFIX } = await import("../deploy/deploy-run-lock.js");
    const holder = new SQL(ADMIN_URL!);
    const conn = await holder.reserve();
    try {
      await conn`BEGIN`;
      await conn`SELECT pg_advisory_xact_lock(hashtext(${DEPLOY_RUN_LOCK_PREFIX} || ${alive}::text))`;
      await ok("deploy.trigger", { targetName: "staging", repoRoot: testRoot });
      const rows = (await withSql(
        (tx) => tx`SELECT id::text AS id, status, error_message FROM deploy_runs
                   WHERE id IN (${orphan}::uuid, ${alive}::uuid)`,
      )) as { id: string; status: string; error_message: string | null }[];
      const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
      expect(byId[orphan]).toMatchObject({ status: "failed", error_message: ORPHANED_RUN_MESSAGE });
      expect(byId[alive]).toMatchObject({ status: "running", error_message: null });
    } finally {
      await conn`ROLLBACK`;
      conn.release();
      await holder.end();
      await withSql(
        (tx) => tx`DELETE FROM deploy_runs WHERE id IN (${orphan}::uuid, ${alive}::uuid)`,
      );
    }
  });

  it("#908 / #969 Publish live refreshes the served preview's TTL (one staged by an earlier version too)", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    // What the previous version left behind: served, but on its 7-day TTL
    // with a day left.
    fake.lifetimes.seed(`runid-${staged.runId}`, Date.now() + DAY_MS);
    await markAudited(staged.runId);
    await ok("deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect((await stagingRow())[0]?.origin_run_id).toBe(staged.runId);
    expect(fake.lifetimes.remainingMs(`runid-${staged.runId}`)).toBeGreaterThan(29 * DAY_MS);
  });

  it("#969 deploy.refresh_staging_preview extends the served preview after idle days and fails loudly once it is gone", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    const channelId = `runid-${staged.runId}`;
    // Ten idle days later the orchestrator's keep-alive ticks.
    const start = Date.now();
    fake.lifetimes.now = () => start + 10 * DAY_MS;
    try {
      expect(fake.lifetimes.remainingMs(channelId)).toBeLessThan(21 * DAY_MS);
      const r = await ok<{ servedRunId: string; expiresAt: string }>(
        "deploy.refresh_staging_preview",
        {},
      );
      expect(r).toEqual({
        servedRunId: staged.runId,
        expiresAt: fake.lifetimes.expireTime(channelId)!,
      });
      expect(fake.lifetimes.remainingMs(channelId)).toBeGreaterThan(29 * DAY_MS);
      expect(fake.lifetimes.ttlPatches.at(-1)).toEqual({
        channelId,
        ttl: SERVED_PREVIEW_CHANNEL_TTL,
      });

      // The AI never runs the keep-alive (no tool, op not AI-scoped).
      const ai = await execute(
        registry,
        adapter,
        { ...SYSTEM, actorKind: "ai" },
        "deploy.refresh_staging_preview",
        {},
      );
      expect(ai.ok).toBe(false);

      // Expired anyway (e.g. the admin was not running for a month): loud, never recreated.
      const url = fake.channels.get(channelId)!;
      fake.channels.delete(channelId);
      fake.lifetimes.forget(channelId);
      const gone = await execute(registry, adapter, SYSTEM, "deploy.refresh_staging_preview", {});
      expect(gone.ok).toBe(false);
      expect(JSON.stringify(gone.ok ? null : gone.error)).toContain("Stage again");
      expect(fake.channels.has(channelId)).toBe(false);
      fake.channels.set(channelId, url);
      fake.lifetimes.create(channelId, SERVED_PREVIEW_CHANNEL_TTL);
    } finally {
      fake.lifetimes.now = () => Date.now();
    }
  });

  it("#908 a Stage whose preview cannot be kept alive fails, leaves that preview on its TTL and staging on the previous build", async () => {
    const served = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    const channelsBefore = new Set(fake.channels.keys());
    const servedExpiry = fake.lifetimes.expireTime(`runid-${served.runId}`);
    fake.lifetimes.failTtl = SERVED_PREVIEW_CHANNEL_TTL;
    try {
      const r = await execute(registry, adapter, SYSTEM, "deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r.ok ? null : r.error)).toContain("Stage again");
    } finally {
      fake.lifetimes.failTtl = null;
    }
    const failed = [...fake.channels.keys()].filter((id) => !channelsBefore.has(id));
    expect(failed).toHaveLength(1);
    // The failed Stage's preview expires on its own within a week; the
    // served one is untouched.
    expect(fake.lifetimes.remainingMs(failed[0]!)).toBeLessThanOrEqual(7 * DAY_MS);
    expect(fake.channels.has(`runid-${served.runId}`)).toBe(true);
    expect(fake.lifetimes.expireTime(`runid-${served.runId}`)).toBe(servedExpiry);
    expect((await stagingRow())[0]?.origin_run_id).toBe(served.runId);
    const [run] = (await withSql(
      (tx) => tx`SELECT status FROM deploy_runs
                 WHERE id = ${failed[0]!.slice("runid-".length)}::uuid`,
    )) as { status: string }[];
    expect(run?.status).toBe("failed");

    // The next Stage retires the failed Stage's leftover preview.
    const next = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    expect([...fake.channels.keys()]).toEqual([`runid-${next.runId}`]);
  });

  it("a Stage waits for an in-flight Stage / Publish live before it publishes and prunes (codex review on #652)", async () => {
    // Without ordering, Stage A prunes Stage B's fresh channel and B then
    // records that deleted channel as the staging origin.
    const holder = new SQL(ADMIN_URL!);
    let release!: () => void;
    const released = new Promise<void>((r) => {
      release = r;
    });
    let held!: () => void;
    const locked = new Promise<void>((r) => {
      held = r;
    });
    const holderTx = holder.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${STAGING_PUBLICATION_LOCK_KEY}))`;
      held();
      await released;
    });
    try {
      await locked;
      const channelsBefore = [...fake.channels.keys()];
      let settled = false;
      const pending = ok<{ runId: string }>("deploy.trigger", {
        targetName: "staging",
        repoRoot: testRoot,
      }).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 2400; i++) {
        const waiting = await holder`
          SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        if ((waiting[0] as { n: number }).n > 0) break;
        await Bun.sleep(25);
      }
      // Built, but queued on the lock: no channel published, none pruned.
      expect(settled).toBe(false);
      expect([...fake.channels.keys()]).toEqual(channelsBefore);
      release();
      await holderTx;
      const staged = await pending;
      expect([...fake.channels.keys()]).toEqual([`runid-${staged.runId}`]);
      expect((await stagingRow())[0]?.origin_run_id).toBe(staged.runId);
    } finally {
      release();
      await holderTx.catch(() => undefined);
      await holder.end();
    }
  });

  it("Publish live keeps a newer Stage served and its preview alive (codex review on #652)", async () => {
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    // A newer Stage committed while this publish ran (simulated: the
    // gate already points at another run and its channel exists).
    const newer = "00000000-0000-4000-8000-00000000a652";
    const newerUrl = `https://${SITE}--runid-${newer}-x1y2.web.app`;
    fake.channels.set(`runid-${newer}`, newerUrl);
    fake.lifetimes.create(`runid-${newer}`, SERVED_PREVIEW_CHANNEL_TTL);
    await withSql(
      (tx) => tx`UPDATE staging_access SET origin_url = ${newerUrl}, origin_run_id = ${newer}::uuid
                 WHERE id = 1`,
    );
    const promoted = await execute(registry, adapter, SYSTEM, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    // Whether this promote picks the simulated run or the real one, the
    // newer Stage's origin and channel must survive it.
    if (promoted.ok) {
      expect(await stagingRow()).toEqual([{ origin_url: newerUrl, origin_run_id: newer }]);
      expect([...fake.channels.keys()]).toEqual([`runid-${newer}`]);
    }
    fake.channels.delete(`runid-${newer}`);
    await withSql(
      (tx) => tx`UPDATE staging_access SET origin_url = NULL, origin_run_id = NULL WHERE id = 1`,
    );
    expect(promoted.ok).toBe(true);
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

  // #834 — after an upgrade between Stage and Publish live, the refusal
  // must name the version change, not blame site edits nobody made.
  async function stageRenderedByOtherVersion(version: string | null): Promise<void> {
    // The module may still carry the previous test's post-Stage edit; this
    // Stage includes it, so only the simulated render difference remains.
    const staged = await ok<{ runId: string }>("deploy.trigger", {
      targetName: "staging",
      repoRoot: testRoot,
    });
    await markAudited(staged.runId);
    const [recorded] = (await withSql(
      (tx) => tx`SELECT caelo_version FROM deploy_runs WHERE id = ${staged.runId}::uuid`,
    )) as { caelo_version: string | null }[];
    expect(recorded?.caelo_version).toBe(CAELO_VERSION);
    // The previous version rendered one page differently (e.g. #793's
    // renamed font files): no site edit, only another generator.
    await withSql(
      (tx) => tx`UPDATE deploy_runs
                 SET caelo_version = ${version},
                     parity_manifest = jsonb_set(parity_manifest,
                       ${`{${PAGE_SLUG}/index.html}`}::text[],'"rendered-by-old-caelo"'::jsonb)
                 WHERE id = ${staged.runId}::uuid`,
    );
  }

  async function promoteRefusal(): Promise<string> {
    const r = await execute(registry, adapter, SYSTEM, "deploy.promote", {
      fromTarget: "staging",
      toTarget: "production",
      repoRoot: testRoot,
    });
    expect(r.ok).toBe(false);
    return r.ok ? "" : r.error.message;
  }

  it("a Caelo upgrade between Stage and Publish live is named as the cause (#834)", async () => {
    await stageRenderedByOtherVersion("0.0.1-before-upgrade");
    const liveBefore = fake.live.length;
    const message = await promoteRefusal();
    expect(message).toStartWith(
      `Publish live stopped: Caelo was updated from 0.0.1-before-upgrade to ${CAELO_VERSION} since this Stage`,
    );
    expect(message).toContain(`${PAGE_SLUG}/index.html`);
    expect(message).not.toContain("another edit was merged");
    expect(message).toContain('"Stage again" button');
    expect(fake.live.length).toBe(liveBefore);
  });

  it("a build staged before versions were recorded says the version is unknown (#834)", async () => {
    await stageRenderedByOtherVersion(null);
    const message = await promoteRefusal();
    expect(message).toContain("The Caelo version that made this Stage is unknown");
    expect(message).not.toContain("Caelo was updated from");
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

  it("get with includeCredentials answers on a provider without a gate (no gate key needed — codex review on #652)", async () => {
    const saved = {
      provider: process.env.CAELO_PROVIDER,
      secret: process.env.CAELO_STAGING_GATE_SECRET,
    };
    process.env.CAELO_PROVIDER = "self-hosted";
    delete process.env.CAELO_STAGING_GATE_SECRET;
    try {
      const v = await ok<{ stagingDomainSupported: boolean; credentials?: unknown }>(
        "staging_access.get",
        { includeCredentials: true },
      );
      expect(v.stagingDomainSupported).toBe(false);
      expect(v.credentials).toBeUndefined();
    } finally {
      process.env.CAELO_PROVIDER = saved.provider;
      process.env.CAELO_STAGING_GATE_SECRET = saved.secret;
    }
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

describe("cms-provision staging-domain enable → staging_access.provision (#678)", () => {
  const SOURCE = "cms-provision staging-domain enable";
  const row = async () =>
    (
      (await withSql(
        (tx) => tx`SELECT staging_host, basic_auth_enabled, basic_auth_user, basic_auth_nonce
                   FROM staging_access WHERE id = 1`,
      )) as {
        staging_host: string;
        basic_auth_enabled: boolean;
        basic_auth_user: string;
        basic_auth_nonce: string | null;
      }[]
    )[0]!;
  interface Provisioned {
    host: string;
    previousHost: string | null;
    hostChanged: boolean;
    basicAuth: { status: string; enabled: boolean; user: string; password: string | null };
    stageNeeded: string | null;
    stageNote: string | null;
    draftPages: { count: number; pages: { title: string; path: string }[] };
  }

  beforeAll(async () => {
    // A fresh gate: no basic-auth credential was ever generated.
    await withSql(
      (tx) => tx`UPDATE staging_access SET basic_auth_enabled = false, basic_auth_user = 'caelo',
                 basic_auth_nonce = NULL, staging_host = 'staging.example.com' WHERE id = 1`,
    );
    const tpl = (
      (await withSql(
        (tx) => tx`SELECT id::text AS id FROM templates WHERE slug = ${TPL_SLUG}`,
      )) as {
        id: string;
      }[]
    )[0]!;
    await ok("pages.create", { slug: DRAFT_SLUG, title: "Draft pricing", templateId: tpl.id });
  });

  it("sets the CLI's host authoritatively, turns on basic auth once and returns the password only then", async () => {
    const first = await ok<Provisioned>("staging_access.provision", {
      host: "Preview.Example.org",
      source: SOURCE,
    });
    const r1 = await row();
    expect(first).toMatchObject({
      host: "preview.example.org",
      previousHost: "staging.example.com",
      hostChanged: true,
      basicAuth: { status: "generated", enabled: true, user: "example" },
    });
    expect(r1.staging_host).toBe("preview.example.org");
    expect(first.basicAuth.password).toBe(
      await deriveStagingCredential(GATE_SECRET, "basic-auth", r1.basic_auth_nonce!),
    );
    // The new host serves nothing of its own until the next Stage, and the
    // draft page is named as missing.
    expect(first.stageNeeded).not.toBeNull();
    expect(first.stageNote).toContain("Stage");
    expect(first.draftPages.pages.map((p) => p.title)).toContain("Draft pricing");

    const again = await ok<Provisioned>("staging_access.provision", { source: SOURCE });
    expect(again).toMatchObject({
      host: "preview.example.org",
      hostChanged: false,
      basicAuth: { status: "unchanged-enabled", enabled: true, password: null },
    });
    expect((await row()).basic_auth_nonce).toBe(r1.basic_auth_nonce);

    const audits = (await withSql(
      (tx) => tx`SELECT operation, result_summary FROM audit_events
                 WHERE operation IN ('staging_access.provision', 'staging_access.reveal_credentials')
                 ORDER BY created_at DESC LIMIT 5`,
    )) as { operation: string; result_summary: string }[];
    expect(audits.some((a) => a.result_summary.includes(`via ${SOURCE}`))).toBe(true);
    expect(audits.some((a) => a.operation === "staging_access.reveal_credentials")).toBe(true);
    expect(JSON.stringify(audits)).not.toContain(first.basicAuth.password!);
  });

  it("an upgrade's seed never overwrites the host the CLI set", async () => {
    expect(
      await ok<{ seeded: boolean }>("staging_access.seed_host", { host: "staging.example.com" }),
    ).toEqual({ seeded: false });
    expect((await row()).staging_host).toBe("preview.example.org");
  });

  it("keeps an Owner's switched-off basic auth off; rotates and reveals only on request", async () => {
    await ok("staging_access.set", {
      cookieEnabled: true,
      basicAuthEnabled: false,
      basicAuthUser: "example",
      headerEnabled: false,
      headerName: "X-Caelo-Staging-Key",
      ipAllowlist: [],
    });
    const off = await ok<Provisioned>("staging_access.provision", { source: SOURCE });
    expect(off.basicAuth).toMatchObject({ status: "unchanged-disabled", enabled: false });
    expect((await row()).basic_auth_enabled).toBe(false);

    const before = (await row()).basic_auth_nonce;
    const rotated = await ok<Provisioned>("staging_access.provision", {
      rotateBasicAuth: true,
      source: SOURCE,
    });
    const after = await row();
    expect(rotated.basicAuth.status).toBe("rotated");
    expect(after.basic_auth_enabled).toBe(true);
    expect(after.basic_auth_nonce).not.toBe(before);
    const revealed = await ok<Provisioned>("staging_access.provision", {
      revealBasicAuth: true,
      source: SOURCE,
    });
    expect(revealed.basicAuth.password).toBe(rotated.basicAuth.password);
  });

  it("is system-only: the AI reaches the host only through the gated proposal", async () => {
    const ai = await execute(
      registry,
      adapter,
      { ...SYSTEM, actorKind: "ai", requestId: "staging-provision-ai" },
      "staging_access.provision",
      { host: "evil.example.net", source: "ai" },
    );
    expect(ai.ok).toBe(false);
  });

  it("get reports the stage-needed note and draft pages; approving a host change names the next step", async () => {
    const v = await ok<{
      stageNeeded: string | null;
      stageNote: string | null;
      draftPages: { count: number };
    }>("staging_access.get", {});
    expect(v.stageNeeded).not.toBeNull();
    expect(v.stageNote).toContain("stage_changes");
    expect(v.draftPages.count).toBeGreaterThan(0);

    const p = await ok<{ proposalId: string }>("owner_settings.propose_set_staging_host", {
      host: "review.example.org",
    });
    const applied = await ok<{ nextStep?: string }>("owner_settings.execute_proposal", {
      proposalId: p.proposalId,
    });
    expect(applied.nextStep).toContain("stage_changes");
    expect(applied.nextStep).toContain("Nothing is served at https://review.example.org/");

    // An access change while the served build has another host: the apply
    // result says so, and the row keeps it for an external agent's poll
    // (mcp_approval_handoffs reads preview.appliedNextStep).
    const access = await ok<{ proposalId: string }>("owner_settings.propose_set_staging_access", {
      headerEnabled: true,
    });
    const accessApplied = await ok<{ nextStep?: string }>("owner_settings.execute_proposal", {
      proposalId: access.proposalId,
    });
    // #971 — where the operator finds the new credential, never via the AI.
    expect(accessApplied.nextStep).toContain("/settings/staging");
    expect(accessApplied.nextStep).not.toContain("includeCredentials");
    expect(accessApplied.nextStep).toContain("stage_changes");
    const [stored] = (await withSql(
      (tx) => tx`SELECT preview->>'appliedNextStep' AS next FROM owner_settings_pending_actions
                 WHERE id = ${access.proposalId}::uuid`,
    )) as { next: string | null }[];
    expect(stored?.next).toBe(accessApplied.nextStep ?? null);
  });

  it("Stage reports the draft pages it left out", async () => {
    const staged = await ok<{ draftPages: { count: number; pages: { title: string }[] } }>(
      "deploy.trigger",
      { targetName: "staging", repoRoot: testRoot },
    );
    expect(staged.draftPages.pages.map((p) => p.title)).toContain("Draft pricing");
    const v = await ok<{ stageNeeded: string | null }>("staging_access.get", {});
    expect(v.stageNeeded).toBeNull();
  });

  it("Power-MCP: no admin token reads the password, not even an Owner's (#971)", async () => {
    configureMcpBridge({ adapter, registry, resolveProvider: async () => null });
    const reveal = async (actorId: string, args: Record<string, unknown>) => {
      const human: ExecutionContext = { actorId, actorKind: "human", requestId: "mcp-reveal" };
      const minted = await execute(registry, adapter, human, "mcp_tokens.create", {
        displayName: `staging-reveal-${actorId.slice(-2)}`,
        scope: "admin",
      });
      if (!minted.ok) throw new Error(JSON.stringify(minted.error));
      const token = (minted.value as { plaintextToken: string }).plaintextToken;
      const session = await ok<{ chatSessionId: string }>("mcp.open_session", {
        plaintextToken: token,
        title: "staging reveal",
      });
      return ok<{ ok: boolean; content: string }>("mcp.execute_tool", {
        plaintextToken: token,
        chatSessionId: session.chatSessionId,
        toolName: "get_staging_access",
        args,
      });
    };
    await ensureRoleUser(ADMIN_URL!, OWNER_ID, "owner");
    await ensureRoleUser(ADMIN_URL!, EDITOR_ID, "editor");
    const password = (
      await ok<Provisioned>("staging_access.provision", { revealBasicAuth: true, source: SOURCE })
    ).basicAuth.password!;
    // The model behind an MCP token may be a third party's: the credential
    // stays in the admin (Settings → Staging access), the result says so.
    const owner = await reveal(OWNER_ID, {});
    expect(owner.ok).toBe(true);
    expect(owner.content).not.toContain(password);
    expect(owner.content).toContain("/settings/staging");
    for (const actorId of [OWNER_ID, EDITOR_ID]) {
      const asked = await reveal(actorId, { includeCredentials: true });
      expect(asked.ok).toBe(false);
      expect(asked.content).not.toContain(password);
    }
  });
});
