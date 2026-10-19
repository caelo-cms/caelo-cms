// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
  BREAKING_NOTHING_TO_DO,
  hasOwnerNotes,
  ownerLine,
  ownerReleaseNotes,
} from "./owner-release-notes.js";

/** The real body of the v0.10.53 GitHub release (`gh release view v0.10.53 --json body`). */
const V0_10_53 = readFileSync(
  new URL("./__fixtures__/release-notes-v0.10.53.md", import.meta.url),
  "utf8",
);

describe("ownerReleaseNotes — the v0.10.53 release", () => {
  const notes = ownerReleaseNotes(V0_10_53);
  const all = [...notes.added, ...notes.fixed, ...notes.security];

  it("groups the changes into New, Fixed and Security", () => {
    expect(notes).toEqual({
      added: [
        "Core links check on the staged build",
        "Drop the gateway's former cms_admin login — contract",
        "Core structure check + write-time hints for repeated free markup",
        "Release docs-sync prepare step + developer reference generator",
      ],
      fixed: [
        "Favicon 64px rendition (LCP) + no auto fix round after an operator decision",
        "Staged GCS reads fall back to live only for files the build contains",
        "Enforce auth_config, server-side captcha/honeypots, HTML escaping, and ai_moderate archival",
        "Scan content values for internal links by declared field kind",
        "GCS publish deletes live files the build no longer contains",
        "Name a Caelo upgrade in the parity refusal and always offer Stage again",
      ],
      security: [
        "Prevent X-Forwarded-For spoofing, bind PoW challenges, rate-limit challenge minting, and guard cross-site POSTs",
        "Harden AST validator, sandbox bootstrap, and schema UUID checks",
      ],
      breaking: BREAKING_NOTHING_TO_DO,
    });
  });

  it("shows no commit hashes, issue or PR numbers, or BREAKING markers", () => {
    for (const line of all) {
      expect(line).not.toMatch(/\b[0-9a-f]{8}\b/);
      expect(line).not.toMatch(/#\d/);
      expect(line).not.toContain("BREAKING");
      expect(line).not.toContain("⚠");
    }
  });

  it("leaves the docs out (nothing changes on the Owner's site)", () => {
    expect(all.some((l) => /power-mcp|dev loop|developer docs/i.test(l))).toBe(false);
  });
});

describe("ownerReleaseNotes — breaking changes", () => {
  const body = "### Features\n- abc1234 new thing (#1) ⚠ BREAKING\n";
  it("uses the release's own instruction when it carries one", () => {
    expect(
      ownerReleaseNotes(body, { breakingAction: "Re-enter your SMTP password afterwards." })
        .breaking,
    ).toBe("Re-enter your SMTP password afterwards.");
  });
  it("falls back to 'nothing to do' for an empty instruction", () => {
    expect(ownerReleaseNotes(body, { breakingAction: "  " }).breaking).toBe(BREAKING_NOTHING_TO_DO);
  });
  it("is null without a breaking change", () => {
    expect(ownerReleaseNotes("### Fixes\n- abc1234 a fix (#2)\n").breaking).toBeNull();
  });
  it("counts a breaking change even in a section the Owner does not see", () => {
    const notes = ownerReleaseNotes("### Chores\n- abc1234 drop old column ⚠ BREAKING\n");
    expect(notes.breaking).toBe(BREAKING_NOTHING_TO_DO);
    expect(notes.added).toEqual([]);
  });
});

describe("ownerReleaseNotes — other shapes", () => {
  it("reads conventional prefixes on lines release.ts could not group", () => {
    const notes = ownerReleaseNotes(
      "### Other\n- abc1234 feat(editor): undo for media (#9)\n- def5678 fix!: broken login\n- Merge branch main\n",
    );
    expect(notes.added).toEqual(["Undo for media"]);
    expect(notes.fixed).toEqual(["Broken login"]);
    expect(notes.breaking).toBe(BREAKING_NOTHING_TO_DO);
  });
  it("a Security heading lands in Security", () => {
    expect(ownerReleaseNotes("### Security\n- abc1234 tighten cookies (#3)\n").security).toEqual([
      "Tighten cookies",
    ]);
  });
  it("nothing to show for a body without bullets", () => {
    const notes = ownerReleaseNotes("**Full Changelog**: https://github.com/x/y/compare/a...b");
    expect(hasOwnerNotes(notes)).toBe(false);
  });
});

describe("ownerLine", () => {
  it("strips the hash, scope prefix and every kind of reference", () => {
    expect(
      ownerLine("- 99ae9e02 fix(gateway): drop login (#635, 4/4, release after #767) (#775)"),
    ).toEqual({ text: "Drop login", type: "fix", breaking: false });
  });
});
