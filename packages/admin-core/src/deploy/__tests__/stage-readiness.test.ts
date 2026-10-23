// SPDX-License-Identifier: MPL-2.0

/**
 * Stage readiness, pure (deploy/stage-readiness.ts). Each case is a site
 * state from the e2e-livedit "Detected bugs" where `stage_changes` was
 * refused because the AI learned the build's preconditions only from the
 * refusal: the note must name the condition and the call that clears it,
 * and say nothing for a site the build accepts.
 */

import { describe, expect, it } from "bun:test";
import {
  assessStageReadiness,
  describeStageReadiness,
  STAGE_READINESS_PAGES_LISTED,
  type StageReadinessPage,
} from "../stage-readiness.js";

const page = (
  id: string,
  title: string,
  path: string,
  status: "draft" | "published",
  hasMetaDescription: boolean,
): StageReadinessPage => ({ id, title, path, status, hasMetaDescription });

describe("assessStageReadiness / describeStageReadiness", () => {
  it("a published homepage with every description: ready, no note", () => {
    const r = assessStageReadiness([
      page("h", "Home", "/", "published", true),
      page("a", "About", "/about", "published", true),
      page("d", "Draft idea", "/idea", "draft", false),
    ]);
    expect(r.ready).toBe(true);
    expect(describeStageReadiness(r)).toBeNull();
  });

  it("'0 published pages': only a draft homepage — publish it, and write its description", () => {
    const r = assessStageReadiness([page("h", "Home", "/", "draft", false)]);
    expect(r.nothingPublished).toBe(true);
    expect(r.draftRootPage?.id).toBe("h");
    // The draft homepage is about to be published, so its missing
    // description is named now, not by the next refused Stage.
    expect(r.missingMetaDescription.pages.map((p) => p.id)).toEqual(["h"]);
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain("the homepage 'Home' (/, pageId h) is a draft");
    expect(note).toContain("set_pages_status_many");
    expect(note).toContain("autofill_page_seo_many");
    // Covered by the homepage step — not a second "publish the drafts" step.
    expect(note).not.toContain("nothing to serve");
  });

  it("'no page serves /' with published about/contact and a draft home", () => {
    const r = assessStageReadiness([
      page("h", "Home", "/", "draft", true),
      page("a", "About", "/about", "published", true),
      page("c", "Contact", "/contact", "published", true),
    ]);
    expect(r.rootMissing).toBe(true);
    expect(r.nothingPublished).toBe(false);
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain("pageId h) is a draft");
    expect(note).not.toContain("meta description");
  });

  it("no page at '/' at all: designate the homepage, never rename another page", () => {
    const r = assessStageReadiness([page("g", "Get Started", "/get-started", "published", true)]);
    expect(r.rootMissing).toBe(true);
    expect(r.draftRootPage).toBeNull();
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain("set_home_page");
    expect(note).toContain("never rename another page to 'home'");
  });

  it("only drafts and none at '/': designate + publish, naming the drafts", () => {
    const r = assessStageReadiness([page("x", "Landing", "/landing", "draft", false)]);
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain("set_home_page");
    expect(note).toContain("nothing to serve");
    expect(note).toContain("'Landing' (/landing, pageId x)");
  });

  it("'would go live without a meta description': names every published page without one", () => {
    const r = assessStageReadiness([
      page("h", "Home", "/", "published", false),
      page("k", "Kontakt", "/kontakt", "published", false),
      page("d", "Draft", "/draft", "draft", false),
    ]);
    expect(r.rootMissing).toBe(false);
    expect(r.missingMetaDescription.pages.map((p) => p.id)).toEqual(["h", "k"]);
    const note = describeStageReadiness(r) ?? "";
    expect(note).toContain("2 page(s) have no meta description");
    expect(note).toContain("ONE autofill_page_seo_many call");
    // A draft is not built, so it does not block.
    expect(note).not.toContain("pageId d");
  });

  it("an empty site: says not to Stage yet instead of inventing work", () => {
    const note = describeStageReadiness(assessStageReadiness([])) ?? "";
    expect(note).toContain("no pages yet");
    expect(note).toContain("Do not call stage_changes until the homepage exists");
  });

  it("long lists stay bounded but keep the exact count", () => {
    const pages = Array.from({ length: STAGE_READINESS_PAGES_LISTED + 3 }, (_, i) =>
      page(`p${i}`, `P${i}`, i === 0 ? "/" : `/p${i}`, "published", false),
    );
    const r = assessStageReadiness(pages);
    expect(r.missingMetaDescription.count).toBe(STAGE_READINESS_PAGES_LISTED + 3);
    expect(r.missingMetaDescription.pages).toHaveLength(STAGE_READINESS_PAGES_LISTED);
    expect(describeStageReadiness(r)).toContain("and 3 more");
  });
});
