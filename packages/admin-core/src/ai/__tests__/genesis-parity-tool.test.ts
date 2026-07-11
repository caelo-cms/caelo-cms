// SPDX-License-Identifier: MPL-2.0

/**
 * issue #164 slice 3 — parity gate wiring with injected screenshotter
 * + differ (no Playwright in unit tests): verdict tiers, the honest
 * no-runtime path, the no-selected-draft error, and that both sides
 * render as data: documents in the same viewport.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { type DatabaseAdapter, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import type { Screenshotter } from "@caelo-cms/site-importer";
import { registerAdminOps } from "../../register.js";
import {
  checkGenesisParityTool,
  setGenesisParityDepsForTests,
} from "../tools/check-genesis-parity.js";
import type { ToolContext } from "../tools/dispatch.js";

const registry = new OperationRegistry();
registerAdminOps(registry);

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "issue-164-parity-unit",
};

const DRAFT_ID = "11111111-1111-4111-8111-11111111d0af";
const PAGE_ID = "11111111-1111-4111-8111-11111111ea9e";

function toolCtxWith(opts: { selected?: boolean } = {}): ToolContext {
  const adapter = {
    runOperation: async (op: { name: string }) => {
      if (op.name === "genesis.list_drafts") {
        return ok({
          drafts: [
            {
              id: DRAFT_ID,
              direction: "bold editorial",
              status: opts.selected === false ? "candidate" : "selected",
              html: "<!doctype html><html><body><h1>DRAFT</h1></body></html>",
              rationale: "",
              createdAt: "2026-07-11T00:00:00Z",
              htmlBytes: 60,
            },
          ],
        });
      }
      if (op.name === "pages.render_preview") {
        return ok({
          html: "<!doctype html><html><body><h1>COMPOSED</h1></body></html>",
          replacedSlots: [],
          missingSlots: [],
          pageSlug: "home",
          pageLocale: "en",
        });
      }
      return ok({});
    },
  } as unknown as DatabaseAdapter;
  return { adapter, registry } as ToolContext;
}

function fakeShots(capturedUrls: string[]): Screenshotter {
  return {
    async capture(url) {
      capturedUrls.push(url);
      return { bytes: new Uint8Array([1]), width: 1280, height: 800 };
    },
    async dispose() {},
  };
}

afterAll(() => {
  // Restore production deps for any later suite in the same process.
  setGenesisParityDepsForTests({});
});

describe("check_genesis_parity (issue #164 slice 3)", () => {
  it("passes on low diff, capturing BOTH sides as data: documents", async () => {
    const urls: string[] = [];
    setGenesisParityDepsForTests({
      factory: async () => fakeShots(urls),
      diff: async () => 0.02,
    });
    const res = await checkGenesisParityTool.handler(AI, { pageId: PAGE_ID }, toolCtxWith());
    expect(res.ok).toBe(true);
    expect(res.content).toContain("PASS");
    expect(res.content).toContain("2.0%");
    expect(urls).toHaveLength(2);
    expect(urls.every((u) => u.startsWith("data:text/html;base64,"))).toBe(true);
    const decoded = urls.map((u) => Buffer.from(u.split(",")[1] ?? "", "base64").toString());
    expect(decoded[0]).toContain("DRAFT");
    expect(decoded[1]).toContain("COMPOSED");
  });

  it("warns and fails with repair guidance at the classifier thresholds", async () => {
    setGenesisParityDepsForTests({ factory: async () => fakeShots([]), diff: async () => 0.1 });
    const warn = await checkGenesisParityTool.handler(AI, { pageId: PAGE_ID }, toolCtxWith());
    expect(warn.content).toContain("WARN");
    expect(warn.content).toContain("re-check");

    setGenesisParityDepsForTests({ diff: async () => 0.4 });
    const fail = await checkGenesisParityTool.handler(AI, { pageId: PAGE_ID }, toolCtxWith());
    expect(fail.content).toContain("FAIL");
    expect(fail.content).toContain("inspect_genesis_draft");
  });

  it("reports UNCHECKED loudly when the screenshot runtime is unavailable", async () => {
    setGenesisParityDepsForTests({ factory: async () => null });
    const res = await checkGenesisParityTool.handler(AI, { pageId: PAGE_ID }, toolCtxWith());
    expect(res.ok).toBe(false);
    expect(res.content).toContain("UNCHECKED");
    expect(res.content).toContain("do NOT claim");
  });

  it("refuses without a selected draft (the contract is the operator's choice)", async () => {
    setGenesisParityDepsForTests({ factory: async () => fakeShots([]), diff: async () => 0 });
    const res = await checkGenesisParityTool.handler(
      AI,
      { pageId: PAGE_ID },
      toolCtxWith({ selected: false }),
    );
    expect(res.ok).toBe(false);
    expect(res.content).toContain("select_genesis_draft");
  });
});
