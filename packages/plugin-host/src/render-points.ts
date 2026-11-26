// SPDX-License-Identifier: MPL-2.0

/**
 * #1729 — the render-point runtime (docs/dev/external-plugin-brokers.md
 * §4.4, §6): what every composition point shares when core asks a plugin
 * during a render, so a runtime-installed (sandboxed) plugin answers it the
 * way a shipped one does.
 *
 * - **Reserved entries** (decision Q3 A). The manifest carries booleans and
 *   lists, not operation names, so the host cannot name the operation that
 *   answers a point. It asks a reserved entry (`$listSources`, …) instead;
 *   the sandbox child resolves it from the plugin's own definition, and
 *   `$inspect` refuses an artifact whose definition does not answer an
 *   entry its manifest announces (or answers one it does not announce).
 *   A new point adds one row to {@link RENDER_POINT_ENTRIES}.
 * - **Chunks.** A render asks about many pages at once (a build: every
 *   page of the site), and one wire message holds at most 1 MB. The host
 *   splits the page ids ({@link chunkPageIds}), asks once per chunk and
 *   merges; a preview asks about one page, so it pays one sandbox spawn per
 *   point, not one per page or entry. An answer bigger than a line comes
 *   back in parts (`part` messages, sandbox-protocol.ts), capped by the
 *   point's own total ({@link RenderPointCall.maxAnswerBytes}).
 * - **Budget.** A render call is kind `preview` (5 s) or `build` (60 s) per
 *   point and chunk (Q10, `SANDBOX_BUDGETS`), read from its origin.
 * - **Values** that reach a page go through `plugin-values.ts` (§4.5).
 *
 * Every plugin goes through the same code (one plugin model): a shipped
 * plugin's answer is chunked, capped and checked exactly like a sandboxed
 * one's.
 */

import type { PluginManifest } from "@caelo-cms/plugin-sdk";

/**
 * A composition point's reserved entry: the definition key that names the
 * operation answering it, and the manifest field that announces it.
 */
export interface RenderPointEntry {
  readonly definitionKey: string;
  readonly announcedBy: keyof PluginManifest;
}

/**
 * Every reserved entry, by name. The sandbox child receives this table
 * (sandbox-entry.ts) and resolves `$name` to
 * `definition.operations[definition[definitionKey]]`.
 */
export const RENDER_POINT_ENTRIES = Object.freeze({
  /** §6.3 — `listSourcesOperation`, announced by a non-empty `listSources`. */
  $listSources: { definitionKey: "listSourcesOperation", announcedBy: "listSources" },
  /** §6.2 — `contributionsOperation`, announced by a non-empty `contributes`. */
  $contributions: { definitionKey: "contributionsOperation", announcedBy: "contributes" },
  /** §6.2 — `shareImagesOperation`, announced by `hasShareImages`. */
  $shareImages: { definitionKey: "shareImagesOperation", announcedBy: "hasShareImages" },
} satisfies Record<string, RenderPointEntry>);

/** The name of a reserved entry. */
export type RenderPointEntryName = keyof typeof RENDER_POINT_ENTRIES;

/** Whether `value` (a manifest field) announces its point: `true` or a non-empty list. */
function announces(value: unknown): boolean {
  return Array.isArray(value) ? value.length > 0 : value === true;
}

/** The reserved entries a reviewed manifest announces, in table order. */
export function announcedRenderPoints(manifest: PluginManifest): RenderPointEntryName[] {
  return (Object.keys(RENDER_POINT_ENTRIES) as RenderPointEntryName[]).filter((name) =>
    announces(manifest[RENDER_POINT_ENTRIES[name].announcedBy]),
  );
}

/**
 * What an external definition carries for its announced points: each
 * definition key set to its reserved entry, and the entry as an operation
 * (the loader checks that a named operation exists, as it does for a
 * shipped plugin). `invoke` runs an entry in the sandbox.
 */
export function renderPointDefinition<Op>(
  manifest: PluginManifest,
  invoke: (entry: string) => Op,
): { readonly keys: Record<string, string>; readonly operations: Record<string, Op> } {
  const keys: Record<string, string> = {};
  const operations: Record<string, Op> = {};
  for (const name of announcedRenderPoints(manifest)) {
    keys[RENDER_POINT_ENTRIES[name].definitionKey] = name;
    operations[name] = invoke(name);
  }
  return { keys, operations };
}

/**
 * Bytes of page ids one render-point call carries: well under the 1 MB
 * message line, with room for the point's other arguments (a URL style, a
 * pass id). 512 KB is about 13 000 page ids, so a 50 000-page build asks in
 * four calls and a preview in one.
 */
export const RENDER_POINT_CHUNK_BYTES = 512 * 1024;

/**
 * Split `ids` into chunks whose JSON stays within `maxBytes` and that hold
 * at most `maxIds` ids, in order. A point whose answer grows with the
 * pages it is asked about sets `maxIds`, so each call's answer stays under
 * its cap however large the site (a list source: about a kilobyte per
 * page, 4 MB per call). An empty list gives no chunk (a point with nothing
 * to ask makes no call).
 */
export function chunkPageIds(
  ids: ReadonlyArray<string>,
  opts: { readonly maxBytes?: number; readonly maxIds?: number } = {},
): string[][] {
  const maxBytes = opts.maxBytes ?? RENDER_POINT_CHUNK_BYTES;
  const maxIds = opts.maxIds ?? Number.POSITIVE_INFINITY;
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 2;
  for (const id of ids) {
    // A quoted id and its comma; ids are uuids, so one byte per character.
    const size = Buffer.byteLength(JSON.stringify(id)) + 1;
    if (chunk.length > 0 && (bytes + size > maxBytes || chunk.length >= maxIds)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 2;
    }
    chunk.push(id);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** One render-point call as the shared runtime runs it. */
export interface RenderPointCall {
  /** The point's name in errors and render failures (`list-sources`). */
  readonly point: string;
  /** The largest answer the point accepts in one call, serialized. */
  readonly maxAnswerBytes: number;
}

/**
 * Refuse an answer bigger than its point accepts, before anything walks
 * it. A sandboxed answer is capped while its parts arrive (the runtime's
 * `maxResultBytes`); this covers a shipped plugin, which answers
 * in-process, with the same number.
 */
export function assertAnswerSize(call: RenderPointCall, label: string, value: unknown): void {
  const size = Buffer.byteLength(JSON.stringify(value ?? null));
  if (size > call.maxAnswerBytes) {
    throw new Error(
      `${label}: the answer is ${size} bytes, more than the ${call.maxAnswerBytes} a render accepts`,
    );
  }
}
