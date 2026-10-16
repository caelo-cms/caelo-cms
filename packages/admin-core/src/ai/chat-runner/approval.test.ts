// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #635 — a gated plugin tool whose approval covers exact text (the
 * body of an email that is sent as approved) shows that text whole on the
 * card. A one-line cut would let the operator approve content they never
 * saw.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { pluginToolsRegistry } from "@caelo-cms/plugin-host";
import newsletterPlugin from "@caelo-cms/plugin-newsletter";
import { buildApprovalPreview, MAX_APPROVAL_PREVIEW_LENGTH } from "./approval.js";
import { fullPreviewArgsForGatedCall } from "./approval-preflight.js";

const body = `<p>${"Spring sale. ".repeat(40)}</p><a href="https://example.com/end">tail</a>`;

describe("buildApprovalPreview full args (#635)", () => {
  afterEach(() => pluginToolsRegistry.unregisterPlugin("newsletter"));

  it("cuts ordinary args to one line", () => {
    const preview = buildApprovalPreview("send_newsletter_campaign", { bodyHtml: body });
    expect(preview).not.toContain("tail</a>");
  });

  it("shows the newsletter's subject and body whole, as declared by the plugin", () => {
    for (const spec of newsletterPlugin.tools ?? []) {
      pluginToolsRegistry.register("newsletter", spec);
    }
    const full = fullPreviewArgsForGatedCall("send_newsletter_campaign");
    expect(full).toEqual(["subject", "bodyHtml"]);
    const preview = buildApprovalPreview(
      "send_newsletter_campaign",
      { campaignId: "c", subject: "Spring news", bodyHtml: body, recipientCount: 3 },
      full,
    );
    expect(preview).toContain(body);
    expect(preview).toContain("Spring news");
    expect(preview).toContain("recipientCount: 3");
  });

  it("has no full args for a tool that did not declare them", () => {
    expect(fullPreviewArgsForGatedCall("propose_update_layout")).toEqual([]);
  });

  it("refuses a preview that would not fit the card instead of cutting it", () => {
    expect(() =>
      buildApprovalPreview(
        "send_newsletter_campaign",
        { bodyHtml: "x".repeat(MAX_APPROVAL_PREVIEW_LENGTH) },
        ["bodyHtml"],
      ),
    ).toThrow("shorten the arguments");
  });
});
