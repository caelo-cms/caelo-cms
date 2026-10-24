// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 (rollout C) — the per-surface entry points the write ops
 * call. Each canonicalises one surface's input and returns either the
 * stored form or an AI-actionable message; the op persists the stored
 * form or refuses the write with that message. See `canonicalise.ts`
 * for which ops call which.
 */

import type { TransactionRunner } from "@caelo-cms/query-api";
import {
  type CanonicaliseField,
  canonicaliseContentValues,
  canonicaliseFieldDefaults,
  canonicaliseHtmlLinks,
  canonicaliseJsonLinks,
  type ExecutionContext,
  urlFieldNamesInHtml,
} from "@caelo-cms/shared";
import { loadModuleStateWithBranchOverlay } from "../snapshots/load.js";
import {
  type CanonicaliseOutcome,
  canonicaliseLinksForWrite,
  probeLinkLookup,
} from "./canonicalise.js";

/**
 * Content values of one instance of `moduleId`. Field kinds come from
 * the module's stored schema (a `url` field's whole value is a link; a
 * `text` field's is not — unless the module HTML puts it whole into a
 * link attribute, `href="{{name}}"`, which makes it one, declared or not:
 * {@link urlFieldNamesInHtml}, #852).
 *
 * @param previous the values this write replaces (grandfathering), or
 *   undefined for a create.
 */
export async function canonicaliseInstanceValues(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  moduleId: string,
  values: Readonly<Record<string, unknown>>,
  previous: unknown,
): Promise<CanonicaliseOutcome<Record<string, unknown>>> {
  // Probe before loading the module's fields: link-free values skip both
  // the field load and the site lookup. The widest reading takes BOTH
  // shapes a value can carry a link in — the whole value as a URL (a
  // `url` field) and links inside it as HTML (a `richtext` field). A URL
  // reading alone sees `<p><a href="/x">` as one non-path string, so an
  // instance whose only links sat in rich text skipped canonicalisation
  // and stored them as literal paths (#1028).
  const asUrl = Object.keys(values).map((name) => ({ name, kind: "url" }));
  const probe = probeLinkLookup((run) => {
    canonicaliseContentValues(asUrl, values, run);
    return canonicaliseContentValues([], values, run);
  });
  if (!probe.needsLookup) return { ok: true, value: { ...values }, issues: [], pending: null };
  const schema = await loadModuleSchema(tx, moduleId, ctx.chatBranchId ?? null);
  if (schema === null) {
    return {
      ok: false,
      message:
        `Module ${moduleId} does not exist (or was deleted), so its content's links cannot be checked. ` +
        "Next step: list_modules shows the modules that exist; use one of those.",
      issues: [],
    };
  }
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    (run) =>
      canonicaliseContentValues(schema.fields, values, run, urlFieldNamesInHtml(schema.html)),
    { previous, pendingEntity: "content_instance" },
  );
}

/**
 * A module's HTML and field defaults (layout chrome content lives in
 * the defaults). Either may be undefined on a partial update. A default
 * the HTML puts whole into a link attribute is a URL whatever its kind
 * (#852); on a fields-only update the stored HTML decides.
 *
 * @param previous the module state this write replaces, or undefined.
 */
export async function canonicaliseModuleCode<F extends CanonicaliseField>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  code: { readonly html: string | undefined; readonly fields: readonly F[] | undefined },
  previous: { readonly html: string; readonly fields: unknown } | undefined,
): Promise<CanonicaliseOutcome<{ html: string | undefined; fields: F[] | undefined }>> {
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    (run) => ({
      html: code.html === undefined ? undefined : canonicaliseHtmlLinks(code.html, run, "html"),
      fields:
        code.fields === undefined
          ? undefined
          : canonicaliseFieldDefaults(
              code.fields,
              run,
              urlFieldNamesInHtml(code.html ?? previous?.html ?? ""),
            ),
    }),
    { previous, pendingEntity: "module" },
  );
}

/**
 * Structured-set items (nav menus, link lists): every `href` at any
 * depth (submenu `children` included) is a link.
 */
export async function canonicaliseSetItems(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  items: readonly unknown[],
  previous: unknown,
): Promise<CanonicaliseOutcome<unknown[]>> {
  return canonicaliseLinksForWrite(
    tx,
    ctx,
    (run) => canonicaliseJsonLinks(items, run, "items") as unknown[],
    { previous, pendingEntity: "structured_set" },
  );
}

/**
 * A layout's HTML (the page frame around the blocks). Links in it are
 * stored as references exactly like module HTML.
 *
 * @param previousHtml the HTML this write replaces, or undefined.
 */
export async function canonicaliseLayoutHtml(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  html: string,
  previousHtml: string | undefined,
): Promise<CanonicaliseOutcome<string>> {
  return canonicaliseLinksForWrite(tx, ctx, (run) => canonicaliseHtmlLinks(html, run, "html"), {
    previous: previousHtml === undefined ? undefined : { html: previousHtml },
  });
}

/**
 * The module's declared fields and HTML as the chat sees them (its
 * branch's pending edits overlaid on main), or null when the module does
 * not exist — never an empty list standing in for a missing module.
 */
async function loadModuleSchema(
  tx: TransactionRunner,
  moduleId: string,
  chatBranchId: string | null,
): Promise<{ fields: CanonicaliseField[]; html: string } | null> {
  const state = await loadModuleStateWithBranchOverlay(tx, moduleId, chatBranchId);
  if (state === null || state.deletedAt !== null) return null;
  const fields = state.fields.filter(
    (f): f is CanonicaliseField =>
      typeof f === "object" &&
      f !== null &&
      typeof (f as { name?: unknown }).name === "string" &&
      typeof (f as { kind?: unknown }).kind === "string",
  );
  return { fields, html: state.html };
}
