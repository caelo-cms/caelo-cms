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
import { buildSkillsContext, extractLoadedSkillSlugs } from "../ai/chat-runner/context/skills.js";
import type { ToolContext } from "../ai/tools/dispatch.js";
import { liveToolNames } from "../ai/tools/live-tool-names.js";
import { loadSkillTool } from "../ai/tools/load-skill.js";
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
    // silently dropped by 0083, missed by 0085 + 0086, restored by 0088.
    // 0164 renamed it: the three add_module_to_* tools became one
    // `add_module` routed by `target` (#322), so the allowlist now lists
    // `add_module`. The header / footer / nav chrome lives at the layout
    // level; without this tool in the allowlist the AI literally cannot see
    // it when the bootstrap-site skill engages, and the only escape is the
    // dead-end of stuffing chrome into a page's content block.
    expect(tools).toContain("add_module");
  });

  // v0.6.1 — compose-page is the most frequently engaged skill on
  // build prompts. Migration 0086 added the three SEO tools to its
  // allowlist so the AI never surfaces "I don't have a tool for that"
  // for SEO during a compose flow.
  // v0.7.5 — also requires the layout-chrome tool (same regression as
  // bootstrap-site, dropped by 0083, restored by 0088, renamed to
  // `add_module` by 0164 / #322).
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
    expect(tools).toContain("add_module");
    // The rename must be complete — no dead tool names left in the allowlist.
    expect(tools).not.toContain("add_module_to_layout");
    expect(tools).not.toContain("compose_page_from_spec");
  });
});

// 0168 / 0169 — a skill per authoring domain + workflow. Every LARGER task
// the operator describes in outcomes ("build a card", "add a footer menu",
// "write a meta description") gets a skill that hands the AI the right call
// shape, so the design test of §1A holds: the AI can act without a human
// round-trip.
describe("authoring + workflow skills (0168 / 0169)", () => {
  const CORE_DOMAIN = ["manage-module", "manage-menu"];
  const WORKFLOW = [
    "shared-content",
    "manage-media",
    "page-seo",
    "manage-redirects",
    "theme-branding",
    "templates-layouts",
    "import-page",
  ];
  const ALL_NEW = [...CORE_DOMAIN, ...WORKFLOW];

  async function activeSkills(): Promise<
    {
      slug: string;
      displayName: string;
      body: string;
      allowlistedTools: string[];
      hints: unknown;
    }[]
  > {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) throw new Error("skills.list failed");
    return (
      r.value as {
        skills: {
          id: string;
          slug: string;
          displayName: string;
          body: string;
          allowlistedTools: string[];
          hints: unknown;
        }[];
      }
    ).skills;
  }

  it("all new skills are seeded active", async () => {
    const slugs = (await activeSkills()).map((s) => s.slug);
    for (const slug of ALL_NEW) expect(slugs).toContain(slug);
  });

  // The #301 invariant: an allowlist entry that isn't a live tool name is a
  // dead preload hint (logged as skill-allowlist-unresolved-entry) — it means
  // the skill teaches a tool the AI can't call. Every entry must resolve.
  it("every new skill's allowlist resolves to live tool names", async () => {
    const live = liveToolNames();
    const skills = await activeSkills();
    for (const slug of ALL_NEW) {
      const skill = skills.find((s) => s.slug === slug);
      expect(skill).toBeDefined();
      for (const tool of skill?.allowlistedTools ?? []) {
        expect({ slug, tool, isLive: live.has(tool) }).toEqual({ slug, tool, isLive: true });
      }
    }
  });

  it("compose-page is now the page DOMAIN skill (create + edit)", async () => {
    const compose = (await activeSkills()).find((s) => s.slug === "compose-page");
    expect(compose).toBeDefined();
    expect(compose?.displayName).toBe("Create & edit pages");
    expect(compose?.body).toContain("EDITING an existing page");
    const tools = compose?.allowlistedTools ?? [];
    // Edit-path tools joined by 0168 (dedup-safe union kept the create tools).
    for (const t of [
      "set_page_module_content",
      "set_pages_status_many",
      "update_pages_many",
      "remove_module_from",
      "repoint_page_template",
      "build_page",
    ]) {
      expect(tools).toContain(t);
    }
  });

  // Progressive disclosure: the STATIC `## Skills` index lists every active
  // skill's slug + description (the model's discovery surface) but never the
  // bodies — those load on demand via load_skill into the message history.
  it("the ## Skills index lists slug + description, not bodies", async () => {
    const skills = await buildSkillsContext(registry, adapter, systemCtx, { loadedSkillSlugs: [] });
    const idx = skills.skillsIndexBlock ?? "";
    expect(idx).toContain("# Skills");
    expect(idx).toContain("load_skill({slug})");
    for (const slug of ALL_NEW) expect(idx).toContain(`- ${slug}:`);
    // Structural-trigger skills get a prominent callout so the model loads them
    // at the right moment (body still fetched on demand): brand-voice-guard is
    // alwaysOn → the "ALWAYS APPLIES" section names it.
    expect(idx).toContain("ALWAYS APPLIES");
    expect(idx).toContain("brand-voice-guard");
    // The full body must NOT be in the index (a distinctive manage-menu phrase).
    expect(idx).not.toContain("UPSERT that REPLACES the whole items list");
    // Nothing loaded yet → no preload, no engaged skills.
    expect(skills.allowedToolNames).toBeNull();
    expect(skills.engagedSkills.length).toBe(0);
  });

  // load_skill is the activation step: valid slug returns the full body; an
  // unknown slug returns the list of valid slugs (AI-actionable error, §11).
  it("load_skill returns the body for a valid slug and lists slugs for an unknown one", async () => {
    const toolCtx = { registry, adapter } as unknown as ToolContext;
    const ok = await loadSkillTool.handler(aiCtx, { slug: "manage-menu" }, toolCtx);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.content).toContain("manage-menu");
      // The actual body, verbatim — this is what lands in history.
      expect(ok.content).toContain("REPLACES the whole items list");
      // The allowlisted tools are surfaced so the model knows what it can call.
      expect(ok.content).toContain("set_structured_set");
    }
    const bad = await loadSkillTool.handler(aiCtx, { slug: "does-not-exist" }, toolCtx);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.content).toContain("manage-menu"); // names a valid slug
  });

  // Once loaded, a skill stays available: extractLoadedSkillSlugs recovers it
  // from the history's load_skill tool call, and buildSkillsContext then
  // preloads that skill's tools (no tool-search round-trip on later turns).
  it("a loaded skill is recovered from history and its tools preloaded", async () => {
    const history = [
      { toolCalls: [{ id: "t1", name: "load_skill", arguments: { slug: "manage-menu" } }] },
      { toolCalls: [{ id: "t2", name: "edit_module", arguments: { moduleId: "x" } }] },
    ];
    expect(extractLoadedSkillSlugs(history)).toEqual(["manage-menu"]);

    const skills = await buildSkillsContext(registry, adapter, systemCtx, {
      loadedSkillSlugs: ["manage-menu"],
    });
    expect(skills.engagedSkills.map((e) => e.slug)).toContain("manage-menu");
    // manage-menu's allowlist preloads the structured-set tools.
    expect(skills.allowedToolNames?.has("set_structured_set")).toBe(true);
  });
});

// issue #301 — allowlists name AI tool names, never Query-API op names.
// Save-time validation is the loud path (CLAUDE.md §2): unknown entries
// reject with the bad entry + a nearest-name suggestion; known
// op-notation entries normalize to tool names on write. Migration 0157
// normalized the 0033-seeded reviewer skills.
describe("skill allowlist validation (issue #301)", () => {
  it("skills.set rejects an unknown allowlist entry, naming it with a suggestion", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.set", {
      slug: "test-p10a-badallow",
      displayName: "Bad allowlist",
      body: "Body",
      allowlistedTools: ["edit_modul"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("HandlerError");
      if (r.error.kind === "HandlerError") {
        expect(r.error.message).toContain('"edit_modul"');
        expect(r.error.message).toContain('"edit_module"');
      }
    }
  });

  it("skills.set normalizes op-notation entries to tool names on write", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.set", {
      slug: "test-p10a-opnames",
      displayName: "Op notation",
      body: "Body",
      allowlistedTools: ["pages.list", "structured_sets.get", "edit_module", "glossary.list"],
    });
    expect(r.ok).toBe(true);
    const get = await execute(registry, adapter, systemCtx, "skills.get", {
      slug: "test-p10a-opnames",
    });
    if (!get.ok) return;
    const skill = (get.value as { skill: { allowlistedTools: string[] } | null }).skill;
    // Translated + deduped; the context-served glossary read drops.
    expect(skill?.allowlistedTools).toEqual(["list_pages", "get_structured_set", "edit_module"]);
  });

  it("skills.propose rejects an unknown allowlist entry at proposal time (AI-actionable failure)", async () => {
    const r = await execute(registry, adapter, aiCtx, "skills.propose", {
      slug: "test-p10a-badpropose",
      displayName: "Bad propose",
      body: "Body",
      rationale: "Why",
      allowlistedTools: ["pages.frobnicate"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe("HandlerError");
      if (r.error.kind === "HandlerError") {
        expect(r.error.message).toContain('"pages.frobnicate"');
      }
    }
  });

  it("migration 0157: the seeded reviewer skills carry tool-name allowlists", async () => {
    const r = await execute(registry, adapter, systemCtx, "skills.list", { status: "active" });
    if (!r.ok) return;
    const skills = (r.value as { skills: { slug: string; allowlistedTools: string[] }[] }).skills;
    const bySlug = new Map(skills.map((s) => [s.slug, s.allowlistedTools]));
    expect(bySlug.get("qa-check")).toEqual([
      "inspect_page_render",
      "list_pages",
      "get_structured_set",
      "list_structured_sets",
    ]);
    expect(bySlug.get("legal-check")).toEqual(["inspect_page_render", "list_pages"]);
    expect(bySlug.get("menu-auditor")).toEqual([
      "list_structured_sets",
      "get_structured_set",
      "find_redirects",
      "list_pages",
    ]);
    expect(bySlug.get("page-categorizer")).toEqual(["list_pages"]);
    // No active skill may carry an op-notation entry at all.
    for (const s of skills) {
      for (const entry of s.allowlistedTools) {
        expect(entry).not.toContain(".");
      }
    }
  });
});
