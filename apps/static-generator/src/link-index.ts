// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — the link index a deploy build resolves internal references
 * (`caelo:page/<id>`, `caelo:media/<id>`) against.
 *
 * Main-line only, like every other build query: a chat's branch never
 * ships. Drafts are loaded too — not to render them, but so a link to a
 * draft resolves as `unpublished` (the page exists, this build does not
 * ship it: warning at Stage, blocking at Publish live) instead of
 * `missing` (no such page: the render gate refuses the build).
 *
 * The generator runs outside admin-core (subprocess), so it reads the two
 * tables itself; admin-core's `links/link-targets.ts` is the branch-aware
 * twin for the editor preview. Both feed the same shared
 * `createSiteLinkIndex`, which is what keeps preview and build URLs equal.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  createSiteLinkIndex,
  type LinkIndexMedia,
  type LinkIndexPage,
  type LinkRenderEnv,
  type PageUrlStyle,
  type SiteLinkIndex,
} from "@caelo-cms/shared";
import { sql } from "drizzle-orm";

/**
 * The render env of a deploy target. `dev` builds every page regardless
 * of status (a debugging surface), so links to drafts are not issues
 * there — the same semantics as the editor preview.
 */
export function linkEnvOfTarget(env: "dev" | "staging" | "production"): LinkRenderEnv {
  return env === "dev" ? "preview" : env;
}

/** Load the main-line link index for one build. */
export async function loadBuildLinkIndex(
  tx: TransactionRunner,
  targetEnv: "dev" | "staging" | "production",
  pageUrlStyle: PageUrlStyle,
): Promise<SiteLinkIndex> {
  const pages = (await tx.execute(sql`
    SELECT id::text AS id, current_path AS path, status
    FROM pages
    WHERE deleted_at IS NULL AND chat_branch_id IS NULL
  `)) as unknown as LinkIndexPage[];
  const media = (await tx.execute(sql`
    SELECT id::text AS id, slug FROM media_assets WHERE deleted_at IS NULL
  `)) as unknown as LinkIndexMedia[];
  return createSiteLinkIndex({ pages, media, env: linkEnvOfTarget(targetEnv), pageUrlStyle });
}
