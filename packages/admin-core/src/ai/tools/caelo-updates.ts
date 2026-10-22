// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #696 Phase 2 + 5 — the AI's read of in-product Caelo updates:
 * recent install attempts, one attempt's timeline, the automatic-update
 * policy, and what the auto-update scheduler last decided. Read-only by design (CLAUDE.md §2; #696 maintainer decision 3):
 * the Owner installs updates and changes the policy at Settings → Updates,
 * each time confirmed with the Owner's password, which the AI cannot give. The
 * formatted results say so, so the AI points there instead of trying.
 */

import type { PlatformUpdateAgentStatus } from "@caelo-cms/shared";
import { z } from "zod";
import type {
  PlatformUpdateEvent,
  PlatformUpdateRequest,
} from "../../ops/platform-update-requests.js";
import type { SchedulerStatus } from "../../ops/platform-update-scheduler.js";
import { UPDATES_PATH } from "../../ops/platform-updates.js";
import { makeReadTool } from "./_make-read-tool.js";

const OWNER_ONLY = `Only the Owner can install updates or change this, at ${UPDATES_PATH} (Settings → Updates), confirmed with the Owner's password. You cannot: tell the operator and link the page.`;

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
  superseded:
    "no longer needed (the install has moved past it: it runs this release or a newer one, or a newer update was requested)",
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
    "Whether Caelo updates install automatically on this site or the Owner is only notified (new releases, security fixes included, are always announced), and which kinds (security fixes, patch, minor; never major), the maintenance window, the soak periods, and whether automatic installs are paused (by the Owner, or after a failure). " +
    "For what the scheduler last decided about the newest release and which update emails went out, use get_caelo_auto_update_status. Read-only.",
  opName: "platform_update_policy.get",
  input: z.object({}).strict(),
  format: (value) => {
    const p = value as {
      mode: string;
      autoSecurity: boolean;
      autoPatch: boolean;
      autoMinor: boolean;
      autoConverge: boolean;
      windowStart: string | null;
      windowEnd: string | null;
      windowTimezone: string;
      soakHours: number;
      securitySoakHours: number;
      paused: boolean;
      pausedReason: string | null;
      pausedUntil: string | null;
      pausedByOwner: boolean;
    };
    const kinds = [
      p.autoSecurity && "security fixes",
      p.autoPatch && "patch releases",
      p.autoMinor && "minor releases",
    ].filter(Boolean);
    const lines = [
      p.mode === "auto"
        ? `Automatic installs: on for ${kinds.length ? kinds.join(", ") : "nothing yet (no kind switched on)"}; major releases never; releases that destroy database data never; releases that change the cloud setup only when the Owner also allowed those (otherwise the Owner is emailed instead).`
        : "Automatic installs: off — the Owner is notified and installs by hand.",
      ...(p.mode === "auto" && p.autoConverge
        ? [
            "The Owner also allowed releases that change the Google Cloud project to install automatically: Caelo's converge job runs them under the same kinds, soak and window. An install without a converge job still announces them for the Owner to run from a terminal.",
          ]
        : []),
      p.windowStart
        ? `Maintenance window: ${p.windowStart}–${p.windowEnd} (${p.windowTimezone}).`
        : "Maintenance window: any time.",
      `Soak period: ${p.soakHours} h after a release is published (security fixes with a published advisory: ${p.securitySoakHours} h).`,
    ];
    if (p.paused) {
      lines.push(
        `Paused ${p.pausedByOwner ? "by the Owner" : "after a failed automatic install"}${p.pausedUntil ? ` until ${p.pausedUntil}` : " until the Owner resumes"}${p.pausedReason ? `: ${p.pausedReason}` : ""}`,
      );
    }
    lines.push(OWNER_ONLY);
    return lines.join("\n");
  },
});

const ACTION_WORDS: Record<NonNullable<SchedulerStatus["lastAction"]>, string> = {
  none: "nothing to do",
  notify: "the Owner installs it by hand",
  wait: "waiting",
  install: "queued an automatic install",
  manual:
    "the Owner installs it from Settings → Updates (it makes destructive database changes, or it changes the cloud setup and the policy does not install those automatically)",
  needs_cloud_shell: "needs the Owner to run it in Cloud Shell (it changes the cloud setup)",
  blocked: "cannot install automatically",
};

export const getCaeloAutoUpdateStatusTool = makeReadTool<Record<string, never>>({
  name: "get_caelo_auto_update_status",
  description:
    "What Caelo's automatic-update scheduler last decided about the newest release (installing, waiting for the soak period or maintenance window, paused, or why it will not install it on its own) and the update emails sent to the Owner, with whether each was delivered. " +
    "Use when the operator asks whether or when an update will install by itself, or why they did (not) get an update email. For the policy itself use get_caelo_update_policy. Read-only.",
  opName: "platform_updates.scheduler_status",
  input: z.object({}).strict(),
  format: (value) => {
    const s = value as SchedulerStatus;
    const lines: string[] = [];
    if (s.lastRunAt === null) {
      lines.push("The automatic-update scheduler has not run on this install yet.");
    } else {
      lines.push(
        `Last check ${s.lastRunAt.slice(0, 16).replace("T", " ")} UTC${s.lastVersion ? ` about v${s.lastVersion}` : ""}: ${s.lastAction ? ACTION_WORDS[s.lastAction] : "no decision"}${s.lastWaitUntil ? ` (until about ${s.lastWaitUntil.slice(0, 16).replace("T", " ")} UTC)` : ""}.`,
      );
      if (s.lastReason) lines.push(s.lastReason);
    }
    if (s.skippedVersion !== null && s.skippedVersion !== s.lastVersion) {
      lines.push(
        `The Owner skipped the automatic install of v${s.skippedVersion}; it does not install on its own.`,
      );
    }
    if (s.notifications.length === 0) {
      lines.push("No update emails yet.");
    } else {
      lines.push("Update emails (newest first):");
      for (const n of s.notifications) {
        lines.push(
          `- ${n.createdAt.slice(0, 16).replace("T", " ")} UTC "${n.subject}": ${n.deliveryStatus.replace("_", " ")}${n.deliveryDetail ? ` (${n.deliveryDetail})` : ""}`,
        );
      }
    }
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
