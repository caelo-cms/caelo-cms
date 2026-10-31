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
 *
 * #1271 — every page shows media: a hero image and two inline images out of
 * a pool of `BENCH_MEDIA` real JPEGs (default 200) run through the media
 * pipeline, so the build publishes their variants. Each run also prints the
 * peak RSS of this process (the admin: trigger, publisher, fake Firebase)
 * and of the generator subprocess, sampled while it runs.
 */

import { afterAll, beforeAll, describe, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, PhaseTiming } from "@caelo-cms/shared";
import { SQL } from "bun";
import sharp from "sharp";
import { runMediaPipeline } from "../media/pipeline.js";
import { LocalVolumeAdapter, setMediaStorage } from "../media/storage.js";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";
import { FakeFirebaseHosting } from "./fixtures/fake-firebase-hosting.js";
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

const MEDIA_POOL = Number.parseInt(process.env.BENCH_MEDIA ?? "200", 10);
const SITE = "bench-site";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "stage-scale-bench",
};
/** #1154 — production is built and published only for a human. */
const PUBLISHER: ExecutionContext = { ...SYSTEM, actorKind: "human" };

const realFetch = globalThis.fetch;
const fake = new FakeFirebaseHosting(SITE, realFetch);
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
/** Slugs of the seeded media pool; page `i` shows images `i`, `i+1`, `i+2` (mod pool). */
const mediaSlugs: string[] = [];
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

function mediaUrl(i: number): string {
  return `/_caelo/media/${mediaSlugs[i % mediaSlugs.length]}`;
}

/** A photo-like JPEG (smoothed noise, ~1600×1000): its variants weigh what real photos do. */
async function photo(seed: number): Promise<Uint8Array> {
  const w = 200;
  const h = 125;
  const raw = Buffer.alloc(w * h * 3);
  let x = seed * 2654435761;
  for (let k = 0; k < raw.length; k += 1) {
    x = (x * 1103515245 + 12345) >>> 0;
    raw[k] = x >>> 24;
  }
  const out = await sharp(raw, { raw: { width: w, height: h, channels: 3 } })
    .resize(1600, 1000, { kernel: "cubic" })
    .jpeg({ quality: 82 })
    .toBuffer();
  return new Uint8Array(out);
}

/** The media pool, through the same pipeline + op as an operator upload. */
async function seedMedia(count: number, mediaRoot: string): Promise<void> {
  const storage = new LocalVolumeAdapter(mediaRoot);
  setMediaStorage(storage);
  for (let i = 0; i < count; i += 1) {
    const body = await photo(i + 1);
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    const result = await runMediaPipeline(sha, "image/jpeg", body);
    for (const v of result.variants) await storage.put(v.storageKey, v.body, v.contentType);
    const up = await ok<{ slug: string }>("media.upload", {
      sha256: sha,
      originalName: `bench-photo-${i}.jpg`,
      name: `bench-photo-${i}`,
      mime: "image/jpeg",
      sizeBytes: body.byteLength,
      width: result.width,
      height: result.height,
      alt: `Bench photo ${i}`,
      storageKey: result.variants[0]?.storageKey ?? `${sha}/orig`,
      sourceKind: "upload",
      variants: result.variants.map((v) => ({
        variant: v.variant,
        format: v.format,
        width: v.width,
        height: v.height,
        sizeBytes: v.sizeBytes,
        storageKey: v.storageKey,
        digest: v.digest,
      })),
    });
    mediaSlugs.push(up.slug);
  }
}

/**
 * Peak RSS while a run is in flight: this process (the admin side) and
 * every static-generator subprocess (sampled with `ps`, so it measures the
 * generator of any Caelo version without its cooperation).
 */
function samplePeakRss(): {
  stop: () => Promise<{ adminStartMb: number; adminMb: number; generatorMb: number }>;
} {
  const adminStart = process.memoryUsage().rss;
  let admin = adminStart;
  let generator = 0;
  let running = true;
  const loop = (async () => {
    while (running) {
      admin = Math.max(admin, process.memoryUsage().rss);
      // A spawn can fail while the run has every file descriptor in use: skip that sample.
      let out = "";
      try {
        const ps = Bun.spawn(["ps", "-axo", "rss=,command="], { stdout: "pipe" });
        out = await new Response(ps.stdout).text();
      } catch {
        out = "";
      }
      for (const line of out.split("\n")) {
        if (!line.includes("static-generator/src/cli.ts")) continue;
        const kb = Number.parseInt(line.trim().split(/\s+/)[0] ?? "0", 10);
        if (Number.isFinite(kb)) generator = Math.max(generator, kb * 1024);
      }
      await Bun.sleep(50);
    }
  })();
  return {
    stop: async () => {
      running = false;
      await loop;
      const mb = (b: number) => Math.round(b / (1024 * 1024));
      return { adminStartMb: mb(adminStart), adminMb: mb(admin), generatorMb: mb(generator) };
    },
  };
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
                values: {
                  hero_title: `Bench page ${i}`,
                  hero_text: `Why page ${i} matters.`,
                  hero_image: mediaUrl(i),
                  inline_a: mediaUrl(i + 1),
                  inline_b: mediaUrl(i + 2),
                },
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
  // #1271 — CPU time and cores kept busy (cpuMs / ms) and peak RSS per step.
  const rows = phases.map((p) => {
    const cores = p.cpuMs !== undefined && p.ms > 0 ? (p.cpuMs / p.ms).toFixed(1) : "-";
    return `  ${p.phase.padEnd(28)} ${String(p.ms).padStart(8)} ms  cpu ${String(p.cpuMs ?? "-").padStart(7)} ms (${cores.padStart(4)} cores)  ${String(p.peakRssMb ?? "-").padStart(5)} MB`;
  });
  console.info(`\n[bench] ${label} — ${pages} pages — ${total} ms\n${rows.join("\n")}`);
}

async function runPhases(runId: string): Promise<PhaseTiming[]> {
  const rows = (await system(
    (tx) => tx`SELECT phase_timings FROM deploy_runs WHERE id = ${runId}::uuid`,
  )) as { phase_timings: PhaseTiming[] }[];
  return rows[0]?.phase_timings ?? [];
}

beforeAll(
  async () => {
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
    // The generator resolves MEDIA_ROOT_DIR against the repo root it builds for.
    process.env.MEDIA_ROOT_DIR = join(root, "media");
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
      await tx`DELETE FROM media_variants WHERE asset_id IN (SELECT id FROM media_assets WHERE slug LIKE 'bench-photo-%')`;
      await tx`DELETE FROM media_assets WHERE slug LIKE 'bench-photo-%'`;
    });
    const mediaStart = performance.now();
    await seedMedia(MEDIA_POOL, join(root, "media"));
    console.info(
      `[bench] seeded ${MEDIA_POOL} media in ${Math.round(performance.now() - mediaStart)} ms`,
    );
    await ok("staging_access.seed_host", { host: "staging.example.com" });

    templateId = (
      await ok<{ templateId: string }>("templates.create", {
        pageType: "home",
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
      `<section class="bhe"><img src="{{hero_image}}" alt="{{hero_title}}"><h1>{{hero_title}}</h1><p>{{hero_text}}</p><img src="{{inline_a}}" alt="a"><img src="{{inline_b}}" alt="b"></section>`,
      ".bhe{padding:4rem 1rem}.bhe h1{font-size:3rem}",
      ["hero_title", "hero_text", "hero_image", "inline_a", "inline_b"],
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
  },
  30 * 60 * 1000,
);

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
          const rss = samplePeakRss();
          const staged = await ok<{ runId: string; phases: PhaseTiming[] }>("deploy.trigger", {
            targetName: "staging",
            repoRoot: root,
          });
          const wall = Math.round(performance.now() - t);
          const peak = await rss.stop();
          console.info(
            `[bench] ${label} wall ${wall} ms, peak RSS admin ${peak.adminMb} MB (at start ${peak.adminStartMb} MB), generator ${peak.generatorMb} MB`,
          );
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
        const rss = samplePeakRss();
        const promoted = await publish<{ toRunId: string }>({
          fromTarget: "staging",
          toTarget: "production",
          repoRoot: root,
        });
        const wall = Math.round(performance.now() - t);
        const peak = await rss.stop();
        console.info(
          `[bench] Publish live wall ${wall} ms, peak RSS admin ${peak.adminMb} MB (at start ${peak.adminStartMb} MB), generator ${peak.generatorMb} MB`,
        );
        reportIdle("Publish live", await idle.stop());
        report("Publish live", n, await runPhases(promoted.toRunId));
      },
      { timeout: 60 * 60 * 1000 },
    );
  }
});
