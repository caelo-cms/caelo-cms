// SPDX-License-Identifier: MPL-2.0

/**
 * P10A — skills integration tests.
 *   - propose → review (accept) → activate round-trip.
 *   - propose → review (reject) closes proposal without creating skill.
 *   - AI cannot review a proposal (ActorScopeRejected).
 *   - skills.set human-only; AI gets ActorScopeRejected.
 *   - chat.set_engaged_skills persists manual overrides on the session row.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { DatabaseAdapter, execute, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { SQL } from "bun";
import { registerAdminOps } from "../register.js";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!ADMIN_URL || !PUBLIC_URL) throw new Error("DB URLs required");

let adapter: DatabaseAdapter;
let registry: OperationRegistry;

const systemCtx: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "skills-test",
};
const aiCtx: ExecutionContext = { ...systemCtx, actorKind: "ai" };

const TEST_SLUG = "test-p10a-skill";

async function wipe(): Promise<void> {
  const sql = new SQL(ADMIN_URL);
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      await tx`DELETE FROM skill_proposals WHERE slug LIKE 'test-p10a-%'`;
      await tx`DELETE FROM skills WHERE slug LIKE 'test-p10a-%'`;
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

afterEach(async () => {
  await wipe();
});

afterAll(async () => {
  await adapter.close();
});

describe("skills propose / review / activate", () => {
  it("AI proposes; human accepts; skill lands at awaiting_activation", async () => {
    const propose = await execute(registry, adapter, aiCtx, "skills.propose", {
      slug: TEST_SLUG,
      displayName: "Test Skill",
      description: "Used by integration tests.",
      body: "Skill body for the test — instructs the AI to add a friendly greeting.",
      rationale: "User asked to always start with a greeting.",
      hints: { keywords: ["greeting", "hello"], chipTrigger: false, alwaysOn: false },
    });
    expect(propose.ok).toBe(true);
    if (!propose.ok) return;
    const { proposalId } = propose.value as { proposalId: string };

    // AI cannot review.
    const aiReview = await execute(registry, adapter, aiCtx, "skills.review_proposal", {
      proposalId,
      decision: "accept",
    });
    expect(aiReview.ok).toBe(false);
    if (!aiReview.ok) {
      expect(aiReview.error.kind).toBe("ActorScopeRejected");
    }

    const accept = await execute(registry, adapter, systemCtx, "skills.review_proposal", {
      proposalId,
      decision: "accept",
    });
    expect(accept.ok).toBe(true);

    const get = await execute(registry, adapter, systemCtx, "skills.get", { slug: TEST_SLUG });
    if (!get.ok) return;
    const skill = (get.value as { skill: { status: string; body: string } | null }).skill;
    expect(skill?.status).toBe("awaiting_activation");
    expect(skill?.body).toContain("friendly greeting");
  });

  it("AI cannot directly skills.set (Owner-only)", async () => {
    const r = await execute(registry, adapter, aiCtx, "skills.set", {
      slug: "test-p10a-direct",
      displayName: "Direct",
      body: "Body",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("ActorScopeRejected");
    }
  });

  it("rejecting a proposal closes it without creating a skill", async () => {
    const propose = await execute(registry, adapter, aiCtx, "skills.propose", {
      slug: TEST_SLUG,
      displayName: "Test",
      body: "Body",
      rationale: "Why",
    });
    if (!propose.ok) throw new Error("propose failed");
    const { proposalId } = propose.value as { proposalId: string };
    const reject = await execute(registry, adapter, systemCtx, "skills.review_proposal", {
      proposalId,
      decision: "reject",
      decisionNote: "not a fit",
    });
    expect(reject.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "skills.get", { slug: TEST_SLUG });
    if (!get.ok) return;
    expect((get.value as { skill: unknown }).skill).toBeNull();
  });

  it("activating a skill flips status from awaiting_activation to active", async () => {
    const propose = await execute(registry, adapter, aiCtx, "skills.propose", {
      slug: TEST_SLUG,
      displayName: "Test",
      body: "Body",
      rationale: "Why",
    });
    if (!propose.ok) throw new Error("propose failed");
    await execute(registry, adapter, systemCtx, "skills.review_proposal", {
      proposalId: (propose.value as { proposalId: string }).proposalId,
      decision: "accept",
    });
    const activate = await execute(registry, adapter, systemCtx, "skills.set", {
      slug: TEST_SLUG,
      displayName: "Test",
      description: "",
      body: "Body",
      allowlistedTools: [],
      hints: { keywords: [], chipTrigger: false, alwaysOn: false },
      status: "active",
    });
    expect(activate.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "skills.get", { slug: TEST_SLUG });
    if (!get.ok) return;
    expect((get.value as { skill: { status: string } | null }).skill?.status).toBe("active");
  });
});

describe("seeded base skills", () => {
  it("compose-page, explain-page, brand-voice-guard, scoped-edit, bootstrap-site are active", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) return;
    const slugs = (r.value as { skills: { slug: string }[] }).skills.map((s) => s.slug);
    expect(slugs).toContain("compose-page");
    expect(slugs).toContain("explain-page");
    expect(slugs).toContain("brand-voice-guard");
    expect(slugs).toContain("scoped-edit");
    // v0.5.10 — new fresh-install bootstrap skill
    expect(slugs).toContain("bootstrap-site");
  });

  // v0.5.10 — wording lock: skill bodies must not reference CLAUDE.md.
  // The file isn't accessible to the AI; citations there sound like
  // referenceable external docs and led the model to hallucinate
  // about being able to follow them. Reword inline rules instead.
  it("no skill body references CLAUDE.md", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) return;
    const skills = (r.value as { skills: { slug: string; body: string }[] }).skills;
    for (const s of skills) {
      expect(s.body).not.toContain("CLAUDE.md");
    }
  });

  // v0.5.10 — bootstrap-site skill must allowlist the four scaffold
  // tools so it can actually execute the layout → template →
  // site_defaults → first-page chain when it engages.
  // v0.5.12 — extended to also require the read-fallback tools so the
  // skill can self-fetch UUIDs after each step instead of asking the
  // operator.
  it("bootstrap-site allowlists scaffold + list_* fetch + layout-chrome tools", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) return;
    const skills = (r.value as { skills: { slug: string; allowlistedTools: string[] }[] }).skills;
    const bootstrap = skills.find((s) => s.slug === "bootstrap-site");
    expect(bootstrap).toBeDefined();
    const tools = bootstrap?.allowlistedTools ?? [];
    expect(tools).toContain("create_layout");
    expect(tools).toContain("create_template");
    expect(tools).toContain("set_site_defaults");
    expect(tools).toContain("create_page");
    // v0.5.12 — list_* fetch tools (close the "I don't have the UUID" gap)
    expect(tools).toContain("list_layouts");
    expect(tools).toContain("list_templates");
    expect(tools).toContain("list_pages");
    // v0.6.1 — SEO tools (migration 0086). Without them the skill's
    // engaged catalog filters them out and AI reports "tool doesn't
    // exist" when asked to set meta-descriptions on a fresh build.
    expect(tools).toContain("set_page_seo");
    // v0.7.5 — add_module_to_layout (migration 0088). Added by 0081,
    // silently dropped by 0083, missed by 0085 + 0086. The header /
    // footer / nav chrome lives at the layout level; without this
    // tool in the allowlist the AI literally cannot see it when the
    // bootstrap-site skill engages, and the only escape is the
    // dead-end of stuffing chrome into a page's content block.
    expect(tools).toContain("add_module_to_layout");
  });

  // v0.6.1 — compose-page is the most frequently engaged skill on
  // build prompts. Migration 0086 added the three SEO tools to its
  // allowlist so the AI never surfaces "I don't have a tool for that"
  // for SEO during a compose flow.
  // v0.7.5 — also requires add_module_to_layout (same regression as
  // bootstrap-site, dropped by 0083, restored by 0088).
  it("compose-page allowlists SEO + layout-chrome tools", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) return;
    const skills = (r.value as { skills: { slug: string; allowlistedTools: string[] }[] }).skills;
    const compose = skills.find((s) => s.slug === "compose-page");
    expect(compose).toBeDefined();
    const tools = compose?.allowlistedTools ?? [];
    expect(tools).toContain("set_page_seo");
    expect(tools).toContain("autofill_page_seo");
    expect(tools).toContain("optimize_page_seo");
    expect(tools).toContain("add_module_to_layout");
  });
});
