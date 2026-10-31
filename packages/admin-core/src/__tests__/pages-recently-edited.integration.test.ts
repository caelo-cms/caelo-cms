// SPDX-License-Identifier: MPL-2.0

/**
 * #1207 — `pages.list_recently_edited` feeds the live editor's page
 * search: the pages changed last come first, a deleted page is left out,
 * and the AI cannot call it (navigation aid of the editor).
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "i1207-recent",
};

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function op<T>(name: string, input: unknown, ctx: ExecutionContext = SYSTEM): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function recentIds(): Promise<string[]> {
  const r = await op<{ pages: { pageId: string }[] }>("pages.list_recently_edited", {
    limit: 20,
  });
  return r.pages.map((p) => p.pageId);
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1207 — pages.list_recently_edited", () => {
  it("lists the page changed last first and leaves deleted pages out", async () => {
    const { templateId } = await op<{ templateId: string }>("templates.create", {
      pageType: "home",
      slug: `i1207-tpl-${TS}`,
      displayName: "T",
      html: '<body><caelo-slot name="content">_</caelo-slot></body>',
    });
    const { pageId: first } = await op<{ pageId: string }>("pages.create", {
      slug: `i1207-a-${TS}`,
      title: "A",
      templateId,
    });
    const { pageId: second } = await op<{ pageId: string }>("pages.create", {
      slug: `i1207-b-${TS}`,
      title: "B",
      templateId,
    });
    // Other test files write pages in parallel: assert the order of these
    // two, not that they head the list.
    const before = await recentIds();
    expect(before.indexOf(second)).toBeGreaterThanOrEqual(0);
    expect(before.indexOf(second)).toBeLessThan(before.indexOf(first));

    await op("pages.update", { pageId: first, title: "A, edited" });
    const edited = await recentIds();
    expect(edited.indexOf(first)).toBeGreaterThanOrEqual(0);
    expect(edited.indexOf(first)).toBeLessThan(edited.indexOf(second));

    await op("pages.delete", { pageId: first });
    const after = await recentIds();
    expect(after).not.toContain(first);
    expect(after).toContain(second);
  });

  it("is not open to the AI", async () => {
    const r = await execute(
      registry,
      adapter,
      { ...SYSTEM, actorKind: "ai" },
      "pages.list_recently_edited",
      {},
    );
    expect(r.ok).toBe(false);
  });
});
