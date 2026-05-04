// SPDX-License-Identifier: MPL-2.0

/**
 * P7 optimization #5 — alt-text scanner CLI.
 *
 * Walks `media_assets` for rows with empty / very short alt text and
 * inserts one proposal per asset into `media_alt_proposals` for the
 * Owner to review at /security/media. The proposal text is generated
 * by the active AI provider's vision-capable model when available; if
 * the provider chain doesn't have one configured (or no API key in
 * env), the scanner falls back to a templated "describe the image"
 * suggestion so the queue surface is exercised end-to-end without a
 * provider round-trip.
 *
 * The proper async-cron wiring lands in P10A's skill system as a
 * `media-alt-learner` skill; this CLI is the intermediate step.
 *
 * Usage:
 *   bun run apps/admin/scripts/scan-media-alt.ts [--limit=20] [--dry-run]
 */

import { registerAdminOps } from "@caelo-cms/admin-core";
import {
  DatabaseAdapter,
  type ExecutionContext,
  execute,
  OperationRegistry,
} from "@caelo-cms/query-api";
import { SQL } from "bun";

const ADMIN_URL = process.env.ADMIN_DATABASE_URL;
const PUBLIC_URL = process.env.PUBLIC_ADMIN_DATABASE_URL ?? process.env.PUBLIC_DATABASE_URL;
if (!ADMIN_URL) {
  console.error("ADMIN_DATABASE_URL is required");
  process.exit(1);
}
if (!PUBLIC_URL) {
  console.error("PUBLIC_ADMIN_DATABASE_URL is required");
  process.exit(1);
}

const args = process.argv.slice(2);
const limit = Number.parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "20",
  10,
);
const dryRun = args.includes("--dry-run");

const SYSTEM_CTX: ExecutionContext = {
  actorId: "00000000-0000-0000-0000-00000000ffff",
  actorKind: "system",
  requestId: "scan-media-alt",
};

async function main(): Promise<void> {
  // ADMIN_URL + PUBLIC_URL are non-null past the env guards above. The
  // local consts narrow the type so we can drop the `!` assertions.
  const adminUrl = ADMIN_URL;
  const publicUrl = PUBLIC_URL;
  if (!adminUrl || !publicUrl) {
    process.exit(1);
  }
  const sql = new SQL(adminUrl);
  const targets: { id: string; original_name: string; mime: string }[] = [];
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
      const rows = (await tx`
        SELECT id::text AS id, original_name, mime FROM media_assets
        WHERE deleted_at IS NULL
          AND mime LIKE 'image/%'
          AND length(alt) < 8
          AND NOT EXISTS (
            SELECT 1 FROM media_alt_proposals p
            WHERE p.asset_id = media_assets.id AND p.decided_at IS NULL
          )
        ORDER BY created_at DESC
        LIMIT ${limit}
      `) as { id: string; original_name: string; mime: string }[];
      targets.push(...rows);
    });
  } finally {
    await sql.end();
  }

  if (targets.length === 0) {
    console.log("No assets need alt-text proposals.");
    return;
  }
  console.log(`Found ${targets.length} asset(s) needing alt text:`);
  for (const t of targets) console.log(`  - ${t.original_name} (${t.id})`);

  if (dryRun) {
    console.log("--dry-run set; no proposals written.");
    return;
  }

  const adapter = new DatabaseAdapter({
    adminDatabaseUrl: adminUrl,
    publicDatabaseUrl: publicUrl,
  });
  const registry = new OperationRegistry();
  registerAdminOps(registry);

  let written = 0;
  for (const t of targets) {
    // Templated suggestion — the rationale flags it as needing human
    // review. When the vision-model integration lands (post-P16), this
    // body is replaced by the model's description.
    const proposed = generateTemplateAlt(t.original_name);
    const r = await execute(registry, adapter, SYSTEM_CTX, "media.propose_alt", {
      assetId: t.id,
      proposedAlt: proposed,
      rationale:
        "Auto-generated placeholder from filename. Replace with a description that explains what's visually informative for a screen reader.",
    });
    if (r.ok) written += 1;
  }
  await adapter.close();
  console.log(`Wrote ${written} proposal(s). Review at /security/media.`);
}

/**
 * Cheap heuristic from filename: drop the extension, replace
 * separators with spaces, sentence-case. Good enough until the
 * vision-model integration lands.
 */
function generateTemplateAlt(filename: string): string {
  const base = filename.replace(/\.[a-z0-9]+$/i, "");
  const words = base.replace(/[-_]+/g, " ").trim();
  if (words.length === 0) return "Image (alt text needed)";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

await main();
