// SPDX-License-Identifier: MPL-2.0

/**
 * The public face of a cluster: its GitHub issue title, labels and body.
 *
 * The repository is public and the text came from an AI on someone else's
 * install, so it is treated as untrusted: redacted again here, and the free
 * text is rendered inside code fences, where GitHub turns no @mention, #ref
 * or link into a notification or a cross-reference. Raw evidence is never
 * rendered; it stays in the intake's private Firestore database.
 *
 * Defects and suggestions (#1192) look different on purpose, so maintainers
 * can triage them apart: a defect is `[ai-detected]` + `ai-detected` +
 * `severity:<s>`; a suggestion is `[ai-suggested]` + `ai-suggested` and no
 * severity label (a suggestion has no severity).
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

/** Title prefix and label of each kind; the labels must exist in the target repository. */
const KIND_TAG = { defect: "ai-detected", suggestion: "ai-suggested" } as const;

export function issueTitle(c: ClusterRecord): string {
  const t = redactBugText(c.title).replace(/\s+/g, " ").trim();
  return `[${KIND_TAG[c.kind]}] ${t}`.slice(0, 200);
}

export function issueLabels(c: ClusterRecord): string[] {
  if (c.kind === "suggestion") return [KIND_TAG.suggestion];
  if (c.severity === null) {
    throw new Error(`defect cluster ${c.id} has no severity; the report contract requires one`);
  }
  return [KIND_TAG.defect, `severity:${c.severity}`];
}

function filedBy(c: ClusterRecord): string {
  if (c.kind === "suggestion") return "the AI, via `bug_report` (a suggestion, not a defect)";
  return c.source === "auto"
    ? "Caelo (failed tool call, captured automatically)"
    : "the AI, via `bug_report`";
}

export function issueBody(c: ClusterRecord): string {
  const suggestion = c.kind === "suggestion";
  const rows: Array<[string, string]> = [
    ["Filed by", filedBy(c)],
    ["Suspected tool", c.suspectedTool ? `\`${c.suspectedTool.replace(/`/g, "")}\`` : "—"],
    suggestion
      ? ["Blocked the task", c.blockedTask ? "yes" : "no"]
      : ["Severity", `${c.severity}${c.blockedTask ? " (blocked the task)" : ""}`],
    ["Installs reporting it", String(c.installHashes.length)],
    ["Reports", String(c.occurrences)],
    ["Caelo versions", c.versions.map((v) => `\`${v}\``).join(", ")],
    ["First / last seen", `${c.firstSeen.slice(0, 10)} / ${c.lastSeen.slice(0, 10)}`],
  ];
  const intro = suggestion
    ? "Suggested automatically by Caelo installs whose Owner chose to send detected bugs to the Caelo team. Nothing misbehaved: the AI working on the site needed something Caelo does not have (a capability, a tool or documentation). The text was written by that AI and redacted on the install."
    : "Reported automatically by Caelo installs whose Owner chose to send detected bugs to the Caelo team. The text was written by the AI that hit the bug and redacted on the install.";
  const closing = suggestion
    ? `Evidence from each report is kept private to maintainers (cluster \`${c.id}\` in the bug intake's private store). If the idea is rejected, close this issue as **not planned**; installs then show it as won't be done. Close it as completed when it ships; installs learn about it from the next release.`
    : `Evidence from each report is kept private to maintainers (cluster \`${c.id}\` in the bug intake's private store). Close this issue as completed when the fix is merged; installs learn about it from the next release.`;
  return [
    clusterMarker(c.id),
    intro,
    "",
    "| | |",
    "|---|---|",
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    suggestion ? "### What was missing" : "### What happened",
    fence(redactBugText(c.whatHappened)),
    "",
    suggestion ? "### What would have helped" : "### Expected",
    fence(redactBugText(c.expected)),
    "",
    closing,
  ].join("\n");
}

/** Install counts that earn a comment, so watchers hear when a bug spreads. */
export const INSTALL_MILESTONES = [10, 100, 1000, 10000] as const;
