// SPDX-License-Identifier: MPL-2.0

/**
 * The build_page tool result names every module by its index in the call's
 * `modules` array, and every note sits on the line of the module it is
 * about.
 *
 * Regression: e2e-livedit run 39920499600 (2026-10-23). The AI sent a
 * detached button (`modules[0]`, ref 'btn', with CSS using an unknown var)
 * and a placed CTA teaser (`modules[1]`). The result labelled the teaser's
 * placement `modules[0]` — placements were numbered by their position in
 * the placements array, which skips detached entries — and glued the
 * site-wide CSS-var warning onto the teaser's note. The AI read
 * `modules[0] → module=<teaser>` as its button and edited the wrong
 * module's CSS (`edit_content`: oldString not found).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { buildPageTool } from "../ai/tools/build-page.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "build-page-result-labels",
};

const TS = Date.now().toString(36);
const TPL_SLUG = `bplabel-tpl-${TS}`;
const PAGE_SLUG = `bplabel-home-${TS}`;

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL as string);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug = ${PAGE_SLUG})`;
      await tx`DELETE FROM pages WHERE slug = ${PAGE_SLUG}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE ${"BPLabel %"})`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"BPLabel %"}`;
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
  const tpl = await execute(registry, adapter, SYSTEM, "templates.create", {
    slug: TPL_SLUG,
    displayName: "BPLabel TPL",
    html: `<body><caelo-slot name="content">_</caelo-slot></body>`,
  });
  if (!tpl.ok) throw new Error(`template seed failed: ${JSON.stringify(tpl.error)}`);
  templateId = (tpl.value as { templateId: string }).templateId;
  await execute(registry, adapter, SYSTEM, "template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("build_page result labels", () => {
  it("labels a detached entry and a later placement by their input index", async () => {
    const r = await buildPageTool.handler(
      SYSTEM,
      {
        page: { slug: PAGE_SLUG, title: "BPLabel Home", templateId },
        modules: [
          {
            ref: "btn",
            displayName: "BPLabel Button",
            description: "A simple button with a text label.",
            kind: "cta",
            type: "button",
            html: '<button class="btn">{{label}}</button>',
            css: ".btn { color: var(--bplabel-unknown-ink, #fff); }",
            fields: [{ kind: "text", name: "label", label: "Button label" }],
            content: { source: "inline", values: { label: "Click me" } },
          },
          {
            blockName: "content",
            displayName: "BPLabel CTA Teaser",
            description: "A call-to-action teaser embedding a button.",
            kind: "cta",
            type: "cta-teaser",
            html: '<section class="cta-teaser">{{>cta}}</section>',
            css: ".cta-teaser { display: flex; }",
            fields: [
              { kind: "module", name: "cta", label: "CTA button", allowedModuleTypes: ["button"] },
            ],
            content: { source: "inline", values: { cta: { $ref: "btn" } } },
          },
        ],
      },
      { adapter, registry } as ToolContext,
    );
    expect(r.ok).toBe(true);
    const value = r.value as {
      placements: { index: number; moduleId: string }[];
      detached: { index: number; ref: string; moduleId: string }[];
    };
    expect(value.placements.map((p) => p.index)).toEqual([1]);
    expect(value.detached.map((d) => [d.index, d.ref])).toEqual([[0, "btn"]]);

    const lines = r.content.split("\n");
    const buttonId = value.detached[0]?.moduleId as string;
    const teaserId = value.placements[0]?.moduleId as string;
    // Result lines in input order, each with the entry's own index + name.
    expect(lines[1]).toStartWith(
      `modules[0] (BPLabel Button) ref='btn' → DETACHED (nested-only) module=${buttonId}`,
    );
    expect(lines[2]).toStartWith(`modules[1] (BPLabel CTA Teaser) → content#0 module=${teaserId}`);
    // The unknown-var warning is about the button's CSS and says so.
    const warning = lines.find((l) => l.includes("--bplabel-unknown-ink"));
    expect(warning).toStartWith("modules[0] (BPLabel Button): ");
    expect(lines.filter((l) => l.startsWith("modules[1]")).join("\n")).not.toContain(
      "--bplabel-unknown-ink",
    );
  });
});
