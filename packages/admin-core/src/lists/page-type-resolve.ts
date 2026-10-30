// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #1107 — which page type a page write lands on (docs/lists.md §5),
 * decided deterministically and in the caller's view:
 *
 *   - `pageType` named → that type; the template is the one passed, else
 *     the page's current one (update), else the type's `defaultTemplate`
 *     (create);
 *   - only a template named (create, or an update that moves the page to
 *     a template its current type does not allow) → the ONE type whose
 *     `templates` contain it — a deterministic choice the caller made by
 *     naming the template; none or several is an AI-actionable error;
 *   - neither on create → refused (#1276): there is no stored default
 *     type, the error lists every type to choose from;
 *   - neither on update → the page keeps its type.
 */

import { type ErrorDetail, parseErrorPath, type TransactionRunner } from "@caelo-cms/query-api";
import type { PageTypeDef } from "@caelo-cms/shared";
import { shortPurpose } from "./page-type-similar.js";
import { loadPagesInView } from "./pages-view.js";
import { type ListEntityView, loadListEntities } from "./store.js";

export type ResolvedPageType =
  | {
      readonly ok: true;
      readonly typeId: string;
      readonly def: PageTypeDef;
      readonly templateId: string;
    }
  | {
      readonly ok: false;
      /** The problem, path relative to the write's input (`["pageType"]`). */
      readonly detail: ErrorDetail;
    };

/** The page types to choose from, as the `next` of an error. */
export interface PageTypeChoices {
  /** Every type's slug (empty when the site has none yet). */
  readonly slugs: readonly string[];
  /** Slug, purpose and page count per type, plus how to make a new one. */
  readonly next: string;
}

/**
 * The page types a caller can choose from — slug, purpose and page count
 * per type, plus how to make a new one: the decision support a refused
 * write carries (#1276; page types cannot ride the cached system prompt,
 * CLAUDE.md §11). Rendered by the #1277 error formatter as the `next` of
 * the {@link ErrorDetail} that names the field.
 */
export async function describePageTypeChoices(
  tx: TransactionRunner,
  branchId: string | null,
  types?: readonly ListEntityView<"pageType">[],
): Promise<PageTypeChoices> {
  const all = types ?? (await loadListEntities(tx, "pageType", branchId));
  const create =
    "or create a new one: create_template with newPageType (template + type in one call), or upsert_page_types_many for an existing template.";
  if (all.length === 0) return { slugs: [], next: `The site has no page types yet — ${create}` };
  const counts = new Map<string, number>();
  for (const p of await loadPagesInView(tx, branchId)) {
    counts.set(p.pageTypeId, (counts.get(p.pageTypeId) ?? 0) + 1);
  }
  const lines = all.map(
    (t) =>
      `"${t.state.slug}" (${shortPurpose(t.state.definition.purpose)}; ${counts.get(t.id) ?? 0} page(s))`,
  );
  return {
    slugs: all.map((t) => t.state.slug),
    next: `Page types: ${lines.join(", ")} — pick the one that says what the page IS, ${create}`,
  };
}

/** One problem at `path`, carrying the page types to choose from. */
export async function pageTypeChoiceDetail(
  tx: TransactionRunner,
  branchId: string | null,
  path: ErrorDetail["path"],
  message: string,
  types?: readonly ListEntityView<"pageType">[],
): Promise<ErrorDetail> {
  // `next` already names every slug (with purpose and page count), so the
  // slugs are not repeated as `allowed`.
  return { path, message, next: (await describePageTypeChoices(tx, branchId, types)).next };
}

/** Resolve the page type and template of a page write (see the file header). */
export async function resolvePageTypeForWrite(
  tx: TransactionRunner,
  branchId: string | null,
  input: {
    readonly pageType?: string;
    readonly templateId?: string;
    /** The page's current type + template on an update; absent on create. */
    readonly current?: { readonly pageTypeId: string; readonly templateId: string };
  },
): Promise<ResolvedPageType> {
  const types = await loadListEntities(tx, "pageType", branchId);
  const fail = async (
    field: "pageType" | "templateId",
    message: string,
  ): Promise<ResolvedPageType> => ({
    ok: false,
    detail: await pageTypeChoiceDetail(tx, branchId, [field], message, types),
  });

  if (input.pageType !== undefined) {
    const t = types.find((x) => x.state.slug === input.pageType);
    if (!t) {
      return fail("pageType", `no page type "${input.pageType}"`);
    }
    const templateId =
      input.templateId ?? input.current?.templateId ?? t.state.definition.defaultTemplate;
    return { ok: true, typeId: t.id, def: t.state.definition, templateId };
  }

  if (input.current) {
    const current = types.find((x) => x.id === input.current?.pageTypeId);
    const templateId = input.templateId ?? input.current.templateId;
    if (current?.state.definition.templates.includes(templateId)) {
      return { ok: true, typeId: current.id, def: current.state.definition, templateId };
    }
    if (input.templateId === undefined) {
      return fail("pageType", "the page's page type is gone from this view — pass pageType");
    }
  }

  if (input.templateId !== undefined) {
    const matches = types.filter((t) =>
      t.state.definition.templates.includes(input.templateId ?? ""),
    );
    if (matches.length === 1 && matches[0]) {
      return {
        ok: true,
        typeId: matches[0].id,
        def: matches[0].state.definition,
        templateId: input.templateId,
      };
    }
    return matches.length === 0
      ? fail(
          "templateId",
          "this template belongs to no page type — pass pageType and add the template to that type's templates (upsert_page_types_many)",
        )
      : {
          ok: false,
          detail: {
            path: ["pageType"],
            message:
              "the template is allowed for several page types — pass pageType to say which one this page is",
            allowed: matches.map((m) => m.state.slug),
          },
        };
  }

  return fail("pageType", "pageType is required: every page has a chosen page type");
}

/**
 * #1277 — `fitPageToType` issues as error details: a `properties.<name>:` /
 * `terms:` lead becomes the path, the template mismatch sits at
 * `templateId`. Paths are relative to the page write's input.
 */
export function fitIssueDetails(pageTypeSlug: string, issues: readonly string[]): ErrorDetail[] {
  return issues.map((issue) => {
    const lead = /^((?:properties|terms)[A-Za-z0-9_.[\]"-]*): (.*)$/s.exec(issue);
    if (lead?.[1] && lead[2] !== undefined) {
      return { path: parseErrorPath(lead[1]), message: lead[2] };
    }
    if (/^template /.test(issue)) return { path: ["templateId"], message: issue };
    return { path: [], message: `does not fit page type "${pageTypeSlug}": ${issue}` };
  });
}
