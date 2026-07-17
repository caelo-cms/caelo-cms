// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (live-edit run B, nested-modules max_loops crash):
 * `pages.set_modules` must PRESERVE surviving placements' content
 * bindings across position shifts, in the BRANCHED path.
 *
 * The broken behaviour had two halves:
 *   1. priors were read from live `page_modules` — empty for branched
 *      callers, so every set_modules re-minted every instance;
 *   2. matching was position-strict, so removing placement 0 shifted
 *      the survivor onto a "different" slot and minted it a fresh EMPTY
 *      instance — the authored `cta` value vanished and the render
 *      emitted `module-ref-malformed`.
 *
 * Sequence pinned here = the AI's exact turn: place [button, teaser] →
 * author teaser content → remove button → teaser MUST keep its
 * instance. Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const TS = Date.now().toString(36);
const BRANCH = "d3d3d3d3-1111-4111-8111-000000000001";
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "set-modules-preserve",
};
const BRANCHED: ExecutionContext = { ...SYSTEM, chatBranchId: BRANCH, chatTaskId: BRANCH };

let templateId = "";
let pageId = "";
let buttonId = "";
let teaserId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`smbp-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`smbp-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE slug LIKE ${`smbp-%-${TS}`})`;
      await tx`DELETE FROM modules WHERE slug LIKE ${`smbp-%-${TS}`}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`smbp-%-${TS}`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`smbp-%-${TS}`}`;
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

  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: `smbp-tpl-${TS}`,
    displayName: "SMBP",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error("tpl seed");
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  const pg = await execute(registry, adapter, SYSTEM, "pages.create", {
    slug: `smbp-page-${TS}`,
    title: "SMBP",
    templateId,
  });
  if (!pg.ok) throw new Error("page seed");
  pageId = (pg.value as { pageId: string }).pageId;

  const mkModule = async (suffix: string, html: string) => {
    const r = await execute(registry, adapter, SYSTEM, "modules.create", {
      slug: `smbp-${suffix}-${TS}`,
      displayName: `SMBP ${suffix}`,
      html,
      fields: [{ name: "txt", kind: "text", label: "Text" } as never],
    });
    if (!r.ok) throw new Error(`module ${suffix}`);
    return (r.value as { moduleId: string }).moduleId;
  };
  buttonId = await mkModule("button", "<button>{{txt}}</button>");
  teaserId = await mkModule("teaser", "<section>{{txt}}</section>");
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

/** Read the branched layout's placements for the content block. */
async function branchedPlacements(): Promise<{ moduleId: string; contentInstanceId: string }[]> {
  const r = await execute(registry, adapter, BRANCHED, "pages.get_with_modules", { pageId });
  if (!r.ok) throw new Error("get_with_modules");
  const block = (
    r.value as {
      page: {
        blocks: {
          blockName: string;
          modules: { moduleId: string; contentInstanceId: string | null }[];
        }[];
      };
    }
  ).page.blocks.find((b) => b.blockName === "content");
  return (block?.modules ?? []).map((m) => ({
    moduleId: m.moduleId,
    contentInstanceId: m.contentInstanceId ?? "",
  }));
}

describe("pages.set_modules — branched binding preservation across shifts", () => {
  it("a survivor keeps its content_instance when an earlier placement is removed", async () => {
    // 1. Place [button, teaser] on the chat branch.
    const set1 = await execute(registry, adapter, BRANCHED, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [buttonId, teaserId] }],
    });
    expect(set1.ok).toBe(true);
    const before = await branchedPlacements();
    expect(before.map((p) => p.moduleId)).toEqual([buttonId, teaserId]);
    const teaserInstance = before[1]?.contentInstanceId;
    expect(teaserInstance).toBeTruthy();

    // 2. Author content on the teaser's instance (the value that used
    //    to vanish).
    const write = await execute(registry, adapter, BRANCHED, "content_instances.set_values", {
      id: teaserInstance as string,
      values: { txt: "authored copy" },
    });
    expect(write.ok).toBe(true);

    // 3. Remove the button (teaser shifts position 1 → 0).
    const set2 = await execute(registry, adapter, BRANCHED, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [teaserId] }],
    });
    expect(set2.ok).toBe(true);

    // 4. The teaser MUST keep the SAME instance (and thus its content).
    const after = await branchedPlacements();
    expect(after.map((p) => p.moduleId)).toEqual([teaserId]);
    expect(after[0]?.contentInstanceId).toBe(teaserInstance as string);
  });

  it("a repeated module keeps its bindings in relative order when one copy is removed", async () => {
    // [teaser, button, teaser] → remove the FIRST teaser → the survivor
    // teaser must inherit the SECOND teaser's binding (FIFO), never a
    // fresh empty instance.
    const set1 = await execute(registry, adapter, BRANCHED, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [teaserId, buttonId, teaserId] }],
    });
    expect(set1.ok).toBe(true);
    const before = await branchedPlacements();
    const teaserInstances = before
      .filter((p) => p.moduleId === teaserId)
      .map((p) => p.contentInstanceId);
    expect(teaserInstances.length).toBe(2);

    const set2 = await execute(registry, adapter, BRANCHED, "pages.set_modules", {
      pageId,
      blocks: [{ blockName: "content", moduleIds: [buttonId, teaserId] }],
    });
    expect(set2.ok).toBe(true);
    const after = await branchedPlacements();
    const survivor = after.find((p) => p.moduleId === teaserId);
    // FIFO: the remaining teaser consumes the first prior teaser binding.
    expect(survivor?.contentInstanceId).toBe(teaserInstances[0]);
  });
});
