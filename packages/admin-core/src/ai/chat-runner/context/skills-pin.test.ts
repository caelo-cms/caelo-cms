// SPDX-License-Identifier: MPL-2.0

/**
 * The `## Skills` index is pinned to what was active when the chat
 * began (migration 0213).
 *
 * Regression class: the index lives in the CACHED system prefix. Built
 * from live rows every turn, one skill activation rewrites that prefix
 * for every open chat, and each of them pays a full re-read of it on
 * its next turn — the exact cost CLAUDE.md §11 keeps dynamic content
 * out of the system prompt to avoid. The pin is what makes activation
 * free for running chats; `newlyActivated` is how they still hear
 * about it, through the append-only history.
 */

import { describe, expect, it } from "bun:test";
import type { DatabaseAdapter, TransactionRunner } from "@caelo-cms/query-api";
import { defineOperation, OperationRegistry } from "@caelo-cms/query-api";
import type { ExecutionContext } from "@caelo-cms/shared";
import { ok } from "@caelo-cms/shared";
import { z } from "zod";

import { buildSkillsContext, formatNewSkillsNotice } from "./skills.js";

const CHAT_START = "2026-08-07T12:00:00.000Z";
const BEFORE = "2026-08-07T10:00:00.000Z";
const AFTER = "2026-08-07T14:00:00.000Z";

interface FixtureSkill {
  slug: string;
  activatedAt: string | null;
}

function buildFixture(skills: readonly FixtureSkill[]): {
  registry: OperationRegistry;
  adapter: DatabaseAdapter;
} {
  const registry = new OperationRegistry();
  registry.register(
    defineOperation({
      name: "skills.list",
      actorScope: ["human", "ai", "system"],
      database: "cms_admin",
      input: z.looseObject({}),
      output: z.looseObject({}),
      handler: async () =>
        ok({
          skills: skills.map((s) => ({
            id: `id-${s.slug}`,
            slug: s.slug,
            displayName: s.slug,
            description: `does ${s.slug}`,
            body: `body of ${s.slug}`,
            allowlistedTools: [`tool_${s.slug}`],
            hints: {},
            status: "active",
            activatedAt: s.activatedAt,
          })),
        }),
    }),
  );
  const adapter = {
    runOperation: (
      op: { handler: (ctx: ExecutionContext, input: unknown, tx: TransactionRunner) => unknown },
      ctx: ExecutionContext,
      input: unknown,
    ) => op.handler(ctx, input, {} as TransactionRunner),
  } as unknown as DatabaseAdapter;
  return { registry, adapter };
}

const CTX: ExecutionContext = { actorId: "op-1", actorKind: "human", requestId: "r1" };

async function build(skills: readonly FixtureSkill[], chatStartedAt: string | null) {
  const { registry, adapter } = buildFixture(skills);
  return buildSkillsContext(registry, adapter, CTX, { loadedSkillSlugs: [], chatStartedAt });
}

describe("skills index pin", () => {
  it("indexes skills that were active when the chat began", async () => {
    const r = await build([{ slug: "brand-voice", activatedAt: BEFORE }], CHAT_START);
    expect(r.skillsIndexBlock).toContain("brand-voice");
    expect(r.newlyActivated).toEqual([]);
  });

  it("keeps a skill activated mid-chat OUT of the index and reports it as new", async () => {
    const r = await build(
      [
        { slug: "brand-voice", activatedAt: BEFORE },
        { slug: "translate-page", activatedAt: AFTER },
      ],
      CHAT_START,
    );
    // The cached prefix is untouched by the activation…
    expect(r.skillsIndexBlock).toContain("brand-voice");
    expect(r.skillsIndexBlock).not.toContain("translate-page");
    // …and the chat still learns about it, via the history.
    expect(r.newlyActivated.map((s) => s.slug)).toEqual(["translate-page"]);
  });

  it("still preloads a newly activated skill's tools once the model loads it", async () => {
    const { registry, adapter } = buildFixture([{ slug: "translate-page", activatedAt: AFTER }]);
    const r = await buildSkillsContext(registry, adapter, CTX, {
      loadedSkillSlugs: ["translate-page"],
      chatStartedAt: CHAT_START,
    });
    // The pin governs the PREFIX only. A skill the model actually
    // loaded must behave like any other — otherwise the notice would
    // advertise a skill whose tools never get preloaded.
    expect(r.allowedToolNames?.has("tool_translate-page")).toBe(true);
    expect(r.engagedSkills.map((e) => e.slug)).toEqual(["translate-page"]);
  });

  it("treats a row with no activation stamp as always having been there", async () => {
    // Rows predating migration 0213. Reading a null stamp as "brand
    // new" would announce every legacy skill to every open chat.
    const r = await build([{ slug: "legacy-skill", activatedAt: null }], CHAT_START);
    expect(r.skillsIndexBlock).toContain("legacy-skill");
    expect(r.newlyActivated).toEqual([]);
  });

  it("applies no pin when the chat start is unknown", async () => {
    const r = await build([{ slug: "translate-page", activatedAt: AFTER }], null);
    expect(r.skillsIndexBlock).toContain("translate-page");
    expect(r.newlyActivated).toEqual([]);
  });

  it("names each new skill with its description so the model can choose", async () => {
    const notice = formatNewSkillsNotice([
      { slug: "translate-page", description: "how to translate pages" },
    ]);
    expect(notice).toContain("translate-page: how to translate pages");
    expect(notice).toContain("load_skill");
  });
});
