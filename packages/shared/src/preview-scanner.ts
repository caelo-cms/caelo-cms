// SPDX-License-Identifier: MPL-2.0

/**
 * `<caelo-slot name="…">…</caelo-slot>` scanner backed by `htmlparser2`'s
 * Parser. Replaces the inner HTML of each named slot with caller-supplied
 * content, leaving every byte outside the slots unchanged.
 *
 * Why a real parser: the previous regex-based version mishandled comments
 * (`<!-- <caelo-slot> -->`), CDATA, and attributes containing `<`, and
 * required hand-rolled "no nested slots" detection. htmlparser2 is MIT,
 * tiny, and dependency-free — same parser the larger Cheerio/Jsdom-style
 * tools use under the hood.
 *
 * Invariants preserved from the regex version:
 *   - Bytes outside `<caelo-slot>` ranges are byte-stable in the output.
 *   - The `<caelo-slot ...>` opening + closing tags themselves are
 *     preserved (only inner HTML is replaced) so CSS selectors keep matching.
 *   - Nested `<caelo-slot>` inside another `<caelo-slot>` is rejected.
 *   - Unterminated openers are rejected.
 */

import { Parser } from "htmlparser2";

const SLOT_TAG = "caelo-slot";

export interface SlotReplacement {
  /** Inner HTML for each `<caelo-slot name="…">`. */
  readonly contentByName: ReadonlyMap<string, string>;
}

export interface ScanResult {
  readonly html: string;
  readonly replacedSlots: readonly string[];
  readonly missingSlots: readonly string[];
}

interface SlotRange {
  readonly name: string;
  /** Byte offset just after the opening `>`. */
  readonly innerStart: number;
  /** Byte offset of the opening `<` of the closing tag. */
  readonly innerEnd: number;
}

/**
 * Returns a copy of `templateHtml` where each `<caelo-slot name="X">…</caelo-slot>`
 * has its inner HTML replaced by `replacement.contentByName.get(X)`. Slots
 * with no entry render with their original inner HTML preserved (so a
 * template-author placeholder stays visible in the editor preview).
 *
 * Throws on nested or unbalanced slot markers — those are template-author
 * bugs and silently smoothing them over would just defer the discovery.
 */
export function applySlotReplacements(
  templateHtml: string,
  replacement: SlotReplacement,
): ScanResult {
  const ranges: SlotRange[] = [];
  let openName: string | null = null;
  let openInnerStart = 0;
  let openOpenStart = 0;

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name !== SLOT_TAG) return;
        if (openName !== null) {
          throw new Error(`nested <caelo-slot> not allowed (at offset ${parser.startIndex})`);
        }
        openName = attrs["name"] ?? "";
        // `endIndex` of the opening tag points at the closing `>`; the inner
        // HTML therefore starts one byte later.
        openOpenStart = parser.startIndex;
        openInnerStart = parser.endIndex + 1;
      },
      onclosetag(name) {
        if (name !== SLOT_TAG) return;
        if (openName === null) {
          throw new Error(`closing </caelo-slot> with no opener (at offset ${parser.startIndex})`);
        }
        // htmlparser2 auto-closes unterminated tags at EOF — detect that case
        // by verifying the source actually contains `</caelo-slot>` at the
        // reported offset. Auto-closed tags fire onclosetag at EOF without a
        // matching `</` in the input.
        const hasExplicitClose = templateHtml
          .slice(parser.startIndex, parser.startIndex + SLOT_TAG.length + 3)
          .toLowerCase()
          .startsWith(`</${SLOT_TAG}`);
        if (!hasExplicitClose) {
          throw new Error(
            `unterminated <caelo-slot name="${openName}"> at offset ${openOpenStart}`,
          );
        }
        ranges.push({
          name: openName,
          innerStart: openInnerStart,
          innerEnd: parser.startIndex,
        });
        openName = null;
      },
    },
    // recognizeSelfClosing handles `<caelo-slot name="x" />` style; we still
    // require an explicit close tag so that case skips replacement (matches
    // the documented "self-close passes through" limitation).
    { lowerCaseTags: true, recognizeSelfClosing: false },
  );
  parser.write(templateHtml);
  parser.end();

  if (openName !== null) {
    throw new Error(`unterminated <caelo-slot name="${openName}"> at offset ${openOpenStart}`);
  }

  const parts: string[] = [];
  const replaced: string[] = [];
  const missing: string[] = [];
  let cursor = 0;
  for (const range of ranges) {
    parts.push(templateHtml.slice(cursor, range.innerStart));
    if (replacement.contentByName.has(range.name)) {
      parts.push(replacement.contentByName.get(range.name) ?? "");
      replaced.push(range.name);
    } else {
      missing.push(range.name);
      parts.push(templateHtml.slice(range.innerStart, range.innerEnd));
    }
    cursor = range.innerEnd;
  }
  parts.push(templateHtml.slice(cursor));
  return { html: parts.join(""), replacedSlots: replaced, missingSlots: missing };
}
