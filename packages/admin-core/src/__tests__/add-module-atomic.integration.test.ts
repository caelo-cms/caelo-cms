// SPDX-License-Identifier: MPL-2.0

/**
 * #1246 (repeat of #1149) — add_module placed the module (and in mint mode
 * created it) BEFORE applying `values` in a separate op, so a value that did
 * not fit left an empty placement and a minted module behind, and the tool
 * had to tell the AI "it IS placed, do not call add_module again". Mint,
 * placement and values are now one transaction (`pages.place_module`): a bad
 * `values` leaves the page, every page of a template and the module catalogue
 * exactly as they were, and the error says nothing was written.
 * Real Postgres (§6).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { addModuleTool } from "../ai/tools/add-module.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1246",
};
const BRANCHED: ExecutionContext = {
  ...SYSTEM,
  requestId: "i1246-branch",
  chatBranchId: "33333333-3333-4333-8333-00000000a246",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let templateId = "";
let chipsModuleId = "";

async function op<T>(name: string, input: unknown, ctx = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

const toolCtx = () => ({ registry, adapter }) as unknown as ToolContext;

interface Placement {
  moduleId: string;
  contentInstanceId: string | null;
}
async function contentBlock(pageId: string, ctx = SYSTEM): Promise<Placement[]> {
  const { page } = await op<{
    page: { blocks: { blockName: string; modules: Placement[] }[] };
  }>("pages.get_with_modules", { pageId }, ctx);
  return page.blocks.find((b) => b.blockName === "content")?.modules ?? [];
}

async function moduleNames(): Promise<string[]> {
  const { modules } = await op<{ modules: { displayName: string }[] }>("modules.list", {});
  return modules.map((m) => m.displayName);
}

async function newPage(slug: string): Promise<string> {
  const { pageId } = await op<{ pageId: string }>("pages.create", {
    slug: `${slug}-${TS}`,
    title: slug,
    templateId,
  });
  return pageId;
}

/** A `texts` entry with a field the type does not have — the #1149 value. */
const BAD_CHIPS = { chips: [{ node: "text", values: { title: "Fast" } }] };
const GOOD_CHIPS = { chips: [{ node: "text", values: { text: "Fast" } }] };

beforeAll(async () => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
  ({ templateId } = await op<{ templateId: string }>("templates.create", {
    pageType: "home",
    slug: `i1246-tpl-${TS}`,
    displayName: "T",
    html: '<body><caelo-slot name="content">_</caelo-slot></body>',
  }));
  await op("template_blocks.set", {
    templateId,
    blocks: [{ name: "content", displayName: "Content", position: 0 }],
  });
  ({ moduleId: chipsModuleId } = await op<{ moduleId: string }>("modules.create", {
    slug: `i1246-chips-${TS}`,
    displayName: "Chips",
    html: "<ul>{{#chips}}<li>{{text}}</li>{{/chips}}</ul>",
    fields: [{ name: "chips", kind: "list", label: "Chips", listType: "texts" }],
  }));
});

afterAll(async () => {
  await adapter.close();
});

describe("#1246 — add_module is all-or-nothing", () => {
  it("reuse: bad values leave the page unchanged and say nothing was written", async () => {
    const pageId = await newPage("i1246-reuse");
    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        moduleId: chipsModuleId,
        values: BAD_CHIPS,
      } as never,
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("add_module wrote nothing (the module was not placed");
    expect(r.content).toContain('Entries of list type "texts" take: text {text*}');
    expect(r.content).toContain("the target is as before");
    expect(r.content).not.toContain("IS placed");
    expect(r.content).not.toContain("list_types.get");
    expect(await contentBlock(pageId)).toEqual([]);
  });

  it("mint: bad values leave no module behind", async () => {
    const pageId = await newPage("i1246-mint");
    const r = await addModuleTool.handler(
      SYSTEM,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        displayName: `I1246 Minted ${TS}`,
        description: "Chips minted in the call.",
        kind: "content",
        html: "<ul>{{#chips}}<li>{{text}}</li>{{/chips}}</ul>",
        fields: [{ name: "chips", kind: "list", label: "Chips", listType: "texts" }],
        values: BAD_CHIPS,
      } as never,
      toolCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.content).toContain("no module was created or placed");
    expect(await contentBlock(pageId)).toEqual([]);
    expect(await moduleNames()).not.toContain(`I1246 Minted ${TS}`);
  });

  it("template: bad values leave every page of the template and the catalogue unchanged", async () => {
    // A template of its own, so earlier tests' pages are not in the fan-out.
    const { templateId: tplId } = await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `i1246-fan-${TS}`,
      displayName: "Fan",
      html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    });
    await op("template_blocks.set", {
      templateId: tplId,
      blocks: [{ name: "content", displayName: "Content", position: 0 }],
    });
    const pages: string[] = [];
    for (const n of ["a", "b"]) {
      const { pageId } = await op<{ pageId: string }>("pages.create", {
        slug: `i1246-fan-${n}-${TS}`,
        title: n,
        templateId: tplId,
      });
      pages.push(pageId);
    }
    const mint = {
      target: "template",
      targetRef: tplId,
      blockName: "content",
      position: "bottom",
      displayName: `I1246 Fan ${TS}`,
      description: "Chips on every page.",
      kind: "content",
      html: "<ul>{{#chips}}<li>{{text}}</li>{{/chips}}</ul>",
      fields: [{ name: "chips", kind: "list", label: "Chips", listType: "texts" }],
    };
    const bad = await addModuleTool.handler(
      SYSTEM,
      { ...mint, values: BAD_CHIPS } as never,
      toolCtx(),
    );
    expect(bad.ok).toBe(false);
    expect(bad.content).toContain("wrote nothing");
    for (const p of pages) expect(await contentBlock(p)).toEqual([]);
    expect(await moduleNames()).not.toContain(`I1246 Fan ${TS}`);

    // The same call with fitting values places the module on both pages,
    // each with its own copy of the content.
    const good = await addModuleTool.handler(
      SYSTEM,
      { ...mint, values: GOOD_CHIPS } as never,
      toolCtx(),
    );
    expect(good.ok).toBe(true);
    expect(good.content).toContain("on 2 of 2 pages");
    const instanceIds = new Set<string>();
    for (const p of pages) {
      const placed = await contentBlock(p);
      expect(placed).toHaveLength(1);
      const ci = await op<{ instance: { values: { chips: { values: { text: string } }[] } } }>(
        "content_instances.get",
        { id: placed[0]?.contentInstanceId as string },
      );
      expect(ci.instance.values.chips[0]?.values.text).toBe("Fast");
      instanceIds.add(placed[0]?.contentInstanceId as string);
    }
    expect(instanceIds.size).toBe(2);
  });

  it("layout: a placement that fails after the mint leaves no module behind", async () => {
    const slug = `i1246-layout-${TS}`;
    const { layoutId } = await op<{ layoutId: string }>("layouts.create", {
      slug,
      displayName: "I1246 L",
      html: '<body><caelo-slot name="content">_</caelo-slot><caelo-slot name="footer">_</caelo-slot></body>',
      blocks: [
        { name: "content", displayName: "Content", position: 0 },
        { name: "footer", displayName: "Footer", position: 1 },
      ],
    });
    const name = `I1246 Chrome ${TS}`;
    // The block check is layout_modules.set's, after modules.create ran.
    const r = await execute(registry, adapter, SYSTEM, "pages.place_module", {
      target: { kind: "layout", layoutId },
      blockName: "sidebar",
      position: "bottom",
      module: {
        create: { slug: `i1246-chrome-${TS}`, displayName: name, html: "<footer>(c)</footer>" },
      },
    });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.ok ? null : r.error)).toContain('block \\"sidebar\\" not on layout');
    expect(await moduleNames()).not.toContain(name);
    const footer = await op<{ moduleIds: string[] }>("layout_modules.get", {
      layoutId,
      blockName: "footer",
    });
    expect(footer.moduleIds).toEqual([]);
  });

  it("chat branch: inserting at the top keeps the existing placement's content; a bad call changes nothing", async () => {
    const pageId = await newPage("i1246-branch");
    const first = await addModuleTool.handler(
      BRANCHED,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: 0,
        moduleId: chipsModuleId,
        values: GOOD_CHIPS,
      } as never,
      toolCtx(),
    );
    expect(first.ok).toBe(true);
    const [existing] = await contentBlock(pageId, BRANCHED);
    expect(existing?.contentInstanceId).toBeTruthy();

    const bad = await addModuleTool.handler(
      BRANCHED,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: "top",
        moduleId: chipsModuleId,
        values: BAD_CHIPS,
      } as never,
      toolCtx(),
    );
    expect(bad.ok).toBe(false);
    expect(await contentBlock(pageId, BRANCHED)).toEqual([existing as Placement]);

    const second = await addModuleTool.handler(
      BRANCHED,
      {
        target: "page",
        targetRef: pageId,
        blockName: "content",
        position: "top",
        moduleId: chipsModuleId,
        values: { chips: [{ node: "text", values: { text: "New" } }] },
      } as never,
      toolCtx(),
    );
    expect(second.ok).toBe(true);
    const placed = await contentBlock(pageId, BRANCHED);
    expect(placed).toHaveLength(2);
    // The earlier placement moved to index 1 WITH its own content.
    expect(placed[1]?.contentInstanceId).toBe(existing?.contentInstanceId ?? "");
    expect(placed[0]?.contentInstanceId).not.toBe(existing?.contentInstanceId ?? "");
    // Nothing reached the live page.
    expect(await contentBlock(pageId)).toEqual([]);
  });
});
