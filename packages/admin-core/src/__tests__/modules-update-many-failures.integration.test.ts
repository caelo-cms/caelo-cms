// SPDX-License-Identifier: MPL-2.0

/**
 * #1038 — `modules.update_many` reports WHY an item was not applied.
 *
 * A failed item carries the singular `modules.update` message (here: the
 * shared-draft conflict naming the other chat), and "not found" counts
 * only modules that do not exist for the caller — not any failure whose
 * message happened to contain "deleted".
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { updateModulesManyTool } from "../ai/tools/bulk-pages-modules.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

const TS = Date.now().toString(36);
const HUMAN = "00000000-0000-0000-0000-00000000ffff";
const SYS: ExecutionContext = { actorId: HUMAN, actorKind: "system", requestId: "i1038-sys" };

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

async function op<T>(ctx: ExecutionContext, name: string, input: unknown): Promise<T> {
  const r = await execute(registry, adapter, ctx, name, input);
  if (!r.ok) throw new Error(`${name}: ${JSON.stringify(r.error)}`);
  return r.value as T;
}

async function draftChat(title: string): Promise<ExecutionContext> {
  const v = await op<{ chatSessionId: string; chatBranchId: string }>(SYS, "chat.create_session", {
    title: `i1038-${title}-${TS}`,
  });
  return {
    actorId: HUMAN,
    actorKind: "ai",
    requestId: `i1038-${title}`,
    chatBranchId: v.chatBranchId,
    chatTaskId: v.chatSessionId,
  };
}

async function seedModule(slug: string): Promise<string> {
  return (
    await op<{ moduleId: string }>(SYS, "modules.create", {
      slug: `i1038-${slug}-${TS}`,
      displayName: slug,
      html: `<p>${slug}</p>`,
    })
  ).moduleId;
}

beforeAll(() => {
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await adapter.close();
});

describe("#1038 — modules.update_many failure reasons", () => {
  it("names the other chat for a module it changed in the draft; counts only missing ids as notFound", async () => {
    const busy = await seedModule("busy");
    const free = await seedModule("free");
    const a = await draftChat("first");
    const b = await draftChat("second");
    await op(a, "modules.update", { moduleId: busy, html: "<p>busy by A</p>" });

    const missing = "00000000-0000-4000-8000-000000001038";
    const input = {
      updates: [
        { moduleId: busy, html: "<p>busy by B</p>" },
        { moduleId: free, html: "<p>free by B</p>" },
        { moduleId: missing, html: "<p>nobody</p>" },
      ],
    };
    const v = await op<{
      updated: number;
      notFound: number;
      failed: { moduleId: string; message: string }[];
    }>(b, "modules.update_many", input);
    expect(v.updated).toBe(1);
    expect(v.notFound).toBe(1);
    expect(v.failed).toHaveLength(1);
    expect(v.failed[0]?.moduleId).toBe(busy);
    expect(v.failed[0]?.message).toContain("changed in the shared draft by chat");
    expect(v.failed[0]?.message).toContain(`i1038-first-${TS}`);

    // The AI tool prints each failed item with its reason. A third chat:
    // the refusal above counts as B having seen A's change, so B's retry
    // would go through (the #620 re-read contract).
    const c = await draftChat("third");
    // The op takes `updates`; the tool's wrapper key is `items`.
    const tool = await updateModulesManyTool.handler(c, { items: input.updates }, {
      registry,
      adapter,
    } as unknown as Parameters<typeof updateModulesManyTool.handler>[2]);
    expect(tool.content).toContain(`- ${busy}: not applied — Conflict`);
    expect(tool.content).toContain(`i1038-first-${TS}`);
  });
});
