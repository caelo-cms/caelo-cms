// SPDX-License-Identifier: MPL-2.0

/**
 * #1757, #1760 — `pages_seo.overview`: the pages with the SEO head a build
 * renders for them, each value with its origin (#1752: the page's own text
 * by `human` / `ai` / `reviewed`, a `page_type` or `site` template,
 * `inherited`, `unset`), and the findings the latest finished Stage audit
 * filed on them. The seo plugin's overview panel lists it, and its
 * duplicate check reads the titles and descriptions of every staged page
 * through it, a thousand ids at a time.
 *
 * Request-scoped (CLAUDE.md §2): a page of at most {@link OVERVIEW_MAX_LIMIT}
 * pages by path (keyset), or the pages `pageIds` names. Filters by page
 * type are part of the query; filters by origin and by finding apply to
 * the page read, so a page of results may hold fewer rows than `limit`
 * while `nextCursor` says more may follow.
 */

import { defineOperation, uuidArray } from "@caelo-cms/query-api";
import { err, ok, robotsMetaContent, SEO_VALUE_ORIGINS } from "@caelo-cms/shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { loadPageSeoViews, pageKey } from "../seo/page-seo.js";
import { resolvePageSeoHeads } from "../seo/page-seo-head.js";

/** Most pages one call answers. */
export const OVERVIEW_MAX_LIMIT = 100;
/** Most pages one call names by id. */
export const OVERVIEW_MAX_IDS = 1000;

const valueOutput = z.object({ value: z.string(), origin: z.enum(SEO_VALUE_ORIGINS) });

const findingOutput = z.object({
  ruleId: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
});

const rowOutput = z.object({
  pageId: z.string(),
  path: z.string(),
  title: z.string(),
  status: z.enum(["draft", "published"]),
  pageType: z.string(),
  /** The `<title>` a build renders, with its origin. */
  seoTitle: valueOutput,
  metaDescription: valueOutput,
  /** The `<meta name="robots">` content. */
  robots: z.string(),
  noindex: z.boolean(),
  /** The page's own canonical override; null = its own URL. */
  canonicalUrl: z.string().nullable(),
  /** Findings of the latest finished Stage audit on this page (every check). */
  findings: z.array(findingOutput),
});

/** The keyset cursor: the last row's path and id. */
const cursorSchema = z.object({ path: z.string(), id: z.string().uuid() }).strict();

function encodeCursor(path: string, id: string): string {
  return Buffer.from(JSON.stringify({ path, id }), "utf8").toString("base64url");
}

function decodeCursor(raw: string): z.infer<typeof cursorSchema> | null {
  try {
    return cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
  } catch {
    return null;
  }
}

export const pagesSeoOverviewOp = defineOperation({
  name: "pages_seo.overview",
  pluginAccess: "read",
  readScope: "request",
  // Why human-only: no AI tool, because the AI reads the same values with
  // get_page_seo (each with its origin) and the findings with
  // check_stage_audit; this is the read behind the seo plugin's panel and
  // duplicate check, and the Owner's.
  actorScope: ["human", "plugin", "system"],
  database: "cms_admin",
  input: z
    .object({
      /** Only these pages (the duplicate check); else a page by path. */
      pageIds: z.array(z.string().uuid()).min(1).max(OVERVIEW_MAX_IDS).optional(),
      pageTypeId: z.string().uuid().optional(),
      /** Only pages whose title or meta description has this origin. */
      origin: z.enum(SEO_VALUE_ORIGINS).optional(),
      /** Only pages with a finding of this rule (`plugin.seo/h1-count`) or prefix (`plugin.seo/`). */
      finding: z.string().min(1).max(120).optional(),
      /** Skip the findings (the duplicate check needs none). */
      withFindings: z.boolean().default(true),
      limit: z.number().int().min(1).max(OVERVIEW_MAX_LIMIT).default(50),
      cursor: z.string().min(1).max(600).optional(),
    })
    .strict(),
  output: z.object({ pages: z.array(rowOutput), nextCursor: z.string().nullable() }),
  handler: async (ctx, input, tx) => {
    const op = "pages_seo.overview";
    const after = input.cursor === undefined ? null : decodeCursor(input.cursor);
    if (input.cursor !== undefined && after === null) {
      return err({
        kind: "HandlerError",
        operation: op,
        message:
          "cursor is not a pages_seo.overview cursor: pass nextCursor as the last call returned it, or leave it out.",
      });
    }
    const branch = ctx.chatBranchId ?? null;
    const visibility = branch
      ? sql`AND (p.chat_branch_id IS NULL OR p.chat_branch_id = ${branch}::uuid)`
      : sql`AND p.chat_branch_id IS NULL`;
    const byIds = input.pageIds ? sql`AND p.id = ANY(${uuidArray(input.pageIds)})` : sql``;
    const byType = input.pageTypeId ? sql`AND p.page_type_id = ${input.pageTypeId}::uuid` : sql``;
    const afterKey = after
      ? sql`AND (p.current_path, p.id) > (${after.path}, ${after.id}::uuid)`
      : sql``;
    const limit = input.pageIds ? input.pageIds.length : input.limit;
    const rows = (await tx.execute(sql`
      SELECT p.id::text AS id, p.current_path, p.title, p.status, pt.slug AS page_type
        FROM pages p
        JOIN page_types pt ON pt.id = p.page_type_id
       WHERE p.deleted_at IS NULL ${visibility} ${byIds} ${byType} ${afterKey}
       ORDER BY p.current_path, p.id
       LIMIT ${limit + 1}
    `)) as unknown as {
      id: string;
      current_path: string;
      title: string;
      status: "draft" | "published";
      page_type: string;
    }[];
    const more = !input.pageIds && rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const ids = pageRows.map((r) => pageKey(r.id));
    const views = await loadPageSeoViews(tx, ids, branch);
    const heads = await resolvePageSeoHeads(
      tx,
      ids,
      new Map([...views].map(([id, v]) => [id, v.state])),
      branch,
    );
    const findings = new Map<string, z.infer<typeof findingOutput>[]>();
    if (input.withFindings && ids.length > 0) {
      const run = (await tx.execute(sql`
        SELECT id::text AS id FROM quality_audit_runs
         WHERE status IN ('passed', 'problems')
         ORDER BY created_at DESC LIMIT 1
      `)) as unknown as { id: string }[];
      const runId = run[0]?.id;
      if (runId) {
        const found = (await tx.execute(sql`
          SELECT page_id::text AS page_id, check_findings FROM quality_audit_pages
           WHERE audit_run_id = ${runId}::uuid AND page_id = ANY(${uuidArray(ids)})
        `)) as unknown as { page_id: string; check_findings: unknown }[];
        for (const f of found) {
          const list = z.array(findingOutput.passthrough()).safeParse(f.check_findings);
          if (!list.success) {
            throw new Error(
              `${op}: the findings of audit run ${runId} on page ${f.page_id} are not findings — the audit recorder wrote them; report it with bug_report`,
            );
          }
          findings.set(
            f.page_id,
            list.data.map((x) => ({ ruleId: x.ruleId, severity: x.severity, message: x.message })),
          );
        }
      }
    }
    const out = pageRows.flatMap((r) => {
      const id = pageKey(r.id);
      const view = heads.get(id);
      if (!view) return [];
      const state = views.get(id)?.state;
      const row = {
        pageId: id,
        path: r.current_path,
        title: r.title,
        status: r.status,
        pageType: r.page_type,
        seoTitle: { value: view.head.title.value, origin: view.head.title.origin },
        metaDescription: {
          value: view.head.metaDescription.value,
          origin: view.head.metaDescription.origin,
        },
        robots: robotsMetaContent(view.head.robots),
        noindex: view.head.robots.noindex,
        canonicalUrl: state?.canonicalUrl ?? null,
        findings: findings.get(id) ?? [],
      };
      if (
        input.origin &&
        row.seoTitle.origin !== input.origin &&
        row.metaDescription.origin !== input.origin
      ) {
        return [];
      }
      const rule = input.finding;
      if (
        rule &&
        !row.findings.some(
          (f) => f.ruleId === rule || (rule.endsWith("/") && f.ruleId.startsWith(rule)),
        )
      ) {
        return [];
      }
      return [row];
    });
    const last = pageRows.at(-1);
    return ok({
      pages: out,
      nextCursor: more && last ? encodeCursor(last.current_path, last.id) : null,
    });
  },
});
