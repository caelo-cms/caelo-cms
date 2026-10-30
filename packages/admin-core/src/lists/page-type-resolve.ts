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

import type { TransactionRunner } from "@caelo-cms/query-api";
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
  | { readonly ok: false; readonly message: string };

/**
 * The page types a caller can choose from, one per line with slug, purpose
 * and page count, plus how to make a new one — the decision support a
 * refused create carries (#1276; page types cannot ride the cached system
 * prompt, CLAUDE.md §11).
 */
export async function describePageTypeChoices(
  tx: TransactionRunner,
  branchId: string | null,
  types?: readonly ListEntityView<"pageType">[],
): Promise<string> {
  const all = types ?? (await loadListEntities(tx, "pageType", branchId));
  const create =
    "or create a new one: create_template with newPageType (template + type in one call), or upsert_page_types_many for an existing template.";
  if (all.length === 0) return `The site has no page types yet — ${create}`;
  const counts = new Map<string, number>();
  for (const p of await loadPagesInView(tx, branchId)) {
    counts.set(p.pageTypeId, (counts.get(p.pageTypeId) ?? 0) + 1);
  }
  const lines = all.map(
    (t) =>
      `"${t.state.slug}" (${shortPurpose(t.state.definition.purpose)}; ${counts.get(t.id) ?? 0} page(s))`,
  );
  return `Page types: ${lines.join(", ")} — pick the one that says what the page IS, ${create}`;
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
  const choices = (): Promise<string> => describePageTypeChoices(tx, branchId, types);

  if (input.pageType !== undefined) {
    const t = types.find((x) => x.state.slug === input.pageType);
    if (!t) {
      return {
        ok: false,
        message: `no page type "${input.pageType}". ${await choices()}`,
      };
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
      return {
        ok: false,
        message: `the page's page type ${input.current.pageTypeId} is gone from this view — pass pageType. ${await choices()}`,
      };
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
    return {
      ok: false,
      message:
        matches.length === 0
          ? `template ${input.templateId} belongs to no page type — pass pageType and add the template to that type's templates (page_types.upsert_many). ${await choices()}`
          : `template ${input.templateId} is allowed for several page types (${matches.map((m) => m.state.slug).join(", ")}) — pass pageType to say which one this page is.`,
    };
  }

  return {
    ok: false,
    message: `pageType is required: every page has a chosen page type. ${await choices()}`,
  };
}
