// SPDX-License-Identifier: MPL-2.0

/**
 * #1003 — how Stage and Publish live scale with the site, step by step.
 * Not part of the suite (no `.test.` in the name). It deletes every deploy
 * run and adds thousands of pages, so it runs only against a throwaway
 * database and only when told so explicitly:
 *
 *   CAELO_BENCH_THROWAWAY_DB=1 CAELO_TEST_DB_RESET=1 BENCH_PAGES=100,1000,5000 \
 *     bun test ./packages/admin-core/src/__tests__/stage-scale.bench.ts
 *
 * Real generator, real Postgres, gcp-firebase publisher against an
 * in-memory Firebase (no network: upload time is CPU + memory only).
 * Pages are seeded cumulatively; per size it runs a cold Stage, a warm
 * Stage (nothing changed) and a Publish live, and prints each run's steps.
 */

import { afterAll, beforeAll, describe, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PhaseTiming } from "@caelo-cms/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { FakeChannelLifetimes } from "./fixtures/firebase-channel-lifetime.js";
import { pinSiteBaseUrl } from "./fixtures/site-base-url.js";
import { pinSiteLanguage } from "./fixtures/site-language.js";

mock.module("google-auth-library", () => ({
  GoogleAuth: class {
    async getClient() {
      return { getAccessToken: async () => ({ token: "bench-token" }) };
    }
  },
}));

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");
if (process.env.CAELO_BENCH_THROWAWAY_DB !== "1") {
  throw new Error(
    "stage-scale.bench deletes every deploy run and seeds thousands of pages. Point ADMIN_DATABASE_URL at a throwaway database and set CAELO_BENCH_THROWAWAY_DB=1.",
  );
}
const SIZES = (process.env.BENCH_PAGES ?? "100,1000")
  .split(",")
  .map((s) => Number.parseInt(s, 10))
  .filter((n) => n > 0)
  .sort((a, b) => a - b);

const SITE = "bench-site";
const API = "https://firebasehosting.googleapis.com/v1beta1/";
const UPLOAD = "https://upload.bench/";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "stage-scale-bench",
};
/** #1154 — production is built and published only for a human. */
const PUBLISHER: ExecutionContext = { ...SYSTEM, actorKind: "human" };

/** Firebase Hosting as far as Stage + Publish live use it; keeps blobs by hash only. */
class FakeFirebase {
  versions = new Map<string, Record<string, string>>();
  channels = new Map<string, string>();
  lifetimes = new FakeChannelLifetimes();
  blobs = new Set<string>();
  private seq = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(API) && !url.startsWith(UPLOAD)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.startsWith(UPLOAD)) {
      this.blobs.add(url.split("/").pop() ?? "");
      return json({});
    }
    const parsed = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const [route = "", query = ""] = url.slice(API.length).split("?");
    const params = new URLSearchParams(query);
    if (method === "POST" && route === `sites/${SITE}/versions`) {
      const id = `v${++this.seq}`;
      this.versions.set(id, {});
      return json({ name: `sites/${SITE}/versions/${id}` });
    }
    const populate = route.match(/versions\/([^/:]+):populateFiles$/);
    if (populate) {
      const files = parsed.files as Record<string, string>;
      this.versions.set(populate[1] ?? "", files);
      return json({
        uploadRequiredHashes: Object.values(files).filter((h) => !this.blobs.has(h)),
        uploadUrl: `${UPLOAD}${populate[1]}`,
      });
    }
    if (method === "PATCH" && /versions\/[^/]+$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${SITE}/channels`) {
      const id = params.get("channelId") ?? "";
      const channelUrl = `https://${SITE}--${id}.web.app`;
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
      return json({ name: url, expireTime: this.lifetimes.expireTime(channel[1] ?? "") });
    }
    if (method === "PATCH" && channel) {
      return this.lifetimes.patch(SITE, channel[1] ?? "", params.get("updateMask"), parsed);
    }
    if (method === "POST" && /channels\/[^/]+\/releases$/.test(route)) return json({});
    if (method === "POST" && route === `sites/${SITE}/releases`) return json({});
    throw new Error(`unhandled ${method} ${url}`);
  };
}

const realFetch = globalThis.fetch;
const fake = new FakeFirebase();
let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let root: string;
let templateId = "";
const moduleIds: Record<"header" | "hero" | "body" | "cta" | "footer", string> = {
  header: "",
  hero: "",
  body: "",
  cta: "",
  footer: "",
};
let headerContentId = "";
let footerContentId = "";
let seeded = 0;
/** site_defaults survives the test preload's reset: put back what the bench pinned. */
const restore: (() => Promise<void>)[] = [];

async function ok<T>(op: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, SYSTEM, op, input);
  if (!r.ok) throw new Error(`${op} failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/** Publish live (staging → production) as a human. */
async function publish<T>(input: Record<string, unknown>): Promise<T> {
  const r = await execute(registry, adapter, PUBLISHER, "deploy.promote", input);
  if (!r.ok) throw new Error(`deploy.promote failed: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

/**
 * #1225 — samples cms_admin's backends while a run is in flight and keeps
 * every transaction that sat `idle in transaction` for more than a second
 * (longest age per query). A Stage or Publish live that holds a pooled
 * connection across its build or upload shows up here; the static
 * generator's own read transaction (a subprocess with its own connection,
 * #1220) is reported separately, by the query it last ran.
 */
function sampleIdleTransactions(): { stop: () => Promise<Map<string, number>> } {
  const sql = new SQL(ADMIN_URL!);
  const longest = new Map<string, number>();
  let running = true;
  const loop = (async () => {
    while (running) {
      const rows = (await sql`
        SELECT left(regexp_replace(query, '[[:space:]]+', ' ', 'g'), 80) AS q,
               (extract(epoch FROM clock_timestamp() - xact_start) * 1000)::int AS ms
        FROM pg_stat_activity
        WHERE datname = 'cms_admin' AND pid <> pg_backend_pid()
          AND state LIKE 'idle in transaction%'
          AND clock_timestamp() - state_change > interval '1 second'`) as {
        q: string;
        ms: number;
      }[];
      for (const r of rows) longest.set(r.q, Math.max(longest.get(r.q) ?? 0, r.ms));
      await Bun.sleep(250);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      await sql.end();
      return longest;
    },
  };
}

function reportIdle(label: string, longest: Map<string, number>): void {
  if (longest.size === 0) {
    console.info(`[bench] ${label}: no transaction idle for more than 1 s`);
    return;
  }
  for (const [q, ms] of longest) {
    console.info(`[bench] ${label}: idle in transaction up to ${ms} ms — ${q}`);
  }
}

async function system<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
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

/** ~2 KB of body copy per page, distinct per page so no two files hash alike. */
function bodyCopy(i: number): string {
  const para = `Page ${i}: search engine optimisation is the practice of improving how a site is crawled, rendered and indexed. `;
  return Array.from({ length: 4 }, (_, k) => `${para.repeat(4)} (section ${k + 1})`).join("\n\n");
}

async function seedTo(n: number): Promise<void> {
  const todo = Array.from({ length: n - seeded }, (_, k) => seeded + k);
  const CONCURRENCY = 8;
  for (let at = 0; at < todo.length; at += CONCURRENCY) {
    await Promise.all(
      todo.slice(at, at + CONCURRENCY).map(async (i) => {
        const { pageId } = await ok<{ pageId: string }>("pages.build_page", {
          page: { slug: i === 0 ? "home" : `bench-${i}`, title: `Bench page ${i}`, templateId },
          modules: [
            {
              blockName: "content",
              moduleId: moduleIds.header,
              content: { source: "existing", contentInstanceId: headerContentId },
            },
            {
              blockName: "content",
              moduleId: moduleIds.hero,
              content: {
                source: "inline",
                values: { hero_title: `Bench page ${i}`, hero_text: `Why page ${i} matters.` },
              },
            },
            {
              blockName: "content",
              moduleId: moduleIds.body,
              content: { source: "inline", values: { body: bodyCopy(i) } },
            },
            {
              blockName: "content",
              moduleId: moduleIds.cta,
              content: {
                source: "inline",
                values: { cta_label: "Start now", cta_href: "https://example.org/start" },
              },
            },
            {
              blockName: "content",
              moduleId: moduleIds.footer,
              content: { source: "existing", contentInstanceId: footerContentId },
            },
          ],
        });
        await ok("pages.update", { pageId, status: "published" });
        await ok("pages_seo.autofill", { pageId, metaDescription: `Bench page ${i}.` });
      }),
    );
  }
  seeded = n;
}

function report(label: string, pages: number, phases: readonly PhaseTiming[]): void {
  const total = phases.filter((p) => !p.phase.includes(".")).reduce((s, p) => s + p.ms, 0);
  const rows = phases.map((p) => `  ${p.phase.padEnd(28)} ${String(p.ms).padStart(8)} ms`);
  console.info(`\n[bench] ${label} — ${pages} pages — ${total} ms\n${rows.join("\n")}`);
}

async function runPhases(runId: string): Promise<PhaseTiming[]> {
  const rows = (await system(
    (tx) => tx`SELECT phase_timings FROM deploy_runs WHERE id = ${runId}::uuid`,
  )) as { phase_timings: PhaseTiming[] }[];
  return rows[0]?.phase_timings ?? [];
}

beforeAll(async () => {
  Object.assign(process.env, {
    CAELO_PROVIDER: "gcp-firebase",
    CAELO_STAGING_GATE_SECRET: "bench-gate-secret",
    CAELO_FIREBASE_SITE: SITE,
    CAELO_GATEWAY_SERVICE: "gateway",
    CAELO_GATEWAY_REGION: "europe-west1",
    CAELO_SKIP_STAGING_SERVE_CHECK: "1",
  });
  globalThis.fetch = fake.fetch as typeof fetch;
  restore.push(await pinSiteBaseUrl(ADMIN_URL!, "https://example.com"));
  restore.push(await pinSiteLanguage(ADMIN_URL!, "en"));
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  root = await mkdtemp(join(tmpdir(), "caelo-stage-bench-"));
  // A previous run's rows: templates are seed data the test preload keeps.
  await system(async (tx) => {
    await tx`DELETE FROM quality_audit_runs`;
    await tx`DELETE FROM deploy_runs`;
    await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug = 'bench-tpl'))`;
    await tx`DELETE FROM pages WHERE template_id IN (SELECT id FROM templates WHERE slug = 'bench-tpl')`;
    await tx`DELETE FROM content_instances WHERE slug LIKE 'bench-%'`;
    await tx`DELETE FROM modules WHERE slug LIKE 'bench-%'`;
    await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = 'bench-tpl')`;
    await tx`DELETE FROM templates WHERE slug = 'bench-tpl'`;
  });
  await ok("staging_access.seed_host", { host: "staging.example.com" });

  templateId = (
    await ok<{ templateId: string }>("templates.create", {
      slug: "bench-tpl",
      displayName: "Bench",
      html: `<html><head><title>x</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
      css: "body{font-family:sans-serif;margin:0}",
    })
  ).templateId;
  await ok("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const mod = async (slug: string, html: string, css: string, fields: string[]) =>
    (
      await ok<{ moduleId: string }>("modules.create", {
        slug,
        displayName: slug,
        html,
        css,
        fields: fields.map((name) => ({ name, kind: "text", label: name })),
      })
    ).moduleId;
  moduleIds.header = await mod(
    "bench-header",
    `<header class="bh"><strong>{{brand}}</strong></header>`,
    ".bh{display:flex;padding:1rem;background:#111;color:#fff}",
    ["brand"],
  );
  moduleIds.hero = await mod(
    "bench-hero",
    `<section class="bhe"><h1>{{hero_title}}</h1><p>{{hero_text}}</p></section>`,
    ".bhe{padding:4rem 1rem}.bhe h1{font-size:3rem}",
    ["hero_title", "hero_text"],
  );
  moduleIds.body = await mod(
    "bench-body",
    `<article class="bb">{{body}}</article>`,
    ".bb{max-width:70ch;margin:auto;line-height:1.6}",
    ["body"],
  );
  moduleIds.cta = await mod(
    "bench-cta",
    `<a class="bc" href="{{cta_href}}">{{cta_label}}</a>`,
    ".bc{display:inline-block;padding:.75rem 1.5rem;background:#06c;color:#fff}",
    ["cta_label", "cta_href"],
  );
  moduleIds.footer = await mod(
    "bench-footer",
    `<footer class="bf">{{copyright}}</footer>`,
    ".bf{padding:2rem;border-top:1px solid #ddd}",
    ["copyright"],
  );
  const shared = async (moduleId: string, slug: string, values: Record<string, string>) =>
    (
      await ok<{ contentInstanceId: string }>("content_instances.create", {
        moduleId,
        slug,
        displayName: slug,
        purpose: "Site-wide chrome shared by every bench page.",
        values,
      })
    ).contentInstanceId;
  headerContentId = await shared(moduleIds.header, "bench-header-content", { brand: "Bench" });
  footerContentId = await shared(moduleIds.footer, "bench-footer-content", {
    copyright: "(c) Bench",
  });
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  for (const undo of restore.reverse()) await undo();
  await rm(root, { recursive: true, force: true });
  await adapter.close();
});

describe("#1003 Stage / Publish live scaling", () => {
  for (const n of SIZES) {
    it(
      `${n} pages`,
      async () => {
        const seedStart = performance.now();
        await seedTo(n);
        console.info(
          `\n[bench] seeded to ${n} pages in ${Math.round(performance.now() - seedStart)} ms`,
        );

        for (const label of ["Stage (cold)", "Stage (nothing changed)"]) {
          const t = performance.now();
          const idle = sampleIdleTransactions();
          const staged = await ok<{ runId: string; phases: PhaseTiming[] }>("deploy.trigger", {
            targetName: "staging",
            repoRoot: root,
          });
          console.info(`[bench] ${label} wall ${Math.round(performance.now() - t)} ms`);
          reportIdle(label, await idle.stop());
          report(label, n, staged.phases);
          if (label.endsWith("changed)")) {
            await system(
              (tx) => tx`
                INSERT INTO quality_audit_runs (deploy_run_id, requested_by, status, classification, finished_at)
                VALUES (${staged.runId}::uuid, ${SYSTEM.actorId}::uuid, 'passed',
                        '{"auditNeeded":true,"reasons":[],"skipped":[]}'::jsonb, now())`,
            );
          }
        }
        const t = performance.now();
        const idle = sampleIdleTransactions();
        const promoted = await publish<{ toRunId: string }>({
          fromTarget: "staging",
          toTarget: "production",
          repoRoot: root,
        });
        console.info(`[bench] Publish live wall ${Math.round(performance.now() - t)} ms`);
        reportIdle("Publish live", await idle.stop());
        report("Publish live", n, await runPhases(promoted.toRunId));
      },
      { timeout: 60 * 60 * 1000 },
    );
  }
});
