// SPDX-License-Identifier: MPL-2.0

/**
 * #1759 — "page X covers Y — link?": after the AI writes text that names a
 * topic the site has a topic page for, the hint names that page, unless
 * the write already links it. A rule of thumb, so a write hint and never a
 * finding (maintainer decision 2026-11-26).
 */

import type { PluginWrite } from "@caelo-cms/plugin-sdk";
import type { SeoWriteHintRule } from "../hints/index.js";
import { readVocabularies } from "./operations.js";

/** Topics named per write: more would bury the tool result. */
const MAX_TOPIC_HINTS = 2;

/** Every text a write holds, tags dropped, and every page reference it carries. */
function textsOf(writes: readonly PluginWrite[]): { text: string; refs: string } {
  const parts: string[] = [];
  const collect = (v: unknown) => {
    if (typeof v === "string") parts.push(v);
    else if (Array.isArray(v)) for (const e of v) collect(e);
    else if (typeof v === "object" && v !== null) for (const e of Object.values(v)) collect(e);
  };
  // Page content only: the SEO texts, alt texts and robots rules the plugin
  // also reads (writeHintsKinds) are no place for a link.
  for (const w of writes) {
    if (w.kind === "module") collect(w.html);
    else if (w.kind === "values") collect(w.values);
  }
  const raw = parts.join("\n");
  return { text: raw.replace(/<[^>]*>/g, " ").toLowerCase(), refs: raw };
}

/** Whether `name` stands in `text` as a word of its own. */
function mentions(text: string, name: string): boolean {
  const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** The `topic-links` hint family. */
export const TOPIC_LINK_HINTS: SeoWriteHintRule = {
  name: "topic-links",
  hints: async (ctx, writes) => {
    const { text, refs } = textsOf(writes);
    if (text.trim() === "") return [];
    const topics = (await readVocabularies(ctx)).flatMap((v) =>
      v.terms.filter((t) => t.topicPage !== null && t.name.length >= 3),
    );
    const named = topics.filter((t) => mentions(text, t.name)).slice(0, 8);
    if (named.length === 0) return [];
    const hints: string[] = [];
    for (const t of named) {
      const path = (t.topicPage as string).replace(/\/+$/, "") || "/";
      // A stored write links pages by reference; a hand-written path counts too.
      if (refs.includes(`"${path}"`) || refs.includes(`"${path}/"`)) continue;
      if (t.topicPageId !== null && refs.toLowerCase().includes(`caelo:page/${t.topicPageId}`))
        continue;
      hints.push(
        `The text mentions "${t.name}"; its topic page ${path} covers it — link it where the text names it (suggest_internal_links lists more pages to link).`,
      );
      if (hints.length >= MAX_TOPIC_HINTS) break;
    }
    return hints;
  },
};
