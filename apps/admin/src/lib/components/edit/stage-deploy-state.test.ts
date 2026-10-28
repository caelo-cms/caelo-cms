// SPDX-License-Identifier: MPL-2.0

/**
 * run #10 D6 regression — "Publish live" click produced no visible UI
 * effect. Root cause: with no succeeded staging build the button was
 * disabled with only a hover tooltip (silent click), and enabled-path
 * failures relied on the dedup-prone layout toast. Same tier as #267's
 * regression test (unit): pin the visible-reason and inline-error
 * contracts the component renders from.
 */

import { describe, expect, it } from "bun:test";
import { PARITY_REFUSAL_PREFIX } from "@caelo-cms/shared";
import {
  formResultError,
  offersStageAgain,
  pendingEntryKey,
  publishButtonState,
  publishErrorNextStep,
  qualityBlockReason,
  stageToolbarMode,
  stagingMenuState,
} from "./stage-deploy-state.js";

describe("publishButtonState", () => {
  it("run #10 state — nothing staged: disabled WITH a visible reason, not tooltip-only", () => {
    const st = publishButtonState({
      busy: false,
      hasStagedBuild: false,
      productionMatchesStaging: null,
    });
    expect(st.disabled).toBe(true);
    expect(st.visibleReason).toContain("Stage first");
    expect(st.tooltip).toBe(st.visibleReason as string);
  });

  it("live already matches staging: disabled, no extra text (sync indicator covers it)", () => {
    const st = publishButtonState({
      busy: false,
      hasStagedBuild: true,
      productionMatchesStaging: true,
    });
    expect(st.disabled).toBe(true);
    expect(st.visibleReason).toBeNull();
    expect(st.tooltip).toContain("nothing to publish");
  });

  it("staged build present and live behind: enabled", () => {
    for (const productionMatchesStaging of [false, null]) {
      const st = publishButtonState({
        busy: false,
        hasStagedBuild: true,
        productionMatchesStaging,
      });
      expect(st.disabled).toBe(false);
      expect(st.visibleReason).toBeNull();
    }
  });

  it("in-flight requests disable without inventing a reason", () => {
    const st = publishButtonState({
      busy: true,
      hasStagedBuild: true,
      productionMatchesStaging: false,
    });
    expect(st.disabled).toBe(true);
    expect(st.visibleReason).toBeNull();
  });
});

describe("formResultError", () => {
  it("success and redirect results clear the inline alert", () => {
    expect(formResultError({ type: "success" })).toBeNull();
    expect(formResultError({ type: "redirect" })).toBeNull();
  });

  it("failure results surface the server's error string", () => {
    expect(formResultError({ type: "failure", data: { error: "Promote failed: no build" } })).toBe(
      "Promote failed: no build",
    );
  });

  it("failure WITHOUT a reason still yields loud text (never null)", () => {
    expect(formResultError({ type: "failure" })).toContain("server logs");
    expect(formResultError({ type: "failure", data: { error: "" } })).toContain("server logs");
  });

  it("error results (crashed request) surface the exception message", () => {
    expect(formResultError({ type: "error", error: new Error("boom") })).toContain("boom");
    expect(formResultError({ type: "error", error: "string-throw" })).toContain("string-throw");
  });
});

describe("publishButtonState — #553 quality gate", () => {
  const base = { busy: false, hasStagedBuild: true, productionMatchesStaging: false };

  it("a blocked gate disables Publish with a visible reason and the full message as tooltip", () => {
    const gate = {
      open: false,
      state: "problems",
      message:
        "Publish live is blocked by 2 quality problem(s): /: image-alt; /about: color-contrast.",
      openProblemCount: 2,
    };
    const st = publishButtonState({ ...base, qualityGate: gate });
    expect(st.disabled).toBe(true);
    expect(st.visibleReason).toContain("2 quality problem(s)");
    expect(st.tooltip).toBe(gate.message);
  });

  it("an open gate (clean, accepted, overridden) or an unknown one does not block", () => {
    for (const state of ["clean", "accepted", "overridden"]) {
      const st = publishButtonState({
        ...base,
        qualityGate: { open: true, state, message: "", openProblemCount: 0 },
      });
      expect(st.disabled).toBe(false);
    }
    expect(publishButtonState({ ...base, qualityGate: null }).disabled).toBe(false);
  });

  it("names the next step per blocked state", () => {
    const reason = (state: string) =>
      qualityBlockReason({ open: false, state, message: "m", openProblemCount: 1 });
    expect(reason("running")).toContain("running");
    expect(reason("errored")).toContain("retry it, or publish anyway");
    expect(reason("missing")).toContain("run the check");
  });
});

/**
 * #835 regression — with no pending edits and a staged build, the toolbar
 * offered Stage again only while the quality gate reported problems, so a
 * Publish live refused by the parity guard (#834) left no way to re-Stage.
 */
describe("Stage again in the toolbar (#835)", () => {
  const promoteOnly = {
    sessionPublished: false,
    branchChangeCount: 0,
    hasStagedBuild: true,
    sessionLastStagedAt: null,
  };

  it("the no-pending-edits + staged-build toolbar always offers Stage again", () => {
    const mode = stageToolbarMode(promoteOnly);
    expect(mode).toBe("promote-only");
    // Independent of the quality gate: it is not an input at all.
    expect(offersStageAgain(mode)).toBe(true);
    // A chat that staged before, even when the staged build is gone.
    const restaged = stageToolbarMode({
      ...promoteOnly,
      hasStagedBuild: false,
      sessionLastStagedAt: "2026-10-17T10:00:00Z",
    });
    expect(offersStageAgain(restaged)).toBe(true);
  });

  it("no Stage again where Stage… covers it, nothing was staged, or the chat is published", () => {
    expect(stageToolbarMode({ ...promoteOnly, branchChangeCount: 3 })).toBe("pending");
    expect(offersStageAgain("pending")).toBe(false);
    expect(stageToolbarMode({ ...promoteOnly, hasStagedBuild: false })).toBe("fresh");
    expect(offersStageAgain("fresh")).toBe(false);
    expect(stageToolbarMode({ ...promoteOnly, sessionPublished: true })).toBe("published");
    expect(offersStageAgain("published")).toBe(false);
  });

  it("a parity refusal gets an untruncated pointer at Stage again; other failures do not", () => {
    const refusal = `${PARITY_REFUSAL_PREFIX} Caelo was updated from 0.10.51 to 0.10.52 since this Stage …`;
    expect(publishErrorNextStep(refusal)).toContain("Stage again");
    expect(publishErrorNextStep("promotion failed: bucket unreachable")).toBeNull();
    expect(publishErrorNextStep(null)).toBeNull();
  });
});

describe("stagingMenuState — the Staging button's label", () => {
  const base = {
    mode: "promote-only" as const,
    busy: false,
    hasStagedBuild: true,
    branchChangeCount: 0,
    qualityGate: null,
  };
  const gate = (state: string, openProblemCount = 0) => ({
    open: false,
    state,
    message: "",
    openProblemCount,
  });

  it("says Staging… while a Stage or Publish runs", () => {
    expect(stagingMenuState({ ...base, busy: true }).label).toBe("Staging…");
  });

  it("marks unstaged edits as pending with their count in the tooltip", () => {
    const s = stagingMenuState({ ...base, mode: "pending", branchChangeCount: 5 });
    expect(s).toEqual({
      label: "Staging",
      tone: "pending",
      tooltip: "5 changes in this chat not staged yet",
    });
  });

  it("says why Publish live is closed when nothing is staged", () => {
    expect(stagingMenuState({ ...base, mode: "fresh", hasStagedBuild: false }).label).toBe(
      "Not staged",
    );
  });

  it("puts the problem count of a blocking quality gate on the button", () => {
    const s = stagingMenuState({ ...base, qualityGate: gate("problems", 3) });
    expect(s.label).toBe("3 problems");
    expect(s.tone).toBe("problem");
    expect(s.tooltip).toContain("Blocked by 3 quality problem(s)");
  });

  it("names a failed and a running check", () => {
    expect(stagingMenuState({ ...base, qualityGate: gate("errored") }).label).toBe("Check failed");
    expect(stagingMenuState({ ...base, qualityGate: gate("running") }).tone).toBe("busy");
  });

  it("reads Staged when staging is built and its gate is open", () => {
    const s = stagingMenuState({ ...base, qualityGate: { ...gate("passed"), open: true } });
    expect(s).toEqual({ label: "Staged", tone: "ok", tooltip: "Staging is built and checked" });
  });
});

describe("pendingEntryKey", () => {
  it("a new page's page and placement entries get distinct keys (Staging menu each-key crash)", () => {
    // chat.list_pending_changes puts content, page and pageLayout entries
    // in one `pages` group; a page minted in the chat has the last two
    // under the same page id.
    const pageId = "8bddc261-fa49-470c-93ea-0f29b62d49b7";
    const pages = [
      { kind: "page", entityId: pageId, label: "Startseite" },
      { kind: "pageLayout", entityId: pageId, label: "Startseite" },
    ];
    const keys = pages.map(pendingEntryKey);
    expect(new Set(keys).size).toBe(pages.length);
  });
});
