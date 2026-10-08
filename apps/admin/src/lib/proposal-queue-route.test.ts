// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { proposalQueueRoute } from "./proposal-queue-route.js";

describe("proposalQueueRoute", () => {
  it("maps domains whose Owner page path differs from the op domain", () => {
    expect(proposalQueueRoute("owner_settings")).toBe("/security/owner-settings/pending");
    expect(proposalQueueRoute("email_config")).toBe("/security/email/pending");
    expect(proposalQueueRoute("deploy")).toBe("/security/deployments/pending");
  });

  // Regression: site_defaults proposals are approved on the SEO page, not at
  // a nonexistent /security/site_defaults/pending.
  it("routes site_defaults to the SEO settings page", () => {
    expect(proposalQueueRoute("site_defaults")).toBe("/security/seo");
  });

  it("routes needsApproval tool calls to the tool-approvals queue", () => {
    expect(proposalQueueRoute("tool_approvals")).toBe("/security/tool-approvals/pending");
  });

  it("falls back to the /security/<domain>/pending convention", () => {
    expect(proposalQueueRoute("themes")).toBe("/security/themes/pending");
  });
});
