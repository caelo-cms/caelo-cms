// SPDX-License-Identifier: MPL-2.0

/**
 * issue #163 — Site Genesis shared shapes.
 *
 * Design-time is divergent: the AI drafts complete freeform HTML pages
 * (one per design direction) and the operator picks one; the CMS
 * structure is derived FROM that choice (#164's compiler). These are
 * the boundary schemas for the brief + the draft rows.
 */

import { z } from "zod";

/**
 * The structured Design Brief the discovery dialog produces. Every
 * field optional — the AI fills what the conversation answered; the
 * draft prompts degrade gracefully on gaps. Stored on
 * `site_defaults.design_brief`.
 */
export const designBriefSchema = z
  .object({
    audience: z.string().min(1).max(500).optional(),
    /** 3–5 adjectives the operator wants the design to feel like. */
    moodWords: z.array(z.string().min(1).max(40)).max(12).optional(),
    tone: z.string().min(1).max(300).optional(),
    industry: z.string().min(1).max(200).optional(),
    differentiators: z.string().min(1).max(1000).optional(),
    imageryDirection: z.string().min(1).max(500).optional(),
    avoid: z.string().min(1).max(500).optional(),
  })
  .strict();
export type DesignBrief = z.infer<typeof designBriefSchema>;

/** Complete single-file drafts stay well under this (inline CSS only). */
export const GENESIS_DRAFT_MAX_HTML_BYTES = 300_000;

export const genesisDraftStatus = z.enum(["candidate", "selected", "discarded"]);
export type GenesisDraftStatus = z.infer<typeof genesisDraftStatus>;

/** issue #199 — where a draft came from. */
export const genesisDraftSourceKind = z.enum(["genesis", "byod_image", "byod_html"]);
export type GenesisDraftSourceKind = z.infer<typeof genesisDraftSourceKind>;

export const genesisAddDraftInput = z
  .object({
    /** Human-readable design direction ("bold editorial"). */
    direction: z.string().min(3).max(120),
    /** Why this direction fits the brief — shown beside the preview. */
    rationale: z.string().max(1000).default(""),
    /** Complete self-contained single-file HTML. */
    html: z.string().min(200).max(GENESIS_DRAFT_MAX_HTML_BYTES),
    /** issue #199 — 'byod_image' (AI reproduction of an operator
     *  mockup) / 'byod_html' (operator HTML, sanitised at the op). */
    sourceKind: genesisDraftSourceKind.default("genesis"),
    /** issue #199 — byod_image only: the uploaded mockup's media
     *  asset. The parity gate uses THIS image as the reference. */
    referenceAssetId: z.string().uuid().optional(),
  })
  .strict();
export type GenesisAddDraftInput = z.infer<typeof genesisAddDraftInput>;

/**
 * issue #199 — strip <script> blocks from operator-provided draft
 * HTML. Defense in depth: drafts render inside sandbox="" iframes
 * (scripts never execute there), but stored HTML flows onward into
 * materialisation, so the boundary removes them outright. Linear
 * scan per the #113 discipline; case-insensitive; unterminated
 * script blocks drop everything to EOF (never leak half a script).
 */
export function sanitizeDraftHtml(html: string): string {
  const lower = html.toLowerCase();
  let out = "";
  let from = 0;
  while (true) {
    const open = lower.indexOf("<script", from);
    if (open === -1) {
      out += html.slice(from);
      return out;
    }
    out += html.slice(from, open);
    const close = lower.indexOf("</script", open);
    if (close === -1) return out;
    const closeEnd = lower.indexOf(">", close);
    if (closeEnd === -1) return out;
    from = closeEnd + 1;
  }
}
