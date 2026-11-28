// SPDX-License-Identifier: MPL-2.0

/**
 * Data imports (docs/data-imports.md) against real Postgres: the pipeline
 * (file, checks, pages, parents, idempotency, dry run, undo), the release
 * rule (draft -> build -> staging -> live, rollback by pointer), and the
 * kinds `comments` (the real plugin's apply and remove operations) and
 * `redirects` (core).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import commentsPlugin from "@caelo-cms/plugin-comments";
import type { PluginContextTier1, PluginImportKind } from "@caelo-cms/plugin-sdk";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, MediaStorageAdapter } from "@caelo-cms/shared";
import { SQL } from "bun";
import { type ImportKind, pluginImportKind } from "../data-imports/kinds.js";
import { redirectsImportKind } from "../data-imports/kinds-redirects.js";
import { mergeChatImports, stampImportsForRun } from "../data-imports/release.js";
import { type DataImportDeps, runDataImport, undoDataImport } from "../data-imports/run.js";
import { drainProjectionOnce, stagingPublicAdapter } from "../public-projection.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
const STAGING_URL = process.env.PUBLIC_STAGING_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL || !STAGING_URL) throw new Error("DB URLs required");

const P = "tdi";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: `${P}-system`,
};
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000d1001",
  actorKind: "human",
  requestId: `${P}-human`,
};
const PLUGIN_ID = "00000000-0000-0000-0000-0000000d1002";

let adapter: DatabaseAdapter;
let staging: DatabaseAdapter;
let registry: OperationRegistry;
let pageId = "";
let targetId = "";

/** A media store in memory: uploads never touch the disk here. */
const files = new Map<string, Uint8Array>();
const storage: MediaStorageAdapter = {
  put: async (key, body) => {
    files.set(key, body);
  },
  get: async (key) => {
    const b = files.get(key);
    if (!b) throw new Error(`no object ${key}`);
    return b;
  },
  size: async (key) => files.get(key)?.byteLength ?? 0,
  openStream: async () => {
    throw new Error("not used");
  },
  delete: async (key) => {
    files.delete(key);
  },
  exists: async (key) => files.has(key),
  totalSizeBytes: async () => 0,
};

async function admin<T>(fn: (tx: SQL) => Promise<T>, url = ADMIN_URL as string): Promise<T> {
  const conn = new SQL(url);
  try {
    return (await conn.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      return fn(tx as unknown as SQL);
    })) as T;
  } finally {
    await conn.end();
  }
}

/** The comments plugin's context: `ctx.cms.call` runs the real core operations, as the plugin. */
function pluginCtx(): PluginContextTier1 {
  return {
    invocation: { origin: "chat", actorId: HUMAN.actorId },
    cms: {
      call: async (name: string, input: unknown) => {
        const r = await execute(registry, adapter, { ...SYSTEM, pluginId: PLUGIN_ID }, name, input);
        if (!r.ok) throw new Error(`${name} failed: ${JSON.stringify(r.error)}`);
        return r.value;
      },
    },
  } as unknown as PluginContextTier1;
}

/** The comments kind as the host builds it, running the plugin's own operations. */
function commentsKind(): ImportKind {
  const decl = (commentsPlugin.imports ?? [])[0] as PluginImportKind;
  return pluginImportKind("comments", decl, async (opts) => {
    const op = (commentsPlugin.operations as Record<string, (c: unknown, a: unknown) => unknown>)[
      opts.operationName
    ];
    if (!op) return { ok: false, error: { message: `no operation ${opts.operationName}` } };
    try {
      return { ok: true, value: await op(pluginCtx(), opts.args) };
    } catch (e) {
      return { ok: false, error: { message: e instanceof Error ? e.message : String(e) } };
    }
  });
}

function deps(): DataImportDeps {
  return {
    registry,
    adapter,
    storage: () => storage,
    kinds: () => [commentsKind(), redirectsImportKind],
  };
}

const CALLER = {
  ctx: HUMAN,
  invocation: { origin: "owner-panel" as const, actorId: HUMAN.actorId },
};

/** Store `text` as an upload, the way the upload routes do. */
async function upload(filename: string, text: string): Promise<string> {
  const key = `data-uploads/test/${crypto.randomUUID()}`;
  const bytes = new TextEncoder().encode(text);
  await storage.put(key, bytes, "application/octet-stream");
  const r = await execute(registry, adapter, HUMAN, "data_uploads.record", {
    filename,
    format: filename.endsWith(".csv") ? "csv" : "jsonl",
    byteSize: bytes.byteLength,
    sha256: "0".repeat(64),
    storageKey: key,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { uploadId: string }).uploadId;
}

async function importOk(input: Parameters<typeof runDataImport>[2]) {
  const r = await runDataImport(deps(), CALLER, input);
  if (!r.ok) throw new Error(r.message);
  return r.report;
}

/** A finished deploy run started at `startedAt`, for the release pointers. */
async function run(startedAt: string): Promise<string> {
  return admin(async (tx) => {
    const [r] = (await tx`
      INSERT INTO deploy_runs (target_id, actor_id, status, started_at, finished_at)
      VALUES (${targetId}::uuid, ${SYSTEM.actorId}::uuid, 'succeeded', ${startedAt}::timestamptz, now())
      RETURNING id::text AS id`) as { id: string }[];
    const empty = JSON.stringify({
      version: 1,
      plugins: [],
      grants: [],
      pluginRows: [],
      projected: [],
    });
    await tx`INSERT INTO projection_releases (run_id, reason, state)
             VALUES (${r?.id}::uuid, 'stage', ${empty}::text::jsonb)`;
    return r?.id ?? "";
  });
}

async function point(env: "live" | "staging", runId: string): Promise<void> {
  await admin(async (tx) => {
    await tx`
      INSERT INTO projection_release_pointers (environment, run_id) VALUES (${env}, ${runId}::uuid)
      ON CONFLICT (environment) DO UPDATE SET run_id = EXCLUDED.run_id, pointed_at = now()`;
  });
  await drainProjectionOnce(adapter, staging);
}

async function stamp(runId: string): Promise<void> {
  await adapter.withAdminTransaction(SYSTEM, (tx) => stampImportsForRun(tx, runId));
}

async function published(url: string): Promise<string[]> {
  return admin(
    async (tx) =>
      (
        (await tx`SELECT author_name FROM published_comments WHERE page_id = ${pageId}::uuid
                  ORDER BY author_name`) as { author_name: string }[]
      ).map((r) => r.author_name),
    url,
  );
}

/** The page's comments as a read shows them: a build of `run`, the live release, or the draft. */
async function archived(view?: { build: string } | "live"): Promise<string[]> {
  const renderImportView =
    view === undefined
      ? undefined
      : view === "live"
        ? ({ kind: "live" } as const)
        : ({ kind: "build", runId: view.build } as const);
  const r = await execute(
    registry,
    adapter,
    { ...SYSTEM, ...(renderImportView ? { renderImportView } : {}) },
    "comment_archive.list_for_page",
    { pageId, limit: 500 },
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return (r.value as { comments: { authorName: string }[] }).comments
    .map((c) => c.authorName)
    .sort();
}

async function wipe(): Promise<void> {
  await admin(async (tx) => {
    await tx`DELETE FROM projection_release_pointers`;
    await tx`DELETE FROM comment_archive WHERE page_id = ${pageId || "00000000-0000-0000-0000-000000000000"}::uuid`;
    await tx`DELETE FROM data_imports`;
    await tx`DELETE FROM data_uploads`;
    await tx`DELETE FROM pending_redirects WHERE address LIKE ${`/${P}-%`}`;
  });
}

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  staging = stagingPublicAdapter(STAGING_URL);
  registry = new OperationRegistry();
  registerAdminOps(registry);
  await admin(async (tx) => {
    await tx`INSERT INTO actors (id, kind, display_name) VALUES (${HUMAN.actorId}::uuid, 'human', 'Importer')
             ON CONFLICT DO NOTHING`;
    // Another file may have left the shipped plugin's row; this test needs its id.
    await tx`DELETE FROM plugins WHERE slug = 'comments' AND id <> ${PLUGIN_ID}::uuid`;
    await tx`INSERT INTO plugins (id, slug, version, tier, manifest_json, manifest_signature, submitted_by)
             VALUES (${PLUGIN_ID}::uuid, 'comments', '1.5.0', 1, '{}'::jsonb, 'test', ${SYSTEM.actorId}::uuid)
             ON CONFLICT DO NOTHING`;
    const [tpl] = (await tx`
      SELECT t.id::text AS id FROM templates t
       WHERE t.deleted_at IS NULL
         AND (SELECT count(*) FROM page_types pt
               WHERE pt.deleted_at IS NULL AND pt.chat_branch_id IS NULL
                 AND pt.definition->'templates' ? t.id::text) = 1
       ORDER BY t.slug LIMIT 1`) as { id: string }[];
    const [page] = (await tx`
      INSERT INTO pages (slug, title, template_id, current_path, page_type_confirmed)
      VALUES (${`${P}-page`}, 'P', ${tpl?.id}::uuid, ${`/${P}-page`}, true)
      RETURNING id::text AS id`) as { id: string }[];
    pageId = page?.id ?? "";
    await tx`INSERT INTO redirects (from_path, to_path, status_code, created_by)
             VALUES (${`/${P}-old/hello`}, ${`/${P}-page`}, 301, ${SYSTEM.actorId}::uuid)
             ON CONFLICT DO NOTHING`;
    const [target] = (await tx`
      INSERT INTO deploy_targets (env, name, out_dir) VALUES ('staging', ${`${P}-target`}, '/tmp/tdi')
      RETURNING id::text AS id`) as { id: string }[];
    targetId = target?.id ?? "";
  });
  await wipe();
});

afterAll(async () => {
  await wipe();
  await admin(async (tx) => {
    await tx`DELETE FROM projection_releases WHERE run_id IN (SELECT id FROM deploy_runs WHERE target_id = ${targetId}::uuid)`;
    await tx`DELETE FROM deploy_runs WHERE target_id = ${targetId}::uuid`;
    await tx`DELETE FROM deploy_targets WHERE id = ${targetId}::uuid`;
    await tx`DELETE FROM redirects WHERE from_path LIKE ${`/${P}-%`}`;
    await tx`DELETE FROM pages WHERE id = ${pageId}::uuid`;
    await tx`DELETE FROM plugins WHERE id = ${PLUGIN_ID}::uuid`;
  });
  await drainProjectionOnce(adapter, staging);
  await adapter.close();
  await staging.close();
});

const CSV = [
  "sourceKey,parentKey,page,authorName,content,submittedAt",
  `wp:1,,/${P}-page,Anna,"Hello,\nworld",2019-05-04T10:00:00Z`,
  `wp:2,wp:1,https://old.example.com/${P}-old/hello/,Ben,Reply,2019-05-04 12:00:00+02:00`,
  "wp:3,,/nowhere,Carl,Lost,2019-05-04T10:00:00Z",
].join("\n");

describe("importing comments from a file", () => {
  let importId = "";

  it("refuses to write while rows have problems, and says which", async () => {
    const uploadId = await upload("comments.csv", CSV);
    const report = await importOk({
      kind: "comments",
      uploadIds: [uploadId],
      sourceLabel: "WordPress test",
    });
    expect(report.written).toBe(false);
    expect(report.counts).toMatchObject({ rows: 3, imported: 2, invalid: 1 });
    expect(report.problems.map((p) => [p.reason, p.count])).toEqual([["page-not-found", 1]]);
    expect(await archived()).toEqual([]);
  });

  it("imports the good rows with skipInvalid: pages by path and by an old URL's redirect, parents kept", async () => {
    const uploadId = await upload("comments.csv", CSV);
    const report = await importOk({
      kind: "comments",
      uploadIds: [uploadId],
      sourceLabel: "WordPress test",
      skipInvalid: true,
    });
    expect(report.counts).toMatchObject({ imported: 2, invalid: 1 });
    importId = report.importId ?? "";
    expect(report.state).toBe("draft");
    const rows = await admin(
      (tx) => tx`SELECT id::text AS id, parent_id::text AS parent_id, author_name, content,
                        archived_at = submitted_at AS dated, data_import_id::text AS import_id
                 FROM comment_archive WHERE page_id = ${pageId}::uuid ORDER BY author_name`,
    );
    expect(rows).toHaveLength(2);
    const [anna, ben] = rows as {
      id: string;
      parent_id: string | null;
      content: string;
      dated: boolean;
      import_id: string;
    }[];
    expect(anna?.content).toBe("Hello,\nworld");
    expect(ben?.parent_id).toBe(anna?.id ?? "");
    expect(anna?.dated && ben?.dated).toBe(true);
    expect(anna?.import_id).toBe(importId);
  });

  it("skips what an import already holds, whether it is the same import or another", async () => {
    const again = await importOk({
      kind: "comments",
      uploadIds: [await upload("comments.csv", CSV)],
      importId,
      skipInvalid: true,
    });
    expect(again.counts).toMatchObject({ imported: 0, unchanged: 2 });
    const other = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "wp:1",
          page: `/${P}-page`,
          authorName: "Anna",
          content: "Changed",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "second try",
    });
    expect(other.counts).toMatchObject({ imported: 0, unchanged: 1 });
    expect(await archived()).toEqual(["Anna", "Ben"]);
  });

  it("refuses columns the kind does not take, before reading a row", async () => {
    const r = await runDataImport(deps(), CALLER, {
      kind: "comments",
      rows: [
        {
          sourceKey: "wp:9",
          page: `/${P}-page`,
          authorName: "E",
          content: "x",
          submittedAt: "2019-05-04T10:00:00Z",
          email: "e@example.com",
        },
      ],
      sourceLabel: "x",
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.message).toContain("drop email");
  });

  it("lets the plugin refuse a row it cannot show (HTML) and reports a parent loop", async () => {
    const report = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "h:1",
          page: `/${P}-page`,
          authorName: "H",
          content: "<p>tag</p>",
          submittedAt: "2019-05-04T10:00:00Z",
        },
        {
          sourceKey: "c:1",
          parentKey: "c:2",
          page: `/${P}-page`,
          authorName: "C1",
          content: "a",
          submittedAt: "2019-05-04T10:00:00Z",
        },
        {
          sourceKey: "c:2",
          parentKey: "c:1",
          page: `/${P}-page`,
          authorName: "C2",
          content: "b",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "edge cases",
      skipInvalid: true,
    });
    expect(report.problems.map((p) => p.reason).sort()).toEqual(["parent-not-found", "refused"]);
    expect(report.counts.imported).toBe(0);
    await undoDataImport(deps(), CALLER, report.importId ?? "");
  });

  it("writes nothing on a dry run", async () => {
    const report = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "d:1",
          page: `/${P}-page`,
          authorName: "Dry",
          content: "x",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "dry",
      dryRun: true,
    });
    expect(report).toMatchObject({ dryRun: true, written: false, importId: null });
    expect(report.counts.imported).toBe(1);
    expect(await archived()).toEqual(["Anna", "Ben"]);
  });

  it("is a draft: no build, staging or live database shows it", async () => {
    const earlier = await run("2026-09-01T10:00:00Z");
    expect(await archived({ build: earlier })).toEqual([]);
    expect(await archived("live")).toEqual([]);
    await drainProjectionOnce(adapter, staging);
    expect(await published(STAGING_URL as string)).toEqual([]);
    expect(await published(PUBLIC_URL as string)).toEqual([]);
  });

  let r1 = "";
  it("goes to staging with the Stage build that stamps it, and live with the Publish live of that run", async () => {
    r1 = await run("2026-11-01T10:00:00Z");
    await stamp(r1);
    expect(await archived({ build: r1 })).toEqual(["Anna", "Ben"]);
    expect(await archived("live")).toEqual([]);
    await point("staging", r1);
    expect(await published(STAGING_URL as string)).toEqual(["Anna", "Ben"]);
    expect(await published(PUBLIC_URL as string)).toEqual([]);
    await point("live", r1);
    expect(await published(PUBLIC_URL as string)).toEqual(["Anna", "Ben"]);
    expect(await archived("live")).toEqual(["Anna", "Ben"]);
  });

  it("leaves live with a rollback to a release before it, and comes back with the release", async () => {
    const r0 = await run("2026-10-01T10:00:00Z");
    await point("live", r0);
    expect(await published(PUBLIC_URL as string)).toEqual([]);
    expect(await published(STAGING_URL as string)).toEqual(["Anna", "Ben"]);
    await point("live", r1);
    expect(await published(PUBLIC_URL as string)).toEqual(["Anna", "Ben"]);
  });

  it("undone after it shipped: rows stay until the undo ships, and the keys are free again", async () => {
    const undo = await undoDataImport(deps(), CALLER, importId);
    expect(undo.ok).toBe(true);
    expect(undo.ok && undo.undo.state).toBe("undo-pending");
    expect(await archived()).toEqual([]);
    const r2 = await run("2026-11-02T10:00:00Z");
    await stamp(r2);
    expect(await archived({ build: r2 })).toEqual([]);
    // A build that started before the undo was stamped still carries them.
    expect(await archived({ build: r1 })).toEqual(["Anna", "Ben"]);
    await point("staging", r2);
    expect(await published(STAGING_URL as string)).toEqual([]);
    expect(await published(PUBLIC_URL as string)).toEqual(["Anna", "Ben"]);
    await point("live", r2);
    expect(await published(PUBLIC_URL as string)).toEqual([]);
    const again = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "wp:1",
          page: `/${P}-page`,
          authorName: "Anna",
          content: "Again",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "re-import",
    });
    expect(again.counts.imported).toBe(1);
  });

  it("undone before any build carried it: its rows are removed at once", async () => {
    const list = await execute(registry, adapter, HUMAN, "data_imports.list", { kind: "comments" });
    const fresh = (
      list.ok
        ? (list.value as { imports: { importId: string; sourceLabel: string }[] }).imports
        : []
    ).find((i) => i.sourceLabel === "re-import");
    const undo = await undoDataImport(deps(), CALLER, fresh?.importId ?? "");
    expect(undo.ok && undo.undo.state).toBe("undone");
    const left = await admin(
      (tx) => tx`SELECT 1 FROM comment_archive WHERE data_import_id = ${fresh?.importId}::uuid`,
    );
    expect(left).toHaveLength(0);
  });
});

describe("a chat's import", () => {
  it("waits for the Stage that ships its chat", async () => {
    const chat = await admin(async (tx) => {
      const [s] = (await tx`
        INSERT INTO chat_sessions (created_by, title, chat_branch_id)
        VALUES (${HUMAN.actorId}::uuid, 'tdi chat', gen_random_uuid())
        RETURNING id::text AS id`) as { id: string }[];
      return s?.id ?? "";
    });
    const r = await runDataImport(
      deps(),
      { ...CALLER, chatSessionId: chat },
      {
        kind: "comments",
        rows: [
          {
            sourceKey: "chat:1",
            page: `/${P}-page`,
            authorName: "Chatty",
            content: "x",
            submittedAt: "2019-05-04T10:00:00Z",
          },
        ],
        sourceLabel: "chat import",
      },
    );
    if (!r.ok) throw new Error(r.message);
    const r3 = await run("2026-11-03T10:00:00Z");
    await stamp(r3);
    expect(await archived({ build: r3 })).not.toContain("Chatty");
    await adapter.withAdminTransaction(SYSTEM, (tx) => mergeChatImports(tx, [chat]));
    const r4 = await run("2026-11-04T10:00:00Z");
    await stamp(r4);
    expect(await archived({ build: r4 })).toContain("Chatty");
    // Codex review: a later Stage's stamp never reaches an earlier build.
    expect(await archived({ build: r3 })).not.toContain("Chatty");
    await undoDataImport(deps(), CALLER, r.report.importId ?? "");
  });
});

describe("review findings", () => {
  it("a reply in a new import keeps the parent an earlier import holds", async () => {
    const first = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "p:1",
          page: `/${P}-page`,
          authorName: "Parent",
          content: "p",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "first",
    });
    const second = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "p:1",
          page: `/${P}-page`,
          authorName: "Parent",
          content: "p",
          submittedAt: "2019-05-04T10:00:00Z",
        },
        {
          sourceKey: "p:2",
          parentKey: "p:1",
          page: `/${P}-page`,
          authorName: "Child",
          content: "c",
          submittedAt: "2019-05-04T11:00:00Z",
        },
      ],
      sourceLabel: "second",
    });
    expect(second.counts).toMatchObject({ imported: 1, unchanged: 1 });
    const [parent] = (await admin(
      (tx) =>
        tx`SELECT id::text AS id FROM comment_archive WHERE data_import_id = ${first.importId}::uuid`,
    )) as { id: string }[];
    const [child] = (await admin(
      (tx) =>
        tx`SELECT parent_id::text AS parent_id FROM comment_archive WHERE data_import_id = ${second.importId}::uuid`,
    )) as { parent_id: string }[];
    expect(child?.parent_id).toBe(parent?.id ?? "");
    await undoDataImport(deps(), CALLER, second.importId ?? "");
    await undoDataImport(deps(), CALLER, first.importId ?? "");
  });

  it("a reply whose parent the plugin refused is not written either", async () => {
    const report = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "r:1",
          page: `/${P}-page`,
          authorName: "R1",
          content: "<b>tag</b>",
          submittedAt: "2019-05-04T10:00:00Z",
        },
        {
          sourceKey: "r:2",
          parentKey: "r:1",
          page: `/${P}-page`,
          authorName: "R2",
          content: "reply",
          submittedAt: "2019-05-04T11:00:00Z",
        },
      ],
      sourceLabel: "refused parent",
      skipInvalid: true,
    });
    expect(report.counts.imported).toBe(0);
    expect(report.problems.map((p) => [p.reason, p.count])).toEqual([
      ["parent-not-found", 1],
      ["refused", 1],
    ]);
    await undoDataImport(deps(), CALLER, report.importId ?? "");
  });

  it("an undo whose removal failed can be repeated", async () => {
    let fail = true;
    const flaky: ImportKind = {
      ...commentsKind(),
      remove: async (w, importId, refs) => {
        if (fail) throw new Error("storage away");
        await commentsKind().remove(w, importId, refs);
      },
    };
    const d: DataImportDeps = { ...deps(), kinds: () => [flaky, redirectsImportKind] };
    const report = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "u:1",
          page: `/${P}-page`,
          authorName: "U",
          content: "u",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "flaky undo",
    });
    const first = await undoDataImport(d, CALLER, report.importId ?? "");
    expect(first.ok).toBe(false);
    const got = await execute(registry, adapter, HUMAN, "data_imports.get", {
      importId: report.importId,
    });
    expect(got.ok && (got.value as { state: string }).state).toBe("removal-pending");
    fail = false;
    const again = await undoDataImport(d, CALLER, report.importId ?? "");
    expect(again.ok && again.undo.state).toBe("undone");
    const left = await admin(
      (tx) => tx`SELECT 1 FROM comment_archive WHERE data_import_id = ${report.importId}::uuid`,
    );
    expect(left).toHaveLength(0);
  });

  it("a chat whose only change is an import is an open change", async () => {
    const chat = await admin(async (tx) => {
      const [s] = (await tx`
        INSERT INTO chat_sessions (created_by, title, chat_branch_id, branch_kind)
        VALUES (${HUMAN.actorId}::uuid, 'tdi open', gen_random_uuid(), 'draft')
        RETURNING id::text AS id`) as { id: string }[];
      return s?.id ?? "";
    });
    const r = await runDataImport(
      deps(),
      { ...CALLER, chatSessionId: chat },
      {
        kind: "comments",
        rows: [
          {
            sourceKey: "o:1",
            page: `/${P}-page`,
            authorName: "O",
            content: "o",
            submittedAt: "2019-05-04T10:00:00Z",
          },
        ],
        sourceLabel: "open change",
      },
    );
    if (!r.ok) throw new Error(r.message);
    const open = await execute(registry, adapter, HUMAN, "chat.list_open_changes", {
      mineOnly: true,
    });
    if (!open.ok) throw new Error(JSON.stringify(open.error));
    const mine = (
      open.value as {
        chats: { chatSessionId: string; pendingCount: number; pendingImports: number }[];
      }
    ).chats.find((c) => c.chatSessionId === chat);
    expect(mine).toMatchObject({ pendingImports: 1, pendingCount: 1 });
    await undoDataImport(deps(), CALLER, r.report.importId ?? "");
  });

  it("pages the list by exact time and id", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await execute(registry, adapter, HUMAN, "data_imports.open", {
        owner: "core",
        kind: "redirects",
        release: "target",
        sourceLabel: `page ${i}`,
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      ids.push((r.value as { importId: string }).importId);
    }
    // One instant for all three: only the id tells them apart.
    await admin(
      (tx) =>
        tx`UPDATE data_imports SET created_at = '2026-11-20T10:00:00.123456Z' WHERE id = ANY(${ids}::uuid[])`,
    );
    const seen: string[] = [];
    let cursor: unknown;
    for (let i = 0; i < 100; i++) {
      const r = await execute(registry, adapter, HUMAN, "data_imports.list", {
        kind: "redirects",
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      const v = r.value as { imports: { importId: string }[]; nextCursor: unknown };
      seen.push(...v.imports.map((x) => x.importId).filter((x) => ids.includes(x)));
      if (!v.nextCursor) break;
      cursor = v.nextCursor;
    }
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(seen).toHaveLength(3);
  });
});

describe("importing redirects", () => {
  it("saves them as pending changes, refuses an address it did not write, and undoes only its own", async () => {
    const report = await importOk({
      kind: "redirects",
      rows: [
        { sourceKey: `/${P}-a`, fromPath: `/${P}-a`, toPath: `/${P}-page`, statusCode: "301" },
      ],
      sourceLabel: "Yoast",
    });
    expect(report.counts.imported).toBe(1);
    expect(report.state).toBe("written");
    const pending = await admin(
      (tx) => tx`SELECT state FROM pending_redirects WHERE address = ${`/${P}-a`}`,
    );
    expect(pending).toEqual([{ state: "staged" }]);
    const second = await importOk({
      kind: "redirects",
      rows: [{ sourceKey: `/${P}-a`, fromPath: `/${P}-a`, toPath: `/${P}-page` }],
      sourceLabel: "again",
    });
    expect(second.counts).toMatchObject({ imported: 0, unchanged: 1 });
    const undo = await undoDataImport(deps(), CALLER, report.importId ?? "");
    expect(undo.ok).toBe(true);
    const after = await admin(
      (tx) => tx`SELECT to_path FROM pending_redirects WHERE address = ${`/${P}-a`}`,
    );
    expect(after.length === 0 || (after[0] as { to_path: string | null }).to_path === null).toBe(
      true,
    );
  });
});

describe("what plugins read (ctx.imports)", () => {
  it("serves the plugin its own rows as the database it writes shows them", async () => {
    const read = (view: string) =>
      execute(
        registry,
        adapter,
        { ...SYSTEM, actorKind: "plugin", pluginId: PLUGIN_ID },
        "data_imports.plugin_rows",
        {
          kind: "comments",
          view,
        },
      );
    const report = await importOk({
      kind: "comments",
      rows: [
        {
          sourceKey: "pr:1",
          page: `/${P}-page`,
          authorName: "Rows",
          content: "x",
          submittedAt: "2019-05-04T10:00:00Z",
        },
      ],
      sourceLabel: "plugin rows",
    });
    const count = async (view: string) => {
      const r = await read(view);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return (r.value as { rows: { sourceKey: string }[] }).rows.filter(
        (x) => x.sourceKey === "pr:1",
      ).length;
    };
    expect(await count("draft")).toBe(1);
    expect(await count("live")).toBe(0);
    const r5 = await run("2026-11-05T10:00:00Z");
    await stamp(r5);
    await point("live", r5);
    expect(await count("live")).toBe(1);
    expect(await count("staging")).toBe(0);
    await undoDataImport(deps(), CALLER, report.importId ?? "");
  });
});
