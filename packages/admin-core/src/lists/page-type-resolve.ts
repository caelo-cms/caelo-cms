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
 *     `templates` contain it; none or several is an AI-actionable error;
 *   - neither on create → the stored site defaults
 *     (`site_defaults.default_page_type_id` + `default_template_id`, kept
 *     consistent by `site_defaults.set`) — stored data, not a fallback;
 *   - neither on update → the page keeps its type.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import type { PageTypeDef } from "@caelo-cms/shared";
import { readSiteDefaults } from "../ops/site_defaults.js";
import { loadListEntities } from "./store.js";

export type ResolvedPageType =
  | {
      readonly ok: true;
      readonly typeId: string;
      readonly def: PageTypeDef;
      readonly templateId: string;
    }
  | { readonly ok: false; readonly message: string };

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
  const known = (): string => types.map((t) => t.state.slug).join(", ") || "none";

  if (input.pageType !== undefined) {
    const t = types.find((x) => x.state.slug === input.pageType);
    if (!t) {
      return {
        ok: false,
        message: `no page type "${input.pageType}" — the site has ${known()}. Use one of those, or create it with page_types.upsert_many.`,
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
        message: `the page's page type ${input.current.pageTypeId} is gone from this view — pass pageType (one of ${known()}).`,
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
          ? `template ${input.templateId} belongs to no page type — pass pageType (one of ${known()}) and add the template to that type's templates (page_types.upsert_many).`
          : `template ${input.templateId} is allowed for several page types (${matches.map((m) => m.state.slug).join(", ")}) — pass pageType to say which one this page is.`,
    };
  }

  const defaults = await readSiteDefaults(tx);
  if (!defaults) {
    return {
      ok: false,
      message:
        "no pageType or templateId given and the site has no defaults — pass pageType (page_types.list shows the page types).",
    };
  }
  const t = types.find((x) => x.id === defaults.defaultPageTypeId);
  if (!t) {
    return {
      ok: false,
      message: `the site's default page type ${defaults.defaultPageTypeId} is not visible here — pass pageType (one of ${known()}).`,
    };
  }
  return {
    ok: true,
    typeId: t.id,
    def: t.state.definition,
    templateId: defaults.defaultTemplateId,
  };
}
