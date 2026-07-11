// SPDX-License-Identifier: MPL-2.0

/**
 * issue #165 — Design Manifest ops + prompt rendering against the real
 * DB: set/get round-trip (full-replace semantics), empty-manifest
 * rejection, block rendering, and the site-genesis skill amendment.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { DesignManifest, ExecutionContext } from "@caelo-cms/shared";
import { formatDesignSystemBlock } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;
let sqlc: SQL;

const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000165a1",
  actorKind: "ai",
  requestId: "issue-165-manifest-test",
};

const MANIFEST: DesignManifest = {
  tokenRoles: {
    "--color-primary": "CTAs and links only",
    "--color-surface-alt": "alternating section backgrounds",
  },
  typography: "Playfair Display for headings (1.333 scale), Inter for body; sentence case",
  rhythm: "sections pad 6rem vertical; container max 72rem; grid gap 2rem",
  patterns: [
    {
      name: "hero",
      moduleType: "hero-banner",
      spec: "gradient.hero background, eyebrow + h1 + one CTA",
    },
    { name: "card grid", moduleType: "feature-card", spec: "3-up desktop, shadow.sm, radius 12px" },
  ],
  avoid: "centered body copy; more than one primary CTA per section",
};

beforeAll(async () => {
  registry = new OperationRegistry();
  registerAdminOps(registry);
  adapter = new DatabaseAdapter({
    adminDatabaseUrl: ADMIN_URL as string,
    publicDatabaseUrl: PUBLIC_URL as string,
  });
  sqlc = new SQL(ADMIN_URL as string);
  await sqlc.begin(async (tx) => {
    await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
    await tx`
      INSERT INTO actors (id, kind, display_name)
      VALUES (${AI.actorId}::uuid, 'ai', 'issue-165 manifest test')
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sqlc.end({ timeout: 5 }).catch(() => {});
  await adapter.close?.();
});

describe("design_manifest ops (issue #165)", () => {
  it("rejects an empty manifest loudly", async () => {
    const r = await execute(registry, adapter, AI, "design_manifest.set", { manifest: {} });
    expect(r.ok).toBe(false);
  });

  it("round-trips and full-replaces", async () => {
    const set = await execute(registry, adapter, AI, "design_manifest.set", {
      manifest: MANIFEST,
    });
    expect(set.ok).toBe(true);

    const got = await execute(registry, adapter, AI, "design_manifest.get", {});
    expect(got.ok).toBe(true);
    const m = (got.value as { manifest: DesignManifest | null }).manifest;
    expect(m?.tokenRoles?.["--color-primary"]).toBe("CTAs and links only");
    expect(m?.patterns).toHaveLength(2);

    // Full replace: a smaller document must not merge with the old one.
    const replace = await execute(registry, adapter, AI, "design_manifest.set", {
      manifest: { rhythm: "sections pad 4rem" },
    });
    expect(replace.ok).toBe(true);
    const got2 = await execute(registry, adapter, AI, "design_manifest.get", {});
    const m2 = (got2.value as { manifest: DesignManifest | null }).manifest;
    expect(m2?.rhythm).toBe("sections pad 4rem");
    expect(m2?.tokenRoles).toBeUndefined();
  });
});

describe("formatDesignSystemBlock", () => {
  it("renders every populated section and the conform primer", () => {
    const block = formatDesignSystemBlock(MANIFEST);
    expect(block).toContain("## Design system");
    expect(block).toContain("`--color-primary` — CTAs and links only");
    expect(block).toContain("**hero** (module type `hero-banner`)");
    expect(block).toContain("Never: centered body copy");
    expect(block).toContain("place mode");
  });

  it("returns null for null or contentless manifests", () => {
    expect(formatDesignSystemBlock(null)).toBeNull();
    expect(formatDesignSystemBlock({} as DesignManifest)).toBeNull();
  });
});

describe("site-genesis amendment (issue #165)", () => {
  it("materialise step gained the manifest write exactly once", async () => {
    const conn = await sqlc.reserve();
    try {
      await conn`SELECT set_config('caelo.actor_kind', 'system', false)`;
      const rows = (await conn`
        SELECT body FROM skills WHERE slug = 'site-genesis'
      `) as unknown as { body: string }[];
      const occurrences = (rows[0]?.body.match(/set_design_manifest/g) ?? []).length;
      expect(occurrences).toBe(1);
    } finally {
      conn.release();
    }
  });
});
