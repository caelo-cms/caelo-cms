// SPDX-License-Identifier: MPL-2.0

/**
 * Regression (live-edit run A2, homepage max_loops crash): the preview's
 * nested-module BFS loader read module CODE and instance VALUES from the
 * LIVE tables only. A branched edit_module / set_values on a nested
 * (detached, {{>slot}}-embedded) module landed in *_snapshots — so the
 * render kept showing the stale live code and the AI spiralled on
 * "my edits don't propagate" until the loop cap. This is the THIRD read
 * path of the run-#8-R3 overlay class (page modules + layout chrome are
 * covered elsewhere).
 *
 * Sequence pinned = the AI's turn: build_page with a detached button
 * ($ref-nested into a teaser) → branched modules.update on the button
 * CSS → render_preview MUST show the new CSS. Real Postgres (§6).
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
const HUMAN: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "nested-overlay",
};

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM page_modules WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE ${`nmo-%-${TS}`})`;
      await tx`DELETE FROM pages WHERE slug LIKE ${`nmo-%-${TS}`}`;
      await tx`DELETE FROM content_instances WHERE module_id IN (SELECT id FROM modules WHERE display_name LIKE 'NMO %')`;
      await tx`DELETE FROM modules WHERE display_name LIKE ${"NMO %"}`;
      await tx`DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE slug LIKE ${`nmo-%-${TS}`})`;
      await tx`DELETE FROM templates WHERE slug LIKE ${`nmo-%-${TS}`}`;
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
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("nested-module branch overlay (run-A2 regression)", () => {
  it("a branched edit to a detached nested module SHOWS in render_preview", async () => {
    const tpl = await execute(registry, adapter, HUMAN, "templates.create", {
      slug: `nmo-tpl-${TS}`,
      displayName: "NMO T",
      html: `<!doctype html><html><head><title>T</title></head><body><caelo-slot name="content">_</caelo-slot></body></html>`,
    });
    if (!tpl.ok) throw new Error("tpl");
    const templateId = (tpl.value as { templateId: string }).templateId;
    await execute(registry, adapter, HUMAN, "template_blocks.set", {
      templateId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });

    const session = await execute(registry, adapter, HUMAN, "chat.create_session", {
      title: `nmo-${TS}`,
    });
    if (!session.ok) throw new Error("session");
    const { chatBranchId } = session.value as { chatBranchId: string };
    const AI: ExecutionContext = {
      actorId: "00000000-0000-0000-0000-000000000a1a",
      actorKind: "ai",
      requestId: "nmo-ai",
      chatBranchId,
      chatTaskId: chatBranchId,
    };

    // 1. The AI's build: detached button, $ref-nested into the teaser.
    const built = await execute(registry, adapter, AI, "pages.build_page", {
      page: { slug: `nmo-page-${TS}`, title: "NMO", templateId },
      modules: [
        {
          ref: "btn",
          displayName: "NMO Button",
          description: "Nested-only button.",
          kind: "cta",
          type: "button",
          html: "<button>{{label}}</button>",
          css: ".btn { color: color-mix(in srgb, red 50%, blue) }",
          fields: [{ name: "label", kind: "text", label: "Label" }],
          content: { source: "inline", values: { label: "Click" } },
        },
        {
          blockName: "content",
          displayName: "NMO Teaser",
          description: "Teaser embedding the button.",
          kind: "cta",
          html: "<section>{{>cta}}</section>",
          fields: [{ name: "cta", kind: "module", label: "CTA" }],
          content: { source: "inline", values: { cta: { $ref: "btn" } } },
        },
      ],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const { pageId } = built.value as { pageId: string };
    const buttonId = (built.value as { detached: { moduleId: string }[] }).detached[0]
      ?.moduleId as string;

    // Baseline: the nested button's original CSS is in the render.
    const before = await execute(registry, adapter, HUMAN, "pages.render_preview", {
      pageId,
      chatBranchId,
    });
    if (!before.ok) throw new Error("preview before");
    expect((before.value as { html: string }).html).toContain("color-mix");

    // 2. The AI's fix attempt: branched edit removing color-mix.
    const edit = await execute(registry, adapter, AI, "modules.update", {
      moduleId: buttonId,
      css: ".btn { color: rgb(128, 0, 128) }",
    });
    expect(edit.ok).toBe(true);

    // 3. The render MUST show the branched CSS — pre-fix it kept the
    //    stale live color-mix and the AI looped to death on re-edits.
    const after = await execute(registry, adapter, HUMAN, "pages.render_preview", {
      pageId,
      chatBranchId,
    });
    if (!after.ok) throw new Error("preview after");
    const html = (after.value as { html: string }).html;
    expect(html).toContain("rgb(128, 0, 128)");
    expect(html).not.toContain("color-mix");
  });
});
