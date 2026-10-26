// SPDX-License-Identifier: MPL-2.0

/**
 * A plugin's admin page, rendered from its `adminPanels` declaration (one
 * renderer for every plugin, shipped or installed at runtime). 404 while
 * the plugin is not active; the panel's permission gates the load and each
 * action. See `#lib/server/plugin-panels.ts` for what can be called and how.
 */

import { fail } from "@sveltejs/kit";
import { z } from "zod";
import { fillCopy, parseFields, primitiveValue } from "#lib/plugin-panels.js";
import { assertCsrfToken } from "#lib/server/csrf.js";
import {
  findRowAction,
  findSection,
  loadReview,
  loadSections,
  panelCaller,
  postedJson,
  postedString,
  requirePanel,
} from "#lib/server/plugin-panels.js";
import type { Actions, PageServerLoad, RequestEvent } from "./$types";

export const load: PageServerLoad = async ({ locals, params, url }) => {
  const panel = requirePanel(locals, params.slug, params.panel);
  const call = panelCaller(locals, params.slug);
  const base = `/plugins/${encodeURIComponent(params.slug)}/${encodeURIComponent(params.panel)}`;
  const [sections, review] = await Promise.all([
    loadSections(panel, url, call, `${base}/download`),
    loadReview(panel, url, call),
  ]);
  return {
    pluginSlug: params.slug,
    panel: {
      slug: panel.slug,
      title: panel.title,
      description: panel.description,
      icon: panel.icon,
    },
    sections,
    review,
  };
};

/**
 * Shared shape of every action: the panel (404/403), the CSRF token, the
 * operation call, and the operator-facing outcome (`{ok: message}` toasts
 * via the authed layout; `{error}` likewise, and both render inline).
 */
interface PlannedCall {
  operation: string;
  args: Record<string, unknown>;
  successMessage: string;
  sectionId: string;
}

async function runAction(
  event: RequestEvent,
  resolve: (
    form: FormData,
    panel: ReturnType<typeof requirePanel>,
  ) => PlannedCall | { error: string; sectionId: string },
) {
  const { locals, params, request } = event;
  const panel = requirePanel(locals, params.slug, params.panel);
  const form = await request.formData();
  await assertCsrfToken(form, locals);
  const planned = resolve(form, panel);
  if ("error" in planned) return fail(400, planned);
  const r = await panelCaller(locals, params.slug)(planned.operation, planned.args);
  if (!r.ok) return fail(400, { error: r.message, sectionId: planned.sectionId });
  return { ok: fillCopy(planned.successMessage, r.value), sectionId: planned.sectionId };
}

export const actions: Actions = {
  /** One row's action; its arguments are the row values the page rendered. */
  row: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const { action } = findRowAction(panel, sectionId, postedString(form, "action"));
      if (action.review) {
        // A reviewed action runs only from its review (`submit` below).
        return { error: "Open the review first.", sectionId };
      }
      const rowArgs = postedJson(
        form,
        "args",
        z.strictObject(
          Object.fromEntries(Object.keys(action.rowArgs).map((a) => [a, primitiveValue])),
        ),
      );
      return {
        operation: action.operation,
        args: { ...rowArgs, ...action.args },
        successMessage: action.successMessage,
        sectionId,
      };
    }),

  /** A reviewed row action: submits exactly the values the review showed. */
  submit: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const { action } = findRowAction(panel, sectionId, postedString(form, "action"));
      if (!action.review) return { error: "This action has no review.", sectionId };
      const shown = postedJson(
        form,
        "args",
        z.strictObject(
          Object.fromEntries(Object.keys(action.review.submitArgs).map((a) => [a, z.json()])),
        ),
      );
      return {
        operation: action.operation,
        args: { ...shown, ...action.args },
        successMessage: action.successMessage,
        sectionId,
      };
    }),

  /** An action on the selected rows of a table. */
  bulk: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const section = findSection(panel, sectionId, "table");
      const actionId = postedString(form, "action");
      const action = section.bulkActions?.find((a) => a.id === actionId);
      if (!action) return { error: `No action "${actionId}".`, sectionId };
      const ids = postedJson(form, "ids", z.array(primitiveValue).min(1).max(500));
      return {
        operation: action.operation,
        args: { [action.idsArg]: ids, ...action.args },
        successMessage: action.successMessage,
        sectionId,
      };
    }),

  /** A section-wide action ("Refresh now"). */
  toolbar: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const section = findSection(panel, sectionId, "table");
      const actionId = postedString(form, "action");
      const action = section.actions?.find((a) => a.id === actionId);
      if (!action) return { error: `No action "${actionId}".`, sectionId };
      return {
        operation: action.operation,
        args: { ...action.args },
        successMessage: action.successMessage,
        sectionId,
      };
    }),

  /** A form section's submit. */
  form: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const section = findSection(panel, sectionId, "form");
      const fields = parseFields(section.fields, form);
      if (!fields.ok) return { error: fields.error, sectionId };
      return {
        operation: section.operation,
        args: { ...fields.args, ...section.args },
        successMessage: section.successMessage,
        sectionId,
      };
    }),

  /** A settings section's save. */
  settings: (event) =>
    runAction(event, (form, panel) => {
      const sectionId = postedString(form, "section");
      const section = findSection(panel, sectionId, "settings");
      const fields = parseFields(section.fields, form);
      if (!fields.ok) return { error: fields.error, sectionId };
      return {
        operation: section.writeOperation,
        args: { ...fields.args, ...section.writeArgs },
        successMessage: section.successMessage,
        sectionId,
      };
    }),
};
