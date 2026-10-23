// SPDX-License-Identifier: MPL-2.0

/**
 * #1008 — get_plugin says what became of a core problem's bug report, and
 * only claims the Caelo team was told when the report was actually sent.
 * With bug forwarding off (the default) a report stays on this site.
 */

import { describe, expect, it } from "bun:test";
import { formatPluginError } from "../operator-dashboard-tools.js";

const base = {
  phase: "provision",
  errorClass: "core",
  message: "syntax error",
  occurrences: 2,
  lastSeenAt: "2026-10-23T09:00:00.000Z",
};

describe("formatPluginError — bug report wording", () => {
  it("a report kept on this site does not claim the team was told", () => {
    const line = formatPluginError({ ...base, report: "local" });
    expect(line).toContain("recorded on this site, not sent");
    expect(line).not.toContain("sent to the Caelo team");
  });

  it("only a sent report says the Caelo team has it", () => {
    expect(formatPluginError({ ...base, report: "sent" })).toContain("sent to the Caelo team");
    expect(formatPluginError({ ...base, report: "queued" })).toContain("about to be sent");
    expect(formatPluginError({ ...base, report: "failed" })).toContain(
      "sending it to the Caelo team failed",
    );
  });

  it("no report adds nothing", () => {
    expect(formatPluginError({ ...base, report: "none" })).toBe(
      "[provision, core] 2x, last 2026-10-23T09:00:00.000Z: syntax error",
    );
  });
});
