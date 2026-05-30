// SPDX-License-Identifier: MPL-2.0

/**
 * v0.12.3 (issue #106) — the core regression: a nested-module ref is
 * validated against the referenced module's STABLE `type`, not its unique
 * `slug`. An AI-minted module's slug carries a uniqueness suffix
 * (button-<sfx>) that could never satisfy an allowlist authored as
 * ["button"]; matching on `type` fixes it. Runs against the real Postgres
 * through the op layer so the writes + the validator share one RLS
 * context (AC #2 + AC #5).
 */

import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL) throw new Error("ADMIN_DATABASE_URL required");

let registry: OperationRegistry;
let adapter: DatabaseAdapter;

// Seeded AI actor preserved by the test preload (audit_events FKs
// actor_id -> actors.id, so the id must exist).
const aiCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-000000000a1a",
  actorKind: "ai",
  requestId: "22222222-2222-2222-2222-222222222222",
  actorRoles: ["ai"],
};

const sfx = Date.now().toString(36);

async function seedModule(opts: { slug: string; type: string; fields?: unknown[] }): Promise<string> {
  const r = await execute(registry, adapter, aiCtx, "modules.create", {
    slug: opts.slug,
    displayName: opts.slug,
    type: opts.type,
    html: "<div></div>",
    fields: opts.fields ?? [],
  });
  if (!r.ok) throw new Error(`seed module failed: ${JSON.stringify(r.error)}`);
  return (r.value as { moduleId: string }).moduleId;
}

async function createCi(moduleId: string): Promise<string> {
  const r = await execute(registry, adapter, aiCtx, "content_instances.create", {
    moduleId,
    values: {},
  });
  if (!r.ok) throw new Error(`seed CI failed: ${JSON.stringify(r.error)}`);
  return (r.value as { contentInstanceId: string }).contentInstanceId;
}

beforeAll(() => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL!,
    publicDatabaseUrl: PUBLIC_URL ?? ADMIN_URL!,
  });
});

afterAll(async () => {
  await adapter.close();
});

describe("nested-ref validator matches modules.type, not slug (issue #106)", () => {
  it("ACCEPTS a ref whose module type is in allowedModuleTypes despite a suffixed slug", async () => {
    const buttonId = await seedModule({ slug: `button-${sfx}-a`, type: "button" });
    const parentId = await seedModule({
      slug: `cta-teaser-${sfx}-a`,
      type: "cta-teaser",
      fields: [{ name: "cta", kind: "module", label: "CTA", allowedModuleTypes: ["button"] }],
    });
    const buttonCi = await createCi(buttonId);

    const r = await execute(registry, adapter, aiCtx, "content_instances.create", {
      moduleId: parentId,
      values: { cta: { moduleId: buttonId, contentInstanceId: buttonCi } },
    });
    // Pre-fix this failed: slug "button-<sfx>" was not in ["button"].
    expect(r.ok).toBe(true);
  });

  it("REJECTS a ref whose module type is not in allowedModuleTypes, with an AI-actionable message", async () => {
    const cardId = await seedModule({ slug: `card-${sfx}-b`, type: "card" });
    const parentId = await seedModule({
      slug: `cta-teaser-${sfx}-b`,
      type: "cta-teaser",
      fields: [{ name: "cta", kind: "module", label: "CTA", allowedModuleTypes: ["button"] }],
    });
    const cardCi = await createCi(cardId);

    const r = await execute(registry, adapter, aiCtx, "content_instances.create", {
      moduleId: parentId,
      values: { cta: { moduleId: cardId, contentInstanceId: cardCi } },
    });
    expect(r.ok).toBe(false);
    const message = r.ok ? "" : ((r.error as { message?: string }).message ?? "");
    expect(message).toContain("allowedModuleTypes");
    expect(message).toContain("button");
    expect(message).toContain("card");
    // AC #5: actionable + explicitly forbids punting to the operator
    expect(message.toLowerCase()).toContain("do not ask the operator");
    expect(message).toContain("edit_module");
  });
});
