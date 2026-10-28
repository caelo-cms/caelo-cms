// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1198 — the write-time half of the module-JS rules: after a module
 * write the stored JS is read like the Stage check reads it, and the hint
 * names the module whose markup a script drives, or the content it builds.
 */

import { describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { registerAdminOps } from "../../register.js";
import { moduleJsGuardSuffix } from "../tools/_module-js-guard.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-1198-unit",
};

const HEADER_ID = "00000000-0000-4000-8000-000000000001";
const DEMO_ID = "00000000-0000-4000-8000-000000000002";
const DEMO_JS =
  "(function () { document.querySelectorAll('.demo-form').forEach(function (f) { f.addEventListener('submit', function () {}); }); })();";

function header(js: string, fields: unknown[] = []) {
  return {
    id: HEADER_ID,
    displayName: "Site header",
    html: '<header class="site-header"><nav class="site-nav"></nav></header>',
    js,
    fields,
  };
}
const DEMO = {
  id: DEMO_ID,
  displayName: "Demo form",
  html: '<section class="demo"><form class="demo-form"></form></section>',
  js: "",
  fields: [],
};

function toolCtx(
  modules: unknown[],
  layoutHtml = '<div class="shell">{{{modules}}}</div>',
): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      if (op.name === "modules.list") return ok({ modules });
      if (op.name === "layouts.list") return ok({ layouts: [{ html: layoutHtml }] });
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

describe("moduleJsGuardSuffix (#1198)", () => {
  it("names the module whose markup the written script drives", async () => {
    const s = await moduleJsGuardSuffix(AI, toolCtx([header(DEMO_JS), DEMO]), [HEADER_ID]);
    expect(s).toContain("module-js-guard");
    expect(s).toContain(`"Demo form" (${DEMO_ID})`);
    expect(s).toContain(".demo-form");
    expect(s).toContain("structure/foreign-module-js");
  });

  it("reports a menu built from a JS array as content the html must carry", async () => {
    const js = `(function () {
      var items = [{ label: 'Produkte', href: '/produkte' }, { label: 'Preise', href: '/preise' }, { label: 'Kontakt', href: '/kontakt' }];
      document.querySelector('.site-nav').innerHTML = items.map(function (i) { return '<a href="' + i.href + '">' + i.label + '</a>'; }).join('');
    })();`;
    const s = await moduleJsGuardSuffix(AI, toolCtx([header(js), DEMO]), [HEADER_ID]);
    expect(s).toContain("renders 3 entries from a JS array");
    expect(s).toContain("structure/js-rendered-content");
    expect(s).not.toContain("foreign");
  });

  it("is silent for a script that drives its own markup and the layout chrome", async () => {
    const js =
      "(function () { document.querySelectorAll('.site-header .site-nav').forEach(function (n) { n.hidden = false; }); document.querySelector('.shell').dataset.ready = '1'; })();";
    expect(await moduleJsGuardSuffix(AI, toolCtx([header(js), DEMO]), [HEADER_ID])).toBe("");
  });

  it("leaves modules with nested-module fields to the Stage check", async () => {
    const s = await moduleJsGuardSuffix(
      AI,
      toolCtx([header(DEMO_JS, [{ name: "slots", kind: "module-list" }]), DEMO]),
      [HEADER_ID],
    );
    expect(s).toBe("");
  });

  it("reads nothing when the write touched no module", async () => {
    expect(await moduleJsGuardSuffix(AI, toolCtx([header(DEMO_JS), DEMO]), [])).toBe("");
  });
});
