// SPDX-License-Identifier: MPL-2.0

import { describe, expect, it } from "bun:test";
import { parseProposalContent } from "./proposal-parser.js";

const UUID = "d2d5a41a-0ecb-4f70-aab1-73963240e9f1";

describe("parseProposalContent", () => {
  it("parses canonical create_layout output", () => {
    const content = `Queued proposal ${UUID}: layout-create slug=default (3 blocks). An Owner must click Approve at /security/layouts/pending to apply.`;
    const result = parseProposalContent(content);
    expect(result).not.toBeNull();
    expect(result?.proposalId).toBe(UUID);
    expect(result?.summary).toBe("layout-create slug=default (3 blocks)");
    expect(result?.queueUrl).toBe("/security/layouts/pending");
    expect(result?.domain).toBe("layouts");
  });

  it("parses canonical propose_add_locale output", () => {
    const content = `Queued proposal ${UUID}: add locale 'de' (subpath). An Owner must click Approve at /security/locales/pending to apply.`;
    const result = parseProposalContent(content);
    expect(result?.domain).toBe("locales");
    expect(result?.queueUrl).toBe("/security/locales/pending");
  });

  it("parses canonical propose_deploy_promote output", () => {
    const content = `Queued proposal ${UUID}: promote staging → production (build=abc, pages=10, files=20). An Owner must click Approve at /security/deployments/pending to apply.`;
    const result = parseProposalContent(content);
    expect(result?.domain).toBe("deployments");
  });

  it("parses canonical tune_rate_limit output", () => {
    const content = `Queued proposal ${UUID}: rate-limit comments.submit = 5/60s. An Owner must click Approve at /security/gateway/pending to apply.`;
    const result = parseProposalContent(content);
    expect(result?.domain).toBe("gateway");
    // Summary may truncate at the first period inside the data (e.g.
    // "comments.submit") — that's a pre-v0.5.11 ProposeCard limitation,
    // not a v0.5.13 regression. The Approve button still works because
    // proposalId + queueUrl extract correctly.
    expect(result?.summary).toMatch(/^rate-limit /);
  });

  it("returns null for pre-v0.5.11 non-canonical 'Queued layout-create proposal' format", () => {
    const content = `Queued layout-create proposal ${UUID} (slug=default, 3 blocks). An Owner must click Approve at /security/layouts/pending to create the layout.`;
    expect(parseProposalContent(content)).toBeNull();
  });

  it("returns null for tool-error content", () => {
    expect(parseProposalContent("layouts.propose_create failed: slug already in use")).toBeNull();
  });

  it("returns null for content without a uuid", () => {
    expect(
      parseProposalContent("Queued proposal not-a-uuid: something. /security/x/pending"),
    ).toBeNull();
  });

  it("returns null for content without a queue url", () => {
    expect(parseProposalContent(`Queued proposal ${UUID}: summary. nothing more.`)).toBeNull();
  });

  it("returns null on empty string", () => {
    expect(parseProposalContent("")).toBeNull();
  });
});
