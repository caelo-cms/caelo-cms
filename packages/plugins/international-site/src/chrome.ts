// SPDX-License-Identifier: MPL-2.0

/**
 * #592 — per-locale site chrome, the pure half.
 *
 * "Chrome" is content every page shares: layout placements (header,
 * footer, menus — content in the module's field defaults) and content
 * instances synced across pages. A locale gets a VARIANT of each:
 *
 * - `translated` (default): derived from the source-language content by
 *   translation. A source edit marks it `needs_update`; the translation
 *   flow re-derives it.
 * - `independent`: detached. It keeps its own content — different items,
 *   links and number of entries, even a different module in a layout
 *   slot — and source edits never touch it.
 *
 * Identity: `layout:<layoutId>:<block>:<index>` for a layout placement,
 * `instance:<contentInstanceId>` for a shared instance. Internal links
 * are mapped to the target page's same-language version at RENDER time,
 * so a renamed or newly translated page is picked up without
 * re-translating the menu; a link whose target has no version in the
 * page's language is reported, never quietly left pointing at another
 * language.
 */

import { z } from "@caelo-cms/plugin-sdk";

/** A field as the chrome helpers need it. */
export interface ChromeField {
  readonly name: string;
  readonly kind: string;
}

/** Field kinds whose string value is human-readable text. */
const TEXT_KINDS = new Set(["text", "richtext"]);
/** Field kinds whose string value is an address. */
const LINK_KINDS = new Set(["url", "link"]);

/** The variant identity of a layout placement. */
export function layoutTargetKey(layoutId: string, blockName: string, index: number): string {
  return `layout:${layoutId}:${blockName}:${index}`;
}

/** The variant identity of a shared content instance. */
export function instanceTargetKey(contentInstanceId: string): string {
  return `instance:${contentInstanceId}`;
}

/** One translatable string inside a values object, addressed by path. */
export interface TranslatableString {
  /** `field`, `field[2]` (text-list) or `field[2].label` (link-list). */
  readonly path: string;
  readonly text: string;
}

/**
 * Every human-readable string in a placement's values: text/richtext
 * fields, text-list items and link-list labels. Addresses, numbers and
 * nested module references are not text — a placement with none of
 * these needs no locale variant.
 */
export function translatableStrings(
  fields: readonly ChromeField[],
  values: Readonly<Record<string, unknown>>,
): TranslatableString[] {
  const out: TranslatableString[] = [];
  for (const f of fields) {
    const v = values[f.name];
    if (TEXT_KINDS.has(f.kind) && typeof v === "string" && v.trim().length > 0) {
      out.push({ path: f.name, text: v });
    } else if (f.kind === "text-list" && Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === "string" && item.trim().length > 0) {
          out.push({ path: `${f.name}[${i}]`, text: item });
        }
      });
    } else if (f.kind === "link-list" && Array.isArray(v)) {
      v.forEach((item, i) => {
        const label = (item as { label?: unknown } | null)?.label;
        if (typeof label === "string" && label.trim().length > 0) {
          out.push({ path: `${f.name}[${i}].label`, text: label });
        }
      });
    }
  }
  return out;
}

const PATH_RE = /^([^[\]]+)(?:\[(\d+)\](?:\.(label))?)?$/;

/**
 * Write translated strings back into a deep copy of the source values.
 * Throws on a path that does not address a string the source has — the
 * translator answering for something it was not offered is refused like
 * the page structural lock refuses an invented slot.
 */
export function applyStrings(
  values: Readonly<Record<string, unknown>>,
  strings: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const out = structuredClone(values) as Record<string, unknown>;
  for (const [path, text] of Object.entries(strings)) {
    const m = PATH_RE.exec(path);
    const field = m?.[1];
    if (!m || field === undefined) throw new Error(`chrome translation: malformed path "${path}"`);
    if (m[2] === undefined) {
      if (typeof out[field] !== "string")
        throw new Error(`chrome translation: no text at "${path}"`);
      out[field] = text;
      continue;
    }
    const list = out[field];
    const i = Number(m[2]);
    if (!Array.isArray(list) || i >= list.length) {
      throw new Error(`chrome translation: no list item at "${path}"`);
    }
    if (m[3] === "label") {
      const item = list[i] as Record<string, unknown> | null;
      if (!item || typeof item.label !== "string") {
        throw new Error(`chrome translation: no link label at "${path}"`);
      }
      list[i] = { ...item, label: text };
    } else {
      if (typeof list[i] !== "string") throw new Error(`chrome translation: no text at "${path}"`);
      list[i] = text;
    }
  }
  return out;
}

/** Stable fingerprint of a target's source content (staleness check). */
export function sourceFingerprint(
  fields: readonly ChromeField[],
  values: Readonly<Record<string, unknown>>,
): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  const text = JSON.stringify(stable({ fields, values }));
  // djb2 — a change detector, not a security boundary.
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `djb2:${(h >>> 0).toString(16)}:${text.length}`;
}

/** What to do with one internal link on a page of a given language. */
export type LinkMapping = { href: string } | { problem: string } | null;

/**
 * Rewrite every internal link in `values` through `mapHref`: link-list
 * hrefs (recognised by shape, so a swapped-in module's menu is covered
 * too) and url/link fields. `null` keeps a link as it is.
 */
export function mapLinks(
  fields: readonly ChromeField[],
  values: Readonly<Record<string, unknown>>,
  mapHref: (href: string) => LinkMapping,
): { values: Record<string, unknown>; changed: boolean; problems: string[] } {
  const out = structuredClone(values) as Record<string, unknown>;
  const problems: string[] = [];
  let changed = false;
  const kindOf = new Map(fields.map((f) => [f.name, f.kind]));
  const apply = (href: string): string => {
    const r = mapHref(href);
    if (r === null) return href;
    if ("problem" in r) {
      problems.push(r.problem);
      return href;
    }
    if (r.href !== href) changed = true;
    return r.href;
  };
  for (const [name, v] of Object.entries(out)) {
    if (typeof v === "string" && LINK_KINDS.has(kindOf.get(name) ?? "")) {
      out[name] = apply(v);
    } else if (Array.isArray(v)) {
      out[name] = v.map((item) => {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as { href?: unknown }).href === "string"
        ) {
          const it = item as Record<string, unknown> & { href: string };
          return { ...it, href: apply(it.href) };
        }
        return item;
      });
    }
  }
  return { values: out, changed, problems };
}

/** Split an internal href into its path and the `?query#hash` suffix. */
export function splitHref(href: string): { path: string; suffix: string } | null {
  if (!href.startsWith("/") || href.startsWith("//")) return null;
  const cut = href.search(/[?#]/);
  return cut === -1
    ? { path: href, suffix: "" }
    : { path: href.slice(0, cut), suffix: href.slice(cut) };
}

/** `/de/preise/` and `/de/preise` name the same page. */
export function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

// ---------------------------------------------------------------------------
// Translation prompt + contract — one AI call for a locale's whole chrome.
// ---------------------------------------------------------------------------

/** One chrome target offered to the translator. */
export interface ChromeTranslationTarget {
  readonly id: string;
  /** Operator-facing description ("Footer (layout default, block footer)"). */
  readonly label: string;
  readonly strings: readonly TranslatableString[];
}

/** The translator's answer: every offered path of every offered target. */
export const chromeTranslationPayload = z
  .object({
    targets: z.array(
      z
        .object({
          target: z.string().min(1),
          strings: z.record(z.string(), z.string()),
        })
        .strict(),
    ),
  })
  .strict();

export type ChromeTranslationPayload = z.infer<typeof chromeTranslationPayload>;

/**
 * The whole chrome of the site in one call — header, footer and menus
 * share vocabulary ("Pricing" in the menu and in the footer must agree),
 * which is the same reason a page is never translated sentence by
 * sentence.
 */
export function buildChromeTranslationPrompt(input: {
  sourceLocale: string;
  targetLocale: string;
  targetLocaleDisplayName: string;
  targets: readonly ChromeTranslationTarget[];
  glossaryBlock: string;
  styleGuideBlock: string;
}): { system: string; user: string } {
  const system = [
    "You are translating the shared chrome of a website — navigation menus, header, footer and other content that appears on many pages.",
    `Source locale: ${input.sourceLocale}.`,
    `Target locale: ${input.targetLocale} (${input.targetLocaleDisplayName}).`,
    "",
    "Translate every string listed below. Menu labels stay short (navigation labels, not sentences); keep the same term for the same thing across targets. Preserve HTML tags and attributes inside a string verbatim.",
    "",
    'Respond with a JSON object matching: {"targets": [{"target": "<the target id from the heading, copied EXACTLY — e.g. c0>", "strings": {"<path, copied exactly>": "<translated string>", ...}}, ...]}. Return EVERY target and EVERY path listed — nothing more.',
    input.glossaryBlock,
    input.styleGuideBlock,
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  const user = [
    `# Site chrome (${input.sourceLocale} → ${input.targetLocale})`,
    "",
    ...input.targets.map((t) =>
      [
        `### Target ${t.id} (${t.label})`,
        ...t.strings.map((s) => `${s.path}:\n\`\`\`\n${s.text}\n\`\`\``),
      ].join("\n"),
    ),
  ].join("\n\n");
  return { system, user };
}

/** Exactly the offered targets and paths — anything else is refused. */
export function validateChromeTranslation(
  payload: ChromeTranslationPayload,
  targets: readonly ChromeTranslationTarget[],
): void {
  const offered = new Map(targets.map((t) => [t.id, new Set(t.strings.map((s) => s.path))]));
  const seen = new Set<string>();
  for (const t of payload.targets) {
    const paths = offered.get(t.target);
    if (!paths) {
      throw new Error(
        `chrome translation: response uses target id "${t.target}", which was not offered (valid: ${[...offered.keys()].join(", ")}) — refusing to apply`,
      );
    }
    if (seen.has(t.target)) throw new Error(`chrome translation: duplicate target ${t.target}`);
    seen.add(t.target);
    for (const p of Object.keys(t.strings)) {
      if (!paths.has(p)) {
        throw new Error(
          `chrome translation: target ${t.target} answers path "${p}", which was not offered`,
        );
      }
    }
    for (const p of paths) {
      if (!(p in t.strings)) {
        throw new Error(`chrome translation: target ${t.target} is missing path "${p}"`);
      }
    }
  }
  for (const id of offered.keys()) {
    if (!seen.has(id)) throw new Error(`chrome translation: response is missing target ${id}`);
  }
}
