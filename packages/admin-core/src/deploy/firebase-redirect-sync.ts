// SPDX-License-Identifier: MPL-2.0

/**
 * #1157 — the redirects table on Firebase Hosting, put live on save.
 *
 * Hosting keeps redirect rules in a version's `config.redirects`, and a
 * version is immutable. So a sync creates a NEW version that reuses the
 * served version's files by hash (populateFiles asks for no upload: every
 * hash is already in the site's storage) and copies its config with only the
 * redirects replaced, then releases it on the channel the version was served
 * on — the live channel for production, the served preview channel for
 * staging (#650). Nothing is built and no page changes.
 *
 * The plan is computed against the served version's file list (the live page
 * wins, `buildRedirectPlan`). A version's files never change, so the list is
 * cached per version: a burst of saves (a slug change on the draft adds a
 * redirect every time) lists a large site once.
 *
 * A plan the version already serves creates no release. Rights: the admin's
 * run SA already holds `roles/firebasehosting.admin` (gcp-firebase stack) —
 * the same calls Stage and Publish live make.
 */

import type { RedirectTableRow } from "@caelo-cms/shared";
import type { DeployTarget } from "@caelo-cms/static-generator";
import { firebaseRedirectsFromPlan, sameFirebaseRedirects } from "./firebase-redirects.js";
import { planRedirectSync } from "./redirect-sync-plan.js";
import type { RedirectSyncResult } from "./static-publisher.js";

/** A Firebase Hosting REST call, authorised by the caller. */
export type FirebaseCall = <T>(
  path: string,
  init?: { method?: string; body?: string },
) => Promise<T>;

interface VersionConfig {
  readonly redirects?: readonly unknown[];
  readonly [key: string]: unknown;
}

/** Served file lists by version name (versions are immutable). */
const filesByVersion = new Map<string, ReadonlyMap<string, string>>();
const FILE_LIST_CACHE_SIZE = 4;

/** Test-only — forget cached file lists. */
export function _clearFirebaseFileListCache(): void {
  filesByVersion.clear();
}

async function versionFiles(
  call: FirebaseCall,
  site: string,
  versionName: string,
): Promise<ReadonlyMap<string, string>> {
  const cached = filesByVersion.get(versionName);
  if (cached) return cached;
  const versionId = versionName.split("/").pop() ?? "";
  const files = new Map<string, string>();
  let pageToken: string | undefined;
  do {
    const page = await call<{
      files?: { path: string; hash: string }[];
      nextPageToken?: string;
    }>(
      `sites/${site}/versions/${versionId}/files${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ""}`,
    );
    for (const f of page.files ?? []) files.set(f.path, f.hash);
    pageToken = page.nextPageToken;
  } while (pageToken);
  if (files.size === 0) {
    throw new Error(
      `firebase redirect sync: the served version ${versionName} lists no files, so it cannot be re-released with new redirects. Run Stage and Publish live again.`,
    );
  }
  remember(versionName, files);
  return files;
}

function remember(versionName: string, files: ReadonlyMap<string, string>): void {
  filesByVersion.set(versionName, files);
  while (filesByVersion.size > FILE_LIST_CACHE_SIZE) {
    const oldest = filesByVersion.keys().next().value;
    if (oldest === undefined) break;
    filesByVersion.delete(oldest);
  }
}

/**
 * Put `rows` live on `channelId` (`live`, or a staging preview channel) of
 * `site`, reusing the version that channel serves.
 */
export async function syncFirebaseRedirects(args: {
  readonly call: FirebaseCall;
  readonly site: string;
  readonly channelId: string;
  readonly target: DeployTarget;
  readonly rows: readonly RedirectTableRow[];
}): Promise<RedirectSyncResult> {
  const { call, site, channelId } = args;
  const releases = await call<{ releases?: { version?: { name?: string } }[] }>(
    `sites/${site}/channels/${channelId}/releases?pageSize=1`,
  );
  const servedVersion = releases.releases?.[0]?.version?.name;
  if (!servedVersion) {
    throw new Error(
      `firebase redirect sync: channel ${channelId} of site ${site} serves no version (nothing released, or the site was disabled), so there is nowhere to put the redirects. ${channelId === "live" ? "Publish live" : "Stage"} first; the redirects go out with it.`,
    );
  }
  const servedId = servedVersion.split("/").pop() ?? "";
  const version = await call<{ config?: VersionConfig }>(`sites/${site}/versions/${servedId}`);
  const config: VersionConfig = version.config ?? {};
  const files = await versionFiles(call, site, servedVersion);
  const sync = planRedirectSync(
    args.rows,
    args.target.pageUrlStyle ?? "directory",
    new Set([...files.keys()].map((p) => p.replace(/^\/+/, ""))),
  );
  const redirects = firebaseRedirectsFromPlan(sync.plan);
  const counts = {
    redirectCount: sync.redirectCount,
    goneCount: sync.goneCount,
    shadowedCount: sync.shadowedCount,
    unservedTargets: sync.unservedTargets,
  };
  if (sameFirebaseRedirects(config.redirects, redirects)) {
    return { outcome: "unchanged", ...counts, location: servedVersion };
  }

  const created = await call<{ name: string }>(`sites/${site}/versions`, {
    method: "POST",
    body: JSON.stringify({ config: { ...config, redirects } }),
  });
  const newId = created.name.split("/").pop() ?? "";
  const populate = await call<{ uploadRequiredHashes?: string[] }>(
    `sites/${site}/versions/${newId}:populateFiles`,
    { method: "POST", body: JSON.stringify({ files: Object.fromEntries(files) }) },
  );
  const missing = populate.uploadRequiredHashes ?? [];
  if (missing.length > 0) {
    // The served version's own files must all be in the site's storage; if
    // Hosting asks for bytes this sync never had, finalizing would ship a
    // version with missing files. Nothing was released.
    throw new Error(
      `firebase redirect sync: Hosting asks to re-upload ${missing.length} file(s) of the served version ${servedVersion}, which a redirect sync cannot do. Nothing changed on the site; Stage and Publish live again to put the redirects live.`,
    );
  }
  await call(`sites/${site}/versions/${newId}?updateMask=status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "FINALIZED" }),
  });
  const releasePath =
    channelId === "live"
      ? `sites/${site}/releases?versionName=${created.name}`
      : `sites/${site}/channels/${channelId}/releases?versionName=${created.name}`;
  await call(releasePath, {
    method: "POST",
    body: JSON.stringify({ message: "Caelo: redirects updated (no build)" }),
  });
  // The new version serves exactly the same files.
  remember(created.name, files);
  return { outcome: "applied", ...counts, location: created.name, servedLocation: created.name };
}
