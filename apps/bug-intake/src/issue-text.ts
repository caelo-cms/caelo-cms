// SPDX-License-Identifier: MPL-2.0

/**
 * The public face of a cluster: its GitHub issue title and body.
 *
 * The repository is public and the text came from an AI on someone else's
 * install, so it is treated as untrusted: redacted again here, and the free
 * text is rendered inside code fences, where GitHub turns no @mention, #ref
 * or link into a notification or a cross-reference. Raw evidence is never
 * rendered; it stays in the intake's private Firestore database.
 */

import { redactBugText } from "@caelo-cms/shared";
import type { ClusterRecord } from "./store.js";

/** Marker GitHub keeps invisible; lets a maintainer or script map an issue to its cluster. */
export function clusterMarker(id: string): string {
  return `<!-- caelo-bug-intake:cluster=${id} -->`;
}

function fence(text: string): string {
  const longestRun = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(Math.max(3, longestRun + 1));
  return `${f}text\n${text}\n${f}`;
}

export function issueTitle(c: ClusterRecord): string {
  const t = redactBugText(c.title).replace(/\s+/g, " ").trim();
  return `[ai-detected] ${t}`.slice(0, 200);
}

export function issueLabels(c: ClusterRecord): string[] {
  return ["ai-detected", `severity:${c.severity}`];
}

export function issueBody(c: ClusterRecord): string {
  const rows: Array<[string, string]> = [
    [
      "Filed by",
      c.source === "auto"
        ? "Caelo (failed tool call, captured automatically)"
        : "the AI, via `bug_report`",
    ],
    ["Suspected tool", c.suspectedTool ? `\`${c.suspectedTool.replace(/`/g, "")}\`` : "—"],
    ["Severity", `${c.severity}${c.blockedTask ? " (blocked the task)" : ""}`],
    ["Installs reporting it", String(c.installHashes.length)],
    ["Reports", String(c.occurrences)],
    ["Caelo versions", c.versions.map((v) => `\`${v}\``).join(", ")],
    ["First / last seen", `${c.firstSeen.slice(0, 10)} / ${c.lastSeen.slice(0, 10)}`],
  ];
  return [
    clusterMarker(c.id),
    "Reported automatically by Caelo installs whose Owner chose to send detected bugs to the Caelo team. The text was written by the AI that hit the bug and redacted on the install.",
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "### What happened",
    fence(redactBugText(c.whatHappened)),
    "",
    "### Expected",
    fence(redactBugText(c.expected)),
    "",
    `Evidence from each report is kept private to maintainers (cluster \`${c.id}\` in the bug intake's private store). Close this issue as completed when the fix is merged; installs learn about it from the next release.`,
  ].join("\n");
}

/** Install counts that earn a comment, so watchers hear when a bug spreads. */
export const INSTALL_MILESTONES = [10, 100, 1000, 10000] as const;
