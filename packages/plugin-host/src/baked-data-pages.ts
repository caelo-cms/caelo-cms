// SPDX-License-Identifier: MPL-2.0

/**
 * #1155 — the page ids a plugin operation named as stale, per the
 * plugin's `bakedData` declaration (see baked-data.ts). Pure: shared by
 * the dispatcher (admin and gateway) and the admin's hint check, with no
 * import of the host's registries.
 */

import type { PluginBakedData } from "@caelo-cms/plugin-sdk";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many pages per operation call; more is a malformed result. */
export const MAX_BAKED_PAGES_PER_CALL = 1000;

/** The declared trigger for `operationName`, if any. */
export function bakedDataTrigger(
  bakedData: PluginBakedData | undefined,
  operationName: string,
): PluginBakedData["triggers"][number] | null {
  return bakedData?.triggers.find((t) => t.operation === operationName) ?? null;
}

/**
 * The page ids a successful call of `operationName` made stale, per the
 * plugin's declaration: deduplicated, lower-cased UUIDs. A value that is
 * not a UUID (or a list of them) yields nothing — the call happened, but
 * its declared key does not name a page — and so does a list longer than
 * {@link MAX_BAKED_PAGES_PER_CALL}.
 *
 * @param opts.single - only one id counts (the gateway's op event carries
 *   one page id): a list yields nothing.
 */
export function bakedDataPageIds(
  bakedData: PluginBakedData | undefined,
  operationName: string,
  call: { readonly args: unknown; readonly result: unknown },
  opts: { readonly single?: boolean } = {},
): string[] {
  const t = bakedDataTrigger(bakedData, operationName);
  if (!t) return [];
  const source = t.pageIds.from === "args" ? call.args : call.result;
  if (source === null || typeof source !== "object" || Array.isArray(source)) return [];
  const value = (source as Record<string, unknown>)[t.pageIds.key];
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  if (raw.length > MAX_BAKED_PAGES_PER_CALL) return [];
  if (opts.single && raw.length !== 1) return [];
  const out = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string" || !UUID_RE.test(v)) return [];
    out.add(v.toLowerCase());
  }
  return [...out];
}
