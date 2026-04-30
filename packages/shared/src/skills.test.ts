// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import {
  type CandidateSkill,
  matchSkills,
  resolveEngagements,
  type SkillAutoEngagementHints,
} from "./skills.js";

const skill = (
  id: string,
  slug: string,
  hints: Partial<SkillAutoEngagementHints> = {},
): CandidateSkill => ({
  id,
  slug,
  displayName: slug,
  hints: { keywords: [], chipTrigger: false, alwaysOn: false, ...hints },
});

describe("matchSkills", () => {
  it("alwaysOn skills score at least 1 with no other context", () => {
    const out = matchSkills({
      userMessage: "anything",
      chipCount: 0,
      skills: [skill("a", "always", { alwaysOn: true })],
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.slug).toBe("always");
    expect(out[0]?.rationale).toContain("always-on");
  });

  it("chipTrigger skills score 100 when chips present", () => {
    const out = matchSkills({
      userMessage: "make this red",
      chipCount: 2,
      skills: [
        skill("a", "scoped-edit", { chipTrigger: true }),
        skill("b", "compose-page", { keywords: ["page"] }),
      ],
    });
    expect(out[0]?.slug).toBe("scoped-edit");
    expect(out[0]?.score).toBeGreaterThanOrEqual(100);
  });

  it("chipTrigger skill is dropped when no chips", () => {
    const out = matchSkills({
      userMessage: "edit",
      chipCount: 0,
      skills: [skill("a", "scoped-edit", { chipTrigger: true })],
    });
    expect(out).toHaveLength(0);
  });

  it("keywords boost score by 1 each, case-insensitive", () => {
    const out = matchSkills({
      userMessage: "Please CREATE a New Page for blog",
      chipCount: 0,
      skills: [skill("a", "compose-page", { keywords: ["create", "new page", "page"] })],
    });
    expect(out[0]?.score).toBe(3);
    expect(out[0]?.rationale).toContain("create");
  });

  it("topK caps the result count", () => {
    const skills = Array.from({ length: 10 }, (_, i) =>
      skill(String(i), `s${i}`, { alwaysOn: true }),
    );
    const out = matchSkills({ userMessage: "x", chipCount: 0, skills, topK: 3 });
    expect(out).toHaveLength(3);
  });

  it("zero-score skills never engage", () => {
    const out = matchSkills({
      userMessage: "hello",
      chipCount: 0,
      skills: [skill("a", "explain-page", { keywords: ["describe"] })],
    });
    expect(out).toHaveLength(0);
  });
});

describe("resolveEngagements", () => {
  it("manual disengage overrides pinned + auto", () => {
    const final = resolveEngagements({
      autoMatches: [
        { skillId: "a", slug: "auto-a", displayName: "A", score: 5, rationale: "auto" },
      ],
      manualOverrides: [{ skillId: "a", slug: "auto-a", displayName: "A", intent: "disengage" }],
      pinnedSkills: [{ skillId: "a", slug: "auto-a", displayName: "A" }],
    });
    expect(final).toHaveLength(0);
  });

  it("manual engage overrides matcher absence", () => {
    const final = resolveEngagements({
      autoMatches: [],
      manualOverrides: [{ skillId: "x", slug: "x", displayName: "X", intent: "engage" }],
      pinnedSkills: [],
    });
    expect(final).toHaveLength(1);
    expect(final[0]?.source).toBe("manual");
  });

  it("pinned default engages without other input", () => {
    const final = resolveEngagements({
      autoMatches: [],
      manualOverrides: null,
      pinnedSkills: [{ skillId: "p", slug: "p", displayName: "P" }],
    });
    expect(final).toHaveLength(1);
    expect(final[0]?.source).toBe("pinned");
  });

  it("auto match labels source as auto when not pinned + not manual", () => {
    const final = resolveEngagements({
      autoMatches: [{ skillId: "a", slug: "a", displayName: "A", score: 3, rationale: "kw" }],
      manualOverrides: null,
      pinnedSkills: [],
    });
    expect(final[0]?.source).toBe("auto");
  });
});
