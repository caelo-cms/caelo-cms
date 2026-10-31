// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from "bun:test";
import { unsentReportsSummary } from "./bug-forwarding-summary.js";
describe("unsentReportsSummary", () => {
    it("asks for an export only for reports that did not reach the Caelo team", () => {
        expect(unsentReportsSummary(["local_only"])).toBe("1 report has not reached the Caelo team. Export the list and send it to us, or paste it into a GitHub issue.");
        expect(unsentReportsSummary(["local_only", "failed", "sent", "queued"])).toStartWith("2 reports have not reached the Caelo team.");
    });
    // Regression (Codex on #907): the summary claimed the Caelo team only sees
    // reports the operator sends by hand, contradicting Queued / Sent rows.
    it("says nothing about manual sending when every report is sent or queued", () => {
        expect(unsentReportsSummary(["sent", "queued"])).toBeNull();
        expect(unsentReportsSummary([])).toBeNull();
    });
});
