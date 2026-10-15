// SPDX-License-Identifier: MPL-2.0

/**
 * #678 — `staging-domain enable` tells the admin itself what the operator
 * decided, instead of printing "now set the same host in the admin".
 * It calls `POST /api/internal/staging/provision` through admin-internal.ts
 * (IAP as caelo-mcp + the internal token, scope `staging.provision`), because
 * the answer carries the generated basic-auth password back to the CLI, which
 * prints it once and never stores it.
 */

import {
  type AdminInternalDeps,
  type AdminInternalResult,
  type AdminInternalTarget,
  callAdminInternal,
} from "./admin-internal.js";

/** Token scope the admin endpoint checks (apps/admin …/api/internal/staging/provision). */
export const STAGING_PROVISION_SCOPE = "staging.provision";
const ENDPOINT = "/api/internal/staging/provision";

export type StagingAdminTarget = AdminInternalTarget;
export type StagingAdminDeps = AdminInternalDeps;

/** Main's draft pages, as the admin reports them. */
export interface DraftPages {
  readonly count: number;
  readonly pages: readonly { title: string; path: string }[];
}

/** `{"mode":"inspect"}` — the admin's stored host and gate state. */
export interface StagingInspect {
  readonly stagingHost: string | null;
  readonly stageNeeded: "nothing-staged" | "host-changed" | null;
  readonly stageNote: string | null;
  readonly settings: { readonly basicAuthEnabled: boolean; readonly basicAuthGenerated: boolean };
}

/** `{"mode":"apply"}` — what `staging_access.provision` did. */
export interface StagingApply {
  readonly host: string;
  readonly previousHost: string | null;
  readonly hostChanged: boolean;
  readonly stagingUrl: string;
  readonly basicAuth: {
    readonly status: "generated" | "rotated" | "unchanged-enabled" | "unchanged-disabled";
    readonly enabled: boolean;
    readonly user: string;
    readonly password: string | null;
  };
  readonly stageNeeded: "nothing-staged" | "host-changed" | null;
  readonly stageNote: string | null;
  readonly draftPages: DraftPages;
}

export type StagingAdminResult<T> = AdminInternalResult<T>;

export interface ApplyRequest {
  readonly host?: string;
  readonly rotateBasicAuth?: boolean;
  readonly revealBasicAuth?: boolean;
}

/** Read the admin's stored staging host (the truth `staging-domain enable` maps). */
export function inspectStagingAdmin(
  target: StagingAdminTarget,
  deps: StagingAdminDeps = {},
): Promise<StagingAdminResult<StagingInspect>> {
  return callStagingAdmin<StagingInspect>(target, { mode: "inspect" }, deps);
}

/** Set the host / ensure password protection (see the admin op `staging_access.provision`). */
export function applyStagingAdmin(
  target: StagingAdminTarget,
  request: ApplyRequest,
  deps: StagingAdminDeps = {},
): Promise<StagingAdminResult<StagingApply>> {
  return callStagingAdmin<StagingApply>(target, { mode: "apply", ...request }, deps);
}

async function callStagingAdmin<T>(
  target: StagingAdminTarget,
  body: Record<string, unknown>,
  deps: StagingAdminDeps,
): Promise<StagingAdminResult<T>> {
  const r = await callAdminInternal<T>(
    target,
    { endpoint: ENDPOINT, scope: STAGING_PROVISION_SCOPE, body, introducedBy: "#678" },
    deps,
  );
  return r.ok ? { ok: true, value: r.value.answer } : r;
}

/**
 * The lines `staging-domain enable` prints for an apply result: host,
 * credentials (once), what is served and the next step. Pure — the CLI
 * prints them and never persists the password.
 */
export function describeStagingApply(r: StagingApply): string[] {
  const lines: string[] = [];
  lines.push(
    r.hostChanged
      ? `The admin now uses ${r.host} as the staging host (was ${r.previousHost ?? "unset"}); every Stage renders it.`
      : `The admin's staging host is ${r.host}.`,
  );
  const b = r.basicAuth;
  if (b.password !== null && (b.status === "generated" || b.status === "rotated")) {
    lines.push(
      "",
      b.status === "generated"
        ? "Password protection is on (basic auth). Credentials — shown only now, not saved anywhere:"
        : "New basic-auth password — shown only now, not saved anywhere (the old one no longer works):",
      `  user:     ${b.user}`,
      `  password: ${b.password}`,
      "Give them to reviewers / crawlers. Change the user, rotate the password or add other access",
      "modes in the admin: Settings → Staging access (or rerun with --rotate-staging-password).",
    );
  } else if (b.password !== null) {
    lines.push(
      "",
      `Basic auth is ${b.enabled ? "on" : "OFF (switched off in the admin)"}. Current credentials — not saved anywhere:`,
      `  user:     ${b.user}`,
      `  password: ${b.password}`,
    );
  } else if (b.status === "unchanged-enabled") {
    lines.push(
      "",
      `Password protection is on (basic auth, user ${b.user}). Show the password with --show-staging-password, or in the admin under Settings → Staging access.`,
    );
  } else {
    lines.push(
      "",
      "Basic auth was switched off in the admin; it stays off (admins still get in through Open staging). Turn it on under Settings → Staging access.",
    );
  }
  if (r.stageNote) lines.push("", r.stageNote);
  if (r.draftPages.count > 0) {
    const listed = r.draftPages.pages.map((p) => `${p.title} (${p.path})`).join(", ");
    const more =
      r.draftPages.count > r.draftPages.pages.length
        ? ` and ${r.draftPages.count - r.draftPages.pages.length} more`
        : "";
    lines.push(
      "",
      `${r.draftPages.count} page(s) are draft and will NOT be on staging: ${listed}${more}.`,
      "Set them to published (editor status toggle, or ask the AI), then Stage.",
    );
  }
  return lines;
}

/**
 * The command to re-run after `<kind>-domain enable` stopped before the
 * admin was updated (domain verification, an admin error). An explicitly
 * requested staging host is part of it: without it the retry would map the
 * admin's previous host instead (codex review on #681).
 */
export function domainEnableRetryCommand(command: string, requestedHost: string | null): string {
  return `cms-provision ${command} enable${requestedHost ? ` --staging-domain ${requestedHost}` : ""}`;
}
