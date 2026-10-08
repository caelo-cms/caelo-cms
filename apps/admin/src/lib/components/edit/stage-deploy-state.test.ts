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
import { formResultError, publishButtonState, qualityBlockReason } from "./stage-deploy-state.js";

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
