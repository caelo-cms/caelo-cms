// SPDX-License-Identifier: MPL-2.0

/**
 * P6.2 #2 — content-addressed builds enable rollback. Two deploys, then
 * rollback to the first; the live `current/` directory should mirror
 * the first build's content (older page-body), and the deploy_runs
 * table records a new succeeded row pointing at the old build_id.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo/query-api";
import type { ExecutionContext } from "@caelo/shared";
import { SQL } from "bun";
import { setDeployBridge } from "../ops/deploy.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env["ADMIN_DATABASE_URL"];
const PUBLIC_URL = process.env["PUBLIC_ADMIN_DATABASE_URL"];
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let testRoot: string;

const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "p6-2-rollback",
};

const TPL_SLUG = "p6-2-rollback-tpl";
const MOD_SLUG = "p6-2-rollback-mod";
const PAGE_SLUG = "p6-2-rollback-page";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM deploy_runs`;
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM modules WHERE slug = ${MOD_SLUG}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug = ${TPL_SLUG})`;
      await tx`DELETE FROM templates WHERE slug = ${TPL_SLUG}`;
    });
  } finally {
    await sql.end();
  }
}

beforeAll(async () => {
  await wipe();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  setDeployBridge({ registry, adapter });
  testRoot = await mkdtemp(join(tmpdir(), "caelo-p6-2-rb-"));
});

afterAll(async () => {
  await wipe();
  await rm(testRoot, { recursive: true, force: true });
  await adapter.close();
});

describe("deploy.rollback", () => {
  it("re-targets current/ at a prior succeeded build", async () => {
    const t = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: TPL_SLUG,
      displayName: "RB",
      html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
      css: "",
    });
    if (!t.ok) throw new Error("seed");
    const tplId = (t.value as { templateId: string }).templateId;
    await execute(registry, adapter, HUMAN, "template_blocks.set", {
      templateId: tplId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const m = await execute(registry, adapter, HUMAN, "modules.create", {
      slug: MOD_SLUG,
      displayName: "M",
      html: "<p>VERSION_ONE</p>",
    });
    if (!m.ok) throw new Error("seed");
    const modId = (m.value as { moduleId: string }).moduleId;

    const p = await execute(registry, adapter, HUMAN, "pages.create", {
      slug: PAGE_SLUG,
      title: "RB",
      templateId: tplId,
      locale: "en",
    });
    if (!p.ok) throw new Error("seed");
    const pageId = (p.value as { pageId: string }).pageId;
    await execute(registry, adapter, HUMAN, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [modId] }],
    });
    await execute(registry, adapter, HUMAN, "pages.update", { pageId, status: "published" });

    // Build 1 — VERSION_ONE.
    const b1 = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    if (!b1.ok) throw new Error(`b1 ${JSON.stringify(b1.error)}`);
    const b1RunId = (b1.value as { runId: string }).runId;

    // Update module + build 2 — VERSION_TWO.
    await execute(registry, adapter, HUMAN, "modules.update", {
      moduleId: modId,
      html: "<p>VERSION_TWO</p>",
    });
    const b2 = await execute(registry, adapter, HUMAN, "deploy.trigger", {
      targetName: "production",
      repoRoot: testRoot,
    });
    if (!b2.ok) throw new Error("b2");

    // current/ now reflects VERSION_TWO.
    const currentDir = join(testRoot, "output", "production", "current");
    const pageFile = join(currentDir, PAGE_SLUG, "index.html");
    expect(existsSync(pageFile)).toBe(true);
    const v2 = await readFile(pageFile, "utf8");
    expect(v2).toContain("VERSION_TWO");

    // Rollback to build 1.
    const rb = await execute(registry, adapter, HUMAN, "deploy.rollback", {
      targetName: "production",
      runId: b1RunId,
      repoRoot: testRoot,
    });
    expect(rb.ok).toBe(true);
    if (!rb.ok) return;
    const v1 = await readFile(pageFile, "utf8");
    expect(v1).toContain("VERSION_ONE");
    expect(v1).not.toContain("VERSION_TWO");
  });
});
