// SPDX-License-Identifier: MPL-2.0

/**
 * v0.4.0 — Content truncate. Wipes every "content + history" table in
 * cms_admin (pages, modules, snapshots, chats, audit events, etc.) so
 * the operator can start authoring fresh against a new schema version
 * WITHOUT destroying the install (users, roles, AI providers, domains,
 * provisioning outputs, site defaults stay intact).
 *
 *   bun run src/truncate.ts admin
 *   bun run src/truncate.ts public
 *
 * Use case: post-schema-change (e.g. v0.4.0's module/content split)
 * when AI-authored pages built against the old shape would render
 * with literal `{{fieldName}}` placeholders. Operator wants a clean
 * slate without `provisioning destroy` + reprovision.
 *
 * The Cloud Run job wrapper (provisioning/migration-runner.ts's
 * `truncateViaCloudRunJob`) runs this against the install's Cloud SQL
 * over the private VPC connector.
 */

import type { SQL as SQLType } from "bun";

type SQL = SQLType;
const SQL = (globalThis as { Bun?: { SQL: new (url: string) => SQLType } }).Bun
  ?.SQL as unknown as new (
  url: string,
) => SQLType;

type Target = "admin" | "public";

const target = process.argv[2] as Target;
if (target !== "admin" && target !== "public") {
  console.error("usage: bun run src/truncate.ts <admin|public>");
  process.exit(1);
}

const url =
  target === "admin" ? process.env.ADMIN_DATABASE_URL : process.env.PUBLIC_ADMIN_DATABASE_URL;
if (!url) {
  console.error(
    `missing env var: ${target === "admin" ? "ADMIN_DATABASE_URL" : "PUBLIC_ADMIN_DATABASE_URL"}`,
  );
  process.exit(1);
}

/**
 * Tables to wipe in cms_admin. Order matters because of FK constraints
 * even with CASCADE — listing snapshot tables + page_modules + content
 * first avoids partial-cascade errors on tables that reference deleted
 * rows.
 *
 * Tables INTENTIONALLY preserved:
 *   - users / sessions / actors / roles  → login + identity
 *   - ai_providers + ai_pricing          → API key + cost defaults
 *   - domains                            → DNS + TLS state
 *   - site_defaults                      → default layout / template IDs
 *   - deploy_targets                     → staging / production targets
 *   - provisioning_outputs               → DNS records the wizard saved
 *   - skills / skill_proposals           → AI behaviour
 *   - bootstrap_tokens (cleared anyway)  → next setup token
 *   - __drizzle_migrations               → migration bookkeeping
 *
 * site_ai_memory IS wiped per operator direction — brand voice can be
 * re-curated on the fresh install.
 */
const ADMIN_TABLES = [
  // Snapshots (referencing content + chats)
  "page_module_content_snapshots",
  "module_snapshots",
  "template_snapshots",
  "page_snapshots",
  "page_layout_snapshots",
  "site_snapshots",
  "chat_branch_publish_marks",

  // Chat data
  "chat_messages",
  "ai_calls",
  "chat_sessions",

  // Content
  "page_module_content",
  "page_modules",
  "pages_seo",
  "pages",
  "template_blocks",
  "templates",
  "layout_modules",
  "layouts",
  "modules",
  "structured_sets",
  "redirects",

  // Media
  "media_asset_usages",
  "media_alt_proposals",
  "media_assets",
  "media_crops",

  // Audit history (chat + content)
  "audit_events",

  // v0.4.1 — site memory (Owner brand voice) + AI-proposed memory queue.
  // Per operator direction: truncate alongside content so post-truncate
  // installs start with a clean brand-voice slate.
  "site_memory_proposals",
  "site_ai_memory",

  // Pending proposals (always tied to specific entities)
  "ai_providers_pending",
  "domain_pending",
  "email_config_pending",
  "experiment_pending",
  "import_pending",
  "layout_pending",
  "locale_pending",
  "mcp_token_pending",
  "plugin_pending",
  "rate_limit_pending",
  "role_pending",
  "template_pending",
  "user_pending",

  // i18n + experiments
  "experiments",
  "experiment_assignments",
  "imports",
];

/**
 * Tables to wipe in cms_public. Plugin tables are namespaced
 * `cms_public.<slug>.*` and live under each tier-2 plugin's schema;
 * we wipe by truncating the entire cms_public.<table> set the host
 * controls (visitor sessions, comments, etc.).
 */
const PUBLIC_TABLES = [
  "comments",
  "newsletter_subscribers",
  "newsletter_double_opt_in",
  "form_submissions",
  "ratings",
  "visitor_sessions",
];

const tables = target === "admin" ? ADMIN_TABLES : PUBLIC_TABLES;

if (!SQL) {
  console.error("Bun.SQL not available; this script must run under Bun");
  process.exit(1);
}
const sql = new SQL(url);

console.log(`truncate target=${target} tables=${tables.length}`);

async function tableExists(name: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = ${name} LIMIT 1
  `) as unknown as { exists?: number }[];
  return rows.length > 0;
}

await sql.begin(async (tx: SQL) => {
  await tx.unsafe("SET LOCAL caelo.actor_kind = 'system'");
  const existing: string[] = [];
  for (const t of tables) {
    if (await tableExists(t)) existing.push(t);
  }
  if (existing.length === 0) {
    console.log("no matching tables; nothing to truncate");
    return;
  }
  const tableList = existing.map((t) => `"${t}"`).join(", ");
  console.log(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
  await tx.unsafe(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`);
});

console.log("truncate complete");
await sql.end();
