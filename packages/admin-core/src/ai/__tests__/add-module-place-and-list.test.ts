// SPDX-License-Identifier: MPL-2.0

/**
 * issue #159 — unit coverage for the two tool-surface changes:
 *
 *   1. `add_module_to_page` place mode: an existing moduleId is spliced
 *      into the block WITHOUT a modules.create call (the reuse path).
 *   2. `list_modules`: full-catalog read with kind/search filters,
 *      metadata only — html/css/js must never leak into the payload.
 *
 * Fake-adapter pattern as in cold-start-gate.test.ts: the real
 * OperationRegistry validates op names/scopes; `runOperation` returns
 * controlled values and records the call sequence.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { addModuleToPageTool } from "../tools/add-module-to-page.js";
import type { ToolContext } from "../tools/dispatch.js";
import { listModulesTool } from "../tools/list-modules.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-159-unit",
};

const HERO = {
  id: "11111111-1111-4111-8111-11111111be01",
  slug: "hero-banner",
  displayName: "Hero banner",
  description: "Homepage hero with headline + CTA",
  kind: "hero" as const,
  type: "hero-banner",
  html: "<h1>{{hero_title}}</h1>",
  css: ".hero{color:var(--color-primary)}",
  js: "",
  fields: [{ name: "hero_title", kind: "text" }],
};
const FOOTER = {
  ...HERO,
  id: "11111111-1111-4111-8111-11111111be02",
  slug: "site-footer",
  displayName: "Site footer",
  description: "Global footer",
  kind: "utility" as const,
  type: "site-footer",
  fields: [],
};

/** Fake adapter satisfying the cold-start gate + the ops each tool chains. */
function toolCtxWith(calls: string[]): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      calls.push(op.name);
      switch (op.name) {
        case "site_defaults.get":
          return ok({ defaults: { siteName: "Acme", sitePurpose: "SaaS marketing site" } });
        case "themes.get_active":
          return ok({ theme: { origin: "ai", description: "Indigo B2B palette" } });
        case "modules.get":
          return ok({ module: HERO });
        case "modules.list":
          return ok({ modules: [HERO, FOOTER] });
        case "modules.list_usage":
          return ok({
            usage: [{ moduleId: HERO.id, placementCount: 3, sampleSlugs: ["home", "pricing"] }],
          });
        case "pages.get_with_modules":
          return ok({
            page: {
              id: "11111111-1111-4111-8111-11111111ea9e",
              templateId: "11111111-1111-4111-8111-11111111feed",
              blocks: [
                {
                  blockName: "content",
                  modules: [{ moduleId: "11111111-1111-4111-8111-11111111cafe" }],
                },
              ],
            },
          });
        case "pages.set_modules":
          return ok({});
        default:
          return ok({});
      }
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("add_module_to_page place mode (issue #159)", () => {
  it("splices an existing module without calling modules.create", async () => {
    const calls: string[] = [];
    const res = await addModuleToPageTool.handler(
      AI,
      {
        pageId: "11111111-1111-4111-8111-11111111ea9e",
        blockName: "content",
        position: "top",
        moduleId: HERO.id,
      },
      toolCtxWith(calls),
    );
    expect(res.ok).toBe(true);
    expect(res.content).toContain(HERO.id);
    expect(res.content).toContain("existing module");
    expect(calls).toContain("modules.get");
    expect(calls).toContain("pages.set_modules");
    expect(calls).not.toContain("modules.create");
  });
});

describe("list_modules (issue #159)", () => {
  it("returns the catalog with usage, metadata only (no html/css/js)", async () => {
    const calls: string[] = [];
    const res = await listModulesTool.handler(AI, {}, toolCtxWith(calls));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("hero-banner");
    expect(res.content).toContain("site-footer");
    expect(res.content).toContain("placements=3");
    expect(res.content).toContain("unplaced");
    const payload = JSON.stringify((res as { value?: unknown }).value ?? {});
    expect(payload).toContain(HERO.id);
    expect(payload).not.toContain("{{hero_title}}"); // html body must not leak
    expect(payload).not.toContain("var(--color-primary)"); // css body must not leak
  });

  it("filters by kind and search", async () => {
    const byKind = await listModulesTool.handler(AI, { kind: "utility" }, toolCtxWith([]));
    expect(byKind.ok).toBe(true);
    expect(byKind.content).toContain("site-footer");
    expect(byKind.content).not.toContain("hero-banner");

    const bySearch = await listModulesTool.handler(AI, { search: "headline" }, toolCtxWith([]));
    expect(bySearch.ok).toBe(true);
    expect(bySearch.content).toContain("hero-banner");
    expect(bySearch.content).not.toContain("site-footer");
  });

  it("suggests dropping the filter when it matches nothing", async () => {
    const res = await listModulesTool.handler(AI, { search: "zzz-nope" }, toolCtxWith([]));
    expect(res.ok).toBe(true);
    expect(res.content).toContain("0 modules");
    expect(res.content).toContain("retry without the filter");
  });
});
