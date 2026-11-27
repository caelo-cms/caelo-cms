// SPDX-License-Identifier: MPL-2.0

/**
 * The audit's fact batches on the sandbox wire (found with #1755, fixed
 * with epic #1751). A sandboxed plugin receives its call as ONE message of
 * at most `SANDBOX_MESSAGE_BYTES` (1 MB, sandbox-protocol.ts), and the
 * caps core reads facts with (`AUDIT_FACT_LIMITS`) bound a page, not a
 * batch of up to 200 pages: a batch of ordinary pages (tens of KB of facts
 * each) did not fit, and the call failed with `SandboxMessageTooLarge`.
 *
 * So before a batch call goes to a sandboxed plugin, the host cuts it into
 * consecutive calls that each fit ({@link auditCallsThatFit}), in the order
 * the plugin asked for the pages. With `batchPages: "own"` each part
 * carries its own pages, as a smaller batch would. A page whose facts
 * alone do not fit is cut further, the way the caps cut it: the largest of
 * its lists loses entries from the end and `truncatedFacts` names it. A
 * call whose page list alone does not fit is refused with the next step
 * (answer `batchPages: "own"`), never sent to fail.
 *
 * An in-process plugin has no wire, so its calls are not cut: a batch the
 * plugin asked for side by side (a page and its language versions) stays
 * one call wherever that is possible.
 */

import type {
  PluginAuditFactName,
  PluginAuditFindingsArgs,
  PluginAuditPageFacts,
} from "@caelo-cms/plugin-sdk";
import { SANDBOX_MESSAGE_BYTES } from "./sandbox-protocol.js";

/**
 * The bytes a call's args may take on the sandbox wire: one message, less
 * room for the rest of it (the plugin's slug and version, the invocation,
 * the site's theme tokens and the handle flags; a few KB in practice).
 */
export const AUDIT_CALL_ARGS_BYTES = SANDBOX_MESSAGE_BYTES - 64 * 1024;

/** The facts a cut may shorten, each a list of entries. */
const CUTTABLE: readonly PluginAuditFactName[] = [
  "texts",
  "links",
  "images",
  "headings",
  "jsonLd",
  "socialMeta",
];

const encoder = new TextEncoder();

/** The bytes `value` takes as JSON on the wire. */
function jsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

/**
 * One page's facts cut to at most `maxBytes` of JSON: the largest list
 * loses the later half of its entries, again and again, and is named in
 * `truncatedFacts`. Returns the facts unchanged when they fit.
 *
 * @throws when the facts do not fit with every list empty (a page title of
 *   a megabyte): no cut keeps the call honest then.
 */
export function cutPageFacts(facts: PluginAuditPageFacts, maxBytes: number): PluginAuditPageFacts {
  if (jsonBytes(facts) <= maxBytes) return facts;
  const lists = new Map<PluginAuditFactName, unknown[]>(
    CUTTABLE.map((name) => [name, [...(facts[name] as readonly unknown[])]]),
  );
  const cut = new Set<PluginAuditFactName>(facts.truncatedFacts);
  const assemble = (): PluginAuditPageFacts => ({
    ...facts,
    ...Object.fromEntries(lists),
    truncated: facts.truncated || cut.size > facts.truncatedFacts.length,
    truncatedFacts: CUTTABLE.filter((name) => cut.has(name)).concat(
      facts.truncatedFacts.filter((name) => !CUTTABLE.includes(name)),
    ),
  });
  for (;;) {
    const current = assemble();
    if (jsonBytes(current) <= maxBytes) return current;
    let largest: PluginAuditFactName | null = null;
    let largestBytes = 0;
    for (const [name, entries] of lists) {
      if (entries.length === 0) continue;
      const bytes = jsonBytes(entries);
      if (bytes > largestBytes) {
        largest = name;
        largestBytes = bytes;
      }
    }
    if (largest === null) {
      throw new Error(
        `audit facts: the facts of page ${facts.pageId} take more than ${maxBytes} bytes with every list empty, so they cannot reach a sandboxed plugin — report it with bug_report`,
      );
    }
    const entries = lists.get(largest) as unknown[];
    entries.length = Math.floor(entries.length / 2);
    cut.add(largest);
  }
}

/**
 * A batch call cut into consecutive calls whose args each take at most
 * `maxBytes` of JSON (default {@link AUDIT_CALL_ARGS_BYTES}). A call
 * without facts, or one that fits, comes back as it is.
 *
 * @throws when the call's page list alone does not fit (a batch call that
 *   carries every page of a large site): the plugin's first answer has to
 *   say `batchPages: "own"`.
 */
export function auditCallsThatFit(
  args: PluginAuditFindingsArgs,
  maxBytes: number = AUDIT_CALL_ARGS_BYTES,
): PluginAuditFindingsArgs[] {
  const facts = args.facts;
  if (facts === undefined || jsonBytes(args) <= maxBytes) return [args];
  const own = args.batchPages === "own";
  const pageOf = new Map(args.pages.map((p) => [p.pageId, p]));
  const shell = (pages: PluginAuditFindingsArgs["pages"]): PluginAuditFindingsArgs => ({
    ...args,
    pages,
    facts: [],
  });
  // An entry of a list costs its bytes and a comma.
  const fixed = jsonBytes(shell(own ? [] : args.pages));
  if (fixed > maxBytes) {
    throw new Error(
      `audit facts: a batch call that carries all ${args.pages.length} pages of the build takes ${fixed} bytes before any fact, more than the ${maxBytes} one message to a sandboxed plugin holds. The plugin's first answer has to say batchPages: "own", so each batch call carries only its own pages.`,
    );
  }
  const calls: PluginAuditFindingsArgs[] = [];
  let pages: PluginAuditFindingsArgs["pages"][number][] = [];
  let chunk: PluginAuditPageFacts[] = [];
  let bytes = fixed;
  const flush = () => {
    if (chunk.length === 0) return;
    calls.push({ ...args, ...(own ? { pages } : {}), facts: chunk });
    pages = [];
    chunk = [];
    bytes = fixed;
  };
  for (const f of facts) {
    const page = pageOf.get(f.pageId) ?? { pageId: f.pageId, path: f.path };
    const pageBytes = own ? jsonBytes(page) + 1 : 0;
    // Room for this page alone in an empty call.
    const fitted = cutPageFacts(f, maxBytes - fixed - pageBytes - 1);
    const factBytes = jsonBytes(fitted) + 1;
    if (chunk.length > 0 && bytes + pageBytes + factBytes > maxBytes) flush();
    if (own) pages.push(page);
    chunk.push(fitted);
    bytes += pageBytes + factBytes;
  }
  flush();
  return calls;
}
