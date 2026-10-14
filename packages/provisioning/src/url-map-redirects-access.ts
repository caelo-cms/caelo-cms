// SPDX-License-Identifier: MPL-2.0

/**
 * The admin's URL-map redirects role (#587) on `gcp` installs. The installer
 * (wizards/gcp.ts) and `cms-provision upgrade` both call
 * {@link ensureUrlMapRedirectsAccess}, so new and older installs get the same
 * custom role + binding. The stack does not declare it: a role id exists once
 * per project, so a stack-created role would collide with one upgrade made.
 *
 *   1. project custom role {@link urlMapRedirectsRoleId} with exactly
 *      {@link URL_MAP_REDIRECTS_PERMISSIONS} (created, or updated to that
 *      permission set; undeleted first if it was soft-deleted)
 *   2. that role for the admin's run SA on the project
 *
 * Both steps are idempotent. Without them Confirm-publish fails with a 403
 * when it writes the redirects into the URL map.
 */

import { gcloud as defaultGcloud } from "./gcloud.js";
import { type GcloudRunner, realSleep, runWithRetry, type Sleep } from "./gcloud-retry.js";
import {
  runServiceAccountEmail,
  URL_MAP_REDIRECTS_PERMISSIONS,
  urlMapRedirectsRoleId,
} from "./gcp-names.js";

/** Ensure the custom role and the admin's binding; never throws for gcloud. */
export async function ensureUrlMapRedirectsAccess(opts: {
  readonly projectId: string;
  readonly env: string;
  readonly run?: GcloudRunner;
  readonly sleep?: Sleep;
}): Promise<{ ok: true; role: string } | { ok: false; error: string }> {
  const run = opts.run ?? defaultGcloud;
  const sleep = opts.sleep ?? realSleep;
  const project = `--project=${opts.projectId}`;
  const roleId = urlMapRedirectsRoleId(opts.env);
  const role = `projects/${opts.projectId}/roles/${roleId}`;
  const permissions = `--permissions=${URL_MAP_REDIRECTS_PERMISSIONS.join(",")}`;

  const describe = await run(["iam", "roles", "describe", roleId, project, "--format=json"]);
  if (describe.ok) {
    const live = JSON.parse(describe.stdout) as { deleted?: boolean };
    if (live.deleted) {
      const undelete = await run(["iam", "roles", "undelete", roleId, project, "--quiet"]);
      if (!undelete.ok) return { ok: false, error: `undelete ${role}: ${undelete.stderr.trim()}` };
    }
    const update = await run([
      "iam",
      "roles",
      "update",
      roleId,
      project,
      permissions,
      "--quiet",
      "--format=none",
    ]);
    if (!update.ok) return { ok: false, error: `update ${role}: ${update.stderr.trim()}` };
  } else {
    const create = await run([
      "iam",
      "roles",
      "create",
      roleId,
      project,
      "--title=Caelo admin: URL-map redirects",
      "--description=Lets the Caelo admin write the redirects table into the site's URL map (#587).",
      permissions,
      "--stage=GA",
      "--quiet",
      "--format=none",
    ]);
    if (!create.ok) return { ok: false, error: `create ${role}: ${create.stderr.trim()}` };
  }

  // A just-created role takes a few seconds to become bindable.
  const bind = await runWithRetry(run, sleep, [
    "projects",
    "add-iam-policy-binding",
    opts.projectId,
    `--member=serviceAccount:${runServiceAccountEmail(opts.projectId, opts.env)}`,
    `--role=${role}`,
    "--condition=None",
    "--quiet",
    "--format=none",
  ]);
  if (!bind.ok) return { ok: false, error: `grant ${role}: ${bind.stderr.trim()}` };
  return { ok: true, role };
}
