// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #696 Phase 2 — the AI's read of in-product Caelo updates: recent
 * install attempts, one attempt's timeline, and the automatic-update
 * policy. Read-only by design (CLAUDE.md §2; #696 maintainer decision 3):
 * the Owner installs updates and changes the policy at Settings → Updates,
 * each time confirmed with a fresh Google sign-in the AI cannot give. The
 * formatted results say so, so the AI points there instead of trying.
 */

import type { PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { z } from "zod";
import type {
  PlatformUpdateEvent,
  PlatformUpdateRequest,
} from "../../ops/platform-update-requests.js";
import { UPDATES_PATH } from "../../ops/platform-updates.js";
import { makeReadTool } from "./_make-read-tool.js";

const OWNER_ONLY = `Only the Owner can install updates or change this, at ${UPDATES_PATH} (Settings → Updates), confirmed with a fresh Google sign-in. You cannot: tell the operator and link the page.`;

const STATUS_WORDS: Record<PlatformUpdateRequest["status"], string> = {
  pending: "waiting for the upgrader to start",
  running: "being installed now",
  succeeded: "installed",
  rolled_back: "rolled back (the new release was unhealthy; the previous one serves again)",
  failed: "failed",
  refused: "refused",
  needs_cloud_shell:
    "needs the Owner to run the upgrade by hand once (Cloud Shell on Google Cloud, the upgrade command on a self-hosted server)",
  cancelled: "cancelled",
};

/** One request as a line the AI can pass on. */
export function formatUpdateRequest(r: PlatformUpdateRequest): string {
  const who =
    r.trigger === "auto" ? "automatic" : `requested by ${r.requestedBy ?? "a former user"}`;
  const reason = r.statusReason ? ` — ${r.statusReason}` : "";
  return `${r.requestedAt.slice(0, 16).replace("T", " ")} UTC: ${r.fromVersion} → ${r.targetVersion} (${who}): ${STATUS_WORDS[r.status]}${reason} [id ${r.id}]`;
}

export const listCaeloUpdatesTool = makeReadTool<{ limit?: number }>({
  name: "list_caelo_updates",
  description:
    "History of Caelo update installs on this site (newest first): which version, who asked, and how it ended (installed, rolled back, failed, refused, or waiting for Cloud Shell). " +
    "Use when the operator asks whether an update went through, why one failed, or what changed recently. For which version runs now and whether a newer one exists, use get_caelo_version. Read-only.",
  opName: "platform_updates.list",
  input: z.object({ limit: z.number().int().min(1).max(50).optional() }).strict(),
  format: (value) => {
    const { requests } = value as { requests: PlatformUpdateRequest[] };
    if (requests.length === 0) {
      return `No update has been installed from the admin yet. ${OWNER_ONLY}`;
    }
    return [...requests.map(formatUpdateRequest), OWNER_ONLY].join("\n");
  },
});

export const getCaeloUpdateTool = makeReadTool<{ requestId?: string }>({
  name: "get_caelo_update",
  description:
    "The step-by-step timeline of one Caelo update install (signature check, backup, migrations, roll, health check, rollback) — the most recent one when requestId is omitted. " +
    "Use to explain what happened during an update or why it stopped; ids come from list_caelo_updates. Read-only.",
  opName: "platform_updates.get",
  input: z.object({ requestId: z.string().uuid().optional() }).strict(),
  format: (value) => {
    const { request, events } = value as {
      request: PlatformUpdateRequest | null;
      events: PlatformUpdateEvent[];
    };
    if (!request) return `No update has been installed from the admin yet. ${OWNER_ONLY}`;
    const lines = events.map(
      (e) =>
        `${e.at.slice(11, 19)} [${e.phase}] ${e.level === "info" ? "" : `${e.level}: `}${e.message}`,
    );
    return [formatUpdateRequest(request), ...lines, OWNER_ONLY].join("\n");
  },
  includeValue: false,
});

export const getCaeloUpdatePolicyTool = makeReadTool<Record<string, never>>({
  name: "get_caelo_update_policy",
  description:
    "Whether Caelo updates install automatically on this site and which kinds (security fixes, patch, minor; never major), the maintenance window and soak period, and whether automatic installs are paused after a failure. Read-only.",
  opName: "platform_update_policy.get",
  input: z.object({}).strict(),
  format: (value) => {
    const p = value as {
      mode: string;
      autoSecurity: boolean;
      autoPatch: boolean;
      autoMinor: boolean;
      windowStart: string | null;
      windowEnd: string | null;
      windowTimezone: string;
      soakHours: number;
      paused: boolean;
      pausedReason: string | null;
    };
    const kinds = [
      p.autoSecurity && "security fixes",
      p.autoPatch && "patch releases",
      p.autoMinor && "minor releases",
    ].filter(Boolean);
    const lines = [
      p.mode === "auto"
        ? `Automatic installs: on for ${kinds.length ? kinds.join(", ") : "nothing yet (no kind switched on)"}; major releases never.`
        : p.mode === "notify"
          ? "Automatic installs: off — the Owner is notified and installs by hand."
          : "Automatic installs and update notices: off.",
      p.windowStart
        ? `Maintenance window: ${p.windowStart}–${p.windowEnd} (${p.windowTimezone}).`
        : "Maintenance window: any time.",
      `Soak period: ${p.soakHours} h after a release is published.`,
    ];
    if (p.paused) lines.push(`Paused after a failed automatic install: ${p.pausedReason ?? ""}`);
    lines.push(OWNER_ONLY);
    return lines.join("\n");
  },
});

/** The self-hosted update agent's last check-in, for the AI (#696 Phase 4c). */
export function formatUpdateAgent(agent: PlatformUpdateAgentStatus | null): string {
  if (agent === null) {
    return `No update agent has checked in. On a self-hosted install that means updates cannot be installed from ${UPDATES_PATH} yet: the Owner sets the agent up on the server (the page shows the command). Google Cloud installs use their own upgrader instead and need no agent.`;
  }
  const state = !agent.checkedInRecently
    ? `last checked in ${agent.lastSeenAt} and is not running now`
    : agent.problem
      ? `is running but cannot install updates: ${agent.problem}`
      : "is running and ready to install updates the Owner starts";
  return `The update agent on ${agent.host} (Caelo ${agent.agentVersion}) ${state}. ${OWNER_ONLY}`;
}

export const getCaeloUpdateAgentTool = makeReadTool<Record<string, never>>({
  name: "get_caelo_update_agent",
  description:
    "Self-hosted installs only: whether the update agent on the server is running, so the Owner can install Caelo updates from Settings → Updates — or what is wrong on the server (agent not set up, not running, cosign or Docker missing). " +
    "Use when the operator asks why Install update is missing or why an update did not start on a self-hosted site. Read-only.",
  opName: "platform_updates.agent_status",
  input: z.object({}).strict(),
  format: (value) =>
    formatUpdateAgent((value as { agent: PlatformUpdateAgentStatus | null }).agent),
  includeValue: false,
});
