// SPDX-License-Identifier: MPL-2.0

/**
 * issue #112 — integration coverage for the themes propose/execute
 * pair against the real Postgres pair (no mocked DB per CLAUDE.md §6).
 *
 * The themes domain had no integration coverage before #112; this file
 * pins the new contract end-to-end:
 *  - propose_create requires an AI-composed DTCG `tokens` document +
 *    a `description` design rationale, validated at the boundary;
 *  - a payload carrying `preset` is rejected by the strict schema
 *    (the regression this issue exists for — the enum must not come
 *    back) and inserts no row;
 *  - execute re-validates the persisted document, creates the theme
 *    with origin='operator', and records audit;
 *  - the primaryColor → OKLCh-ramp override path still works, with
 *    explicit stops winning over derived ones;
 *  - execute stays human/system-only (ActorScopeRejected for AI);
 *  - duplicate pending proposals are rejected at the DB layer;
 *  - the cold-start gate's clearing criterion (origin != seed AND
 *    described) holds against the real `themes.get_active` row shape,
 *    not just the unit-test stub.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext, ThemeDocument } from "@caelo-cms/shared";
import { SQL } from "bun";
import { checkColdStartGate } from "../ai/tools/_cold-start-gate.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const SYSTEM: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000112f0",
  actorKind: "system",
  requestId: "v112-themes-pe-test-system",
};
const AI: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-0000000112a1",
  actorKind: "ai",
  requestId: "v112-themes-pe-test-ai",
};

const TEST_TAG = "v112pe";

/** A complete AI-composed brand document (indigo primary — NOT grayscale). */
const BRAND_DOC: ThemeDocument = {
  $description: "Indigo developer-tools brand composed for the #112 integration suite.",
  color: {
    background: { $type: "color", $value: "#ffffff" },
    foreground: { $type: "color", $value: "#0f172a" },
    primary: { $type: "color", $value: "#4f46e5" },
    "primary-foreground": { $type: "color", $value: "#eef2ff" },
    accent: { $type: "color", $value: "#06b6d4" },
    border: { $type: "color", $value: "#e2e8f0" },
  },
  typography: {
    body: {
      $type: "typography",
      $value: { fontFamily: "Inter, sans-serif", fontSize: "1rem", lineHeight: 1.5 },
    },
    heading: {
      $type: "typography",
      $value: { fontFamily: "Inter, sans-serif", fontSize: "1.875rem", fontWeight: 700 },
    },
  },
  spacing: {
    sm: { $type: "dimension", $value: "0.5rem" },
    md: { $type: "dimension", $value: "1rem" },
    lg: { $type: "dimension", $value: "1.5rem" },
  },
  radius: {
    md: { $type: "dimension", $value: "0.5rem" },
  },
};

const DESCRIPTION = "Indigo primary for a developer-tools SaaS brand (v112pe test).";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM theme_pending_actions WHERE proposed_by = ${SYSTEM.actorId}::uuid OR proposed_by = ${AI.actorId}::uuid`;
      await tx`DELETE FROM themes WHERE slug LIKE ${`${TEST_TAG}%`}`;
    });
  } finally {
    await sql.end();
  }
}

/** Direct-SELECT helper for assertions, wrapped in a system-actor tx for RLS. */
async function inspect<T>(fn: (tx: SQL) => Promise<T>): Promise<T> {
  const sql = new SQL(ADMIN_URL!);
  try {
    let result!: T;
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      result = await fn(tx as unknown as SQL);
    });
    return result;
  } finally {
    await sql.end();
  }
}

async function ensureActors(): Promise<void> {
  const sql = new SQL(ADMIN_URL!);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${SYSTEM.actorId}::uuid, 'human', 'v112pe-test-human') ON CONFLICT DO NOTHING`;
      await tx`INSERT INTO actors (id, kind, display_name) VALUES (${AI.actorId}::uuid, 'ai', 'v112pe-test-ai') ON CONFLICT DO NOTHING`;
    });
  } finally {
    await sql.end();
  }
}

async function proposeCreate(
  slug: string,
  extras: Record<string, unknown> = {},
): Promise<{ proposalId: string; preview: Record<string, unknown> }> {
  const r = await execute(registry, adapter, AI, "themes.propose_create", {
    slug,
    displayName: `Theme ${slug}`,
    description: DESCRIPTION,
    tokens: BRAND_DOC,
    ...extras,
  });
  if (!r.ok) throw new Error(`propose_create failed: ${JSON.stringify(r.error)}`);
  return r.value as { proposalId: string; preview: Record<string, unknown> };
}

beforeAll(async () => {
  await wipe();
  await ensureActors();
  adapter = new DatabaseAdapter({ adminDatabaseUrl: ADMIN_URL, publicDatabaseUrl: PUBLIC_URL });
  registry = new OperationRegistry();
  registerAdminOps(registry);
});

afterAll(async () => {
  await wipe();
  await adapter.close();
});

describe("themes.propose_create — AI-composed document (issue #112)", () => {
  it("propose lands a pending row; preview carries tokenCount + tokensSummary, no preset", async () => {
    const { proposalId, preview } = await proposeCreate(`${TEST_TAG}-happy`);

    expect(preview.tokenCount as number).toBeGreaterThan(0);
    expect(typeof preview.tokensSummary).toBe("string");
    expect((preview.tokensSummary as string).length).toBeGreaterThan(0);
    expect(Object.keys(preview)).not.toContain("preset");

    const row = await inspect(async (tx) => {
      const rows = await tx`
        SELECT status, payload_hash, jsonb_typeof(payload) AS payload_type,
               payload->>'slug' AS payload_slug
        FROM theme_pending_actions WHERE id = ${proposalId}::uuid
      `;
      return rows[0] as
        | {
            status: string;
            payload_hash: string | null;
            payload_type: string;
            payload_slug: string | null;
          }
        | undefined;
    });
    expect(row?.status).toBe("pending");
    expect(row?.payload_hash).not.toBeNull();
    // Pins the ::text::jsonb write fix: payload is a real jsonb object
    // (queryable by path), not a double-encoded string scalar.
    expect(row?.payload_type).toBe("object");
    expect(row?.payload_slug).toBe(`${TEST_TAG}-happy`);
  });

  it("regression pin: a payload carrying `preset` is rejected by the strict schema, no row inserted", async () => {
    const countBefore = await inspect(async (tx) => {
      const rows =
        await tx`SELECT count(*)::int AS n FROM theme_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
      return (rows[0] as { n: number }).n;
    });

    const r = await execute(registry, adapter, AI, "themes.propose_create", {
      slug: `${TEST_TAG}-preset`,
      displayName: "Preset must not come back",
      description: DESCRIPTION,
      tokens: BRAND_DOC,
      preset: "warm",
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("ValidationFailed");

    const countAfter = await inspect(async (tx) => {
      const rows =
        await tx`SELECT count(*)::int AS n FROM theme_pending_actions WHERE proposed_by = ${AI.actorId}::uuid`;
      return (rows[0] as { n: number }).n;
    });
    expect(countAfter).toBe(countBefore);
  });

  it("boundary rejection: malformed token document and missing description fail validation", async () => {
    // A bare-string leaf is unambiguously invalid (neither a token nor
    // a group). Note: a wrong-typed `$value` (e.g. 42) degrades into
    // "group with unknown $-metadata" under the tolerant DTCG walker —
    // tightening that is out of scope here (plan §3: schema unchanged).
    const badTokens = await execute(registry, adapter, AI, "themes.propose_create", {
      slug: `${TEST_TAG}-badtok`,
      displayName: "Bad tokens",
      description: DESCRIPTION,
      tokens: { color: { primary: "#4f46e5" } },
    });
    expect(badTokens.ok).toBe(false);
    if (badTokens.ok) throw new Error("unreachable");
    expect(badTokens.error.kind).toBe("ValidationFailed");

    const noDescription = await execute(registry, adapter, AI, "themes.propose_create", {
      slug: `${TEST_TAG}-nodesc`,
      displayName: "No rationale",
      tokens: BRAND_DOC,
    });
    expect(noDescription.ok).toBe(false);
    if (noDescription.ok) throw new Error("unreachable");
    expect(noDescription.error.kind).toBe("ValidationFailed");
  });

  it("execute creates the theme with origin='operator', persisted description + verbatim tokens, audit row", async () => {
    const slug = `${TEST_TAG}-exec`;
    const { proposalId } = await proposeCreate(slug);

    const r = await execute(registry, adapter, SYSTEM, "themes.execute_proposal", { proposalId });
    expect(r.ok).toBe(true);

    const theme = await inspect(async (tx) => {
      const rows = await tx`
        SELECT origin, description, is_active, tokens::text AS tokens
        FROM themes WHERE slug = ${slug}
      `;
      return rows[0] as
        | { origin: string; description: string | null; is_active: boolean; tokens: string }
        | undefined;
    });
    expect(theme?.origin).toBe("operator");
    expect(theme?.description).toBe(DESCRIPTION);
    expect(theme?.is_active).toBe(false);
    expect(JSON.parse(theme?.tokens ?? "{}")).toEqual(BRAND_DOC);

    const proposal = await inspect(async (tx) => {
      const rows = await tx`
        SELECT status, applied_theme_id FROM theme_pending_actions WHERE id = ${proposalId}::uuid
      `;
      return rows[0] as { status: string; applied_theme_id: string | null } | undefined;
    });
    expect(proposal?.status).toBe("applied");
    expect(proposal?.applied_theme_id).not.toBeNull();

    const audited = await inspect(async (tx) => {
      const rows = await tx`
        SELECT 1 AS hit FROM audit_events
        WHERE operation = 'themes.execute_proposal' AND entity_id = ${proposalId}::uuid AND succeeded = true
      `;
      return rows.length;
    });
    expect(audited).toBeGreaterThanOrEqual(1);
  });

  it("overrides.primaryColor derives the OKLCh ramp; explicit stops win over derived ones", async () => {
    const slug = `${TEST_TAG}-ramp`;
    const { proposalId, preview } = await proposeCreate(slug, {
      overrides: { primaryColor: "#f59e0b", "color.primary.500": "#123456" },
    });
    expect((preview.derivedRampPaths as string[]).length).toBeGreaterThan(0);

    const r = await execute(registry, adapter, SYSTEM, "themes.execute_proposal", { proposalId });
    expect(r.ok).toBe(true);

    const tokens = await inspect(async (tx) => {
      const rows = await tx`SELECT tokens FROM themes WHERE slug = ${slug}`;
      const raw = (rows[0] as { tokens: unknown }).tokens;
      return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown>;
    });
    const primary = (tokens.color as Record<string, unknown>).primary as Record<
      string,
      Record<string, unknown>
    >;
    // Derived stops exist and are annotated.
    expect(primary["100"]?._derived).toBe(true);
    // The explicitly-supplied 500 stop wins over the derived value.
    expect(primary["500"]?.$value).toBe("#123456");
    expect(primary["500"]?._derived).toBeUndefined();
  });

  it("execute is human/system-only: AI actor gets ActorScopeRejected", async () => {
    const { proposalId } = await proposeCreate(`${TEST_TAG}-scope`);
    const r = await execute(registry, adapter, AI, "themes.execute_proposal", { proposalId });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.error.kind).toBe("ActorScopeRejected");
  });

  it("legacy pre-#112 pending payload (preset, no tokens) gets an actionable execute error", async () => {
    // Simulate a pending row queued before the preset removal: payload
    // carries `preset` and no tokens/description. Inserted directly —
    // the current propose op can no longer produce this shape.
    const proposalId = await inspect(async (tx) => {
      const rows = await tx`
        INSERT INTO theme_pending_actions (kind, proposed_by, payload, preview, status, payload_hash)
        VALUES ('create', ${AI.actorId}::uuid,
                ${'{"slug": "v112pe-legacy", "displayName": "Legacy preset proposal", "preset": "warm"}'}::text::jsonb,
                ${'{"preset": "warm"}'}::text::jsonb,
                'pending', ${"v112pe-legacy-hash"})
        RETURNING id::text AS id
      `;
      return (rows[0] as { id: string }).id;
    });

    const r = await execute(registry, adapter, SYSTEM, "themes.execute_proposal", { proposalId });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // Actionable per CLAUDE.md §11 — names the fix, doesn't throw raw Zod,
    // and never persists "undefined" as a description the gate would trust.
    expect(JSON.stringify(r.error)).toContain("predates the AI-composed theme contract");

    const proposal = await inspect(async (tx) => {
      const rows =
        await tx`SELECT status FROM theme_pending_actions WHERE id = ${proposalId}::uuid`;
      return (rows[0] as { status: string }).status;
    });
    expect(proposal).toBe("pending");
    const themeCount = await inspect(async (tx) => {
      const rows = await tx`SELECT count(*)::int AS n FROM themes WHERE slug = ${"v112pe-legacy"}`;
      return (rows[0] as { n: number }).n;
    });
    expect(themeCount).toBe(0);
  });

  it("duplicate pending propose (same payload) is rejected at the DB layer", async () => {
    const slug = `${TEST_TAG}-dup`;
    await proposeCreate(slug);
    const second = await execute(registry, adapter, AI, "themes.propose_create", {
      slug,
      displayName: `Theme ${slug}`,
      description: DESCRIPTION,
      tokens: BRAND_DOC,
    });
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(JSON.stringify(second.error)).toContain("Identical proposal already pending");
  });
});

describe("cold-start gate against the real DB (issue #112 AC #3)", () => {
  it("blocks on an active seed theme, clears after identity + approved described create/activate", async () => {
    const toolCtx = { adapter, registry } as ToolContext;
    const slug = `${TEST_TAG}-gate`;

    // Save shared state we mutate (active theme + identity), restore in finally.
    const saved = await inspect(async (tx) => {
      const activeRows = await tx`SELECT id::text AS id FROM themes WHERE is_active = true`;
      const idRows = await tx`SELECT site_name, site_purpose FROM site_defaults WHERE id = 1`;
      return {
        activeThemeId: (activeRows[0] as { id: string } | undefined)?.id ?? null,
        siteName: (idRows[0] as { site_name: string | null } | undefined)?.site_name ?? null,
        sitePurpose:
          (idRows[0] as { site_purpose: string | null } | undefined)?.site_purpose ?? null,
      };
    });

    try {
      // Force cold-start: no identity + an active seed-origin theme.
      await inspect(async (tx) => {
        await tx`UPDATE site_defaults SET site_name = NULL, site_purpose = NULL WHERE id = 1`;
        await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
        await tx`
          INSERT INTO themes (slug, display_name, origin, is_active, tokens)
          VALUES (${`${TEST_TAG}-seed`}, 'v112pe seed', 'seed', true, '{}'::jsonb)
        `;
        return null;
      });

      // An ACTIVE seed theme exists → the gate's mutate-in-place branch
      // (the no-active-theme propose branch is pinned in the unit test).
      const blocked = await checkColdStartGate(AI, toolCtx, "add_module_to_page");
      expect(blocked.blocked).toBe(true);
      expect(blocked.gateResult?.content ?? "").toContain("seed-origin");
      expect(blocked.gateResult?.content ?? "").toContain("set_theme_tokens");

      // Identity + composed theme through the real propose/execute flow.
      const identity = await execute(registry, adapter, AI, "site_defaults.set_identity", {
        siteName: "Caelo",
        sitePurpose: "An AI-first CMS for developers (v112pe gate test).",
      });
      expect(identity.ok).toBe(true);

      const { proposalId } = await proposeCreate(slug);
      const created = await execute(registry, adapter, SYSTEM, "themes.execute_proposal", {
        proposalId,
      });
      expect(created.ok).toBe(true);
      const themeId = (created.value as { themeId: string | null }).themeId;
      expect(themeId).not.toBeNull();

      const activation = await execute(registry, adapter, AI, "themes.propose_activate", {
        themeId,
      });
      expect(activation.ok).toBe(true);
      const activated = await execute(registry, adapter, SYSTEM, "themes.execute_proposal", {
        proposalId: (activation.value as { proposalId: string }).proposalId,
      });
      expect(activated.ok).toBe(true);

      // origin='operator' + non-empty description + identity → clear.
      const cleared = await checkColdStartGate(AI, toolCtx, "add_module_to_page");
      expect(cleared.blocked).toBe(false);
    } finally {
      await inspect(async (tx) => {
        await tx`UPDATE site_defaults SET site_name = ${saved.siteName}, site_purpose = ${saved.sitePurpose} WHERE id = 1`;
        await tx`UPDATE themes SET is_active = false WHERE is_active = true`;
        if (saved.activeThemeId) {
          await tx`UPDATE themes SET is_active = true WHERE id = ${saved.activeThemeId}::uuid`;
        }
        return null;
      });
    }
  });
});
