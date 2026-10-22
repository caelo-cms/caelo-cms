// SPDX-License-Identifier: MPL-2.0

/**
 * Epic #724 — reads show internal links the way authors write them.
 *
 * Stored content carries `caelo:page/<id>` / `caelo:media/<id>`
 * references (rollout C). Every read op that hands content to the AI or
 * the editor — module code, content values, structured-set items, page
 * module listings — passes its result through {@link humaniseForRead},
 * so the AI and the operator see `/about#team` and `/_caelo/media/hero`
 * and never have to learn the grammar (CLAUDE.md §1A). Writing the
 * humanised form back canonicalises to the same reference, so a
 * read-modify-write round trip (edit_content's str_replace, an editor
 * form) is lossless.
 *
 * Paths come from the caller's scope (its chat branch's renames
 * included), the same view the write-side canonicaliser resolves
 * against. A reference whose target is gone stays raw: it is broken,
 * and a plausible path would hide that.
 */

import type { OperationDefinition, TransactionRunner } from "@caelo-cms/query-api";
import {
  type ExecutionContext,
  humaniseLinkRefs,
  type LinkHumaniseLookup,
  mayContainLinkRef,
  ok,
} from "@caelo-cms/shared";
import { type LinkTargets, loadLinkTargets } from "./link-targets.js";

/** The id → path / slug lookup reads use to humanise references. */
export function humaniseLookupFrom(targets: LinkTargets): LinkHumaniseLookup {
  const paths = new Map(targets.pages.map((p) => [p.id, p.path]));
  const slugs = new Map(targets.media.map((m) => [m.id, m.slug]));
  return {
    pagePath: (id) => paths.get(id) ?? null,
    mediaSlug: (id) => slugs.get(id) ?? null,
  };
}

/**
 * Wrap a read op so its successful result is humanised — one line at
 * the op's definition instead of a call before every `return ok(…)`.
 */
export function withHumanisedLinks<I, O>(
  def: OperationDefinition<I, O>,
): OperationDefinition<I, O> {
  const inner = def.handler;
  return {
    ...def,
    handler: async (ctx, input, tx) => {
      const r = await inner(ctx, input, tx);
      return r.ok ? ok(await humaniseForRead(tx, ctx, r.value)) : r;
    },
  };
}

/**
 * Humanise every reference anywhere in a read op's result. Free when the
 * result carries none (one serialisation, no query).
 */
export async function humaniseForRead<T>(
  tx: TransactionRunner,
  ctx: ExecutionContext,
  result: T,
): Promise<T> {
  if (!mayContainLinkRef(JSON.stringify(result ?? null))) return result;
  const targets = await loadLinkTargets(tx, ctx.chatBranchId ?? null);
  return humaniseLinkRefs(result, humaniseLookupFrom(targets));
}
