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
 * are not this module's business: they are stored as page references
 * (`caelo:page/<id>`, epic #724) and core resolves each one at RENDER
 * time to the target's version in the rendering page's language, through
 * the link-resolve composition point this plugin answers (`link_resolve`
 * in ./index.ts). A renamed or newly translated page is picked up
 * without re-translating the menu; a link whose target has no version in
 * the page's language is flagged by core, never left pointing at another
 * language.
 */

import { type ListTypeDef, z } from "@caelo-cms/plugin-sdk";
import { isTranslatableField } from "./list-translation.js";
import { stableJson } from "./stable-json.js";

/** A field as the chrome helpers need it. */
export interface ChromeField {
  readonly name: string;
  readonly kind: string;
  /** `list` fields: the list type slug (pages.list_shared_content carries it). */
  readonly listType?: string;
  /** `list` fields: local (entries in the value), shared or source. */
  readonly bind?: "local" | "shared" | "source";
}

/** Field kinds whose string value is human-readable text. */
const TEXT_KINDS = new Set(["text", "richtext"]);

/**
 * How the chrome helpers treat `list` fields (epic #1107).
 *
 * A layout placement's local list lives in the module's field defaults,
 * which have no value address — its entries are translated with the
 * placement's chrome variant, field by field from the list type. A
 * shared content instance's local list HAS addresses
 * (`instance/<id>/<field>/item/…`): it is translated by address through
 * the list-resolve overlay (./list-translation.ts), so the chrome
 * variant leaves it out and keeps rendering the source entries.
 */
export interface ChromeListContext {
  /** List types by slug (`list_types.list`). */
  readonly listTypes: ReadonlyMap<string, ListTypeDef>;
  /** Whether this placement's local lists belong to its chrome variant. */
  readonly includeLists: boolean;
}

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
  /** `field`, or `field[<entry id>].<key>` for a local list entry's text. */
  readonly path: string;
  readonly text: string;
}

interface ListEntryLike {
  readonly id?: unknown;
  readonly node?: string;
  readonly values?: Readonly<Record<string, unknown>>;
  readonly children?: unknown;
}

/** Depth-first visit of local list entries (`{ id, values, children }`). */
function walkEntries(items: unknown, visit: (entry: ListEntryLike & { id: string }) => void): void {
  if (!Array.isArray(items)) return;
  for (const raw of items as ListEntryLike[]) {
    if (!raw || typeof raw.id !== "string") continue;
    visit(raw as ListEntryLike & { id: string });
    walkEntries(raw.children, visit);
  }
}

/**
 * Every human-readable string in a placement's values: text/richtext
 * fields and — when `lists.includeLists` — the translatable fields of
 * local list entries, as their list type declares them. Addresses,
 * numbers and nested module references are not text — a placement with
 * none of these needs no locale variant.
 *
 * @throws when a local list names a list type the site does not have:
 *   which entry keys are text is the type's to say, never a guess.
 */
export function translatableStrings(
  fields: readonly ChromeField[],
  values: Readonly<Record<string, unknown>>,
  lists: ChromeListContext,
): TranslatableString[] {
  const out: TranslatableString[] = [];
  for (const f of fields) {
    const v = values[f.name];
    if (TEXT_KINDS.has(f.kind) && typeof v === "string" && v.trim().length > 0) {
      out.push({ path: f.name, text: v });
    } else if (f.kind === "list" && lists.includeLists && (f.bind ?? "local") === "local") {
      if (!Array.isArray(v)) continue;
      const type = f.listType ? lists.listTypes.get(f.listType) : undefined;
      if (!type) {
        throw new Error(
          `chrome translation: list field "${f.name}" uses list type "${f.listType ?? "(none)"}", which the site does not have — fix the module's field (list_list_types shows the types)`,
        );
      }
      walkEntries(v, (entry) => {
        const node = type.nodes[entry.node ?? ""];
        for (const nf of node?.fields ?? []) {
          const text = entry.values?.[nf.name];
          if (isTranslatableField(nf) && typeof text === "string" && text.trim().length > 0) {
            out.push({ path: `${f.name}[${entry.id}].${nf.name}`, text });
          }
        }
      });
    }
  }
  return out;
}

const PATH_RE = /^([^[\]]+)(?:\[([0-9a-f-]{36})\]\.([a-z][a-z0-9_]*))?$/;

/**
 * Write translated strings back into a deep copy of the source values.
 * Throws on a path that does not address a string the source has — the
 * translator answering for something it was not offered is refused like
 * the page structural lock refuses an invented slot (which paths were
 * offered is checked before, by {@link validateChromeTranslation}).
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
    const itemId = m[2];
    const key = m[3] as string;
    let hit: { values?: Record<string, unknown> } | null = null;
    walkEntries(out[field], (entry) => {
      if (entry.id === itemId) hit = entry as { values?: Record<string, unknown> };
    });
    const found = hit as { values?: Record<string, unknown> } | null;
    if (!found?.values || typeof found.values[key] !== "string") {
      throw new Error(`chrome translation: no list entry text at "${path}"`);
    }
    // `out` is a deep copy, so the entry can be written in place.
    found.values[key] = text;
  }
  return out;
}

/** Stable fingerprint of a target's source content (staleness check). */
export function sourceFingerprint(
  fields: readonly ChromeField[],
  values: Readonly<Record<string, unknown>>,
): string {
  const text = stableJson({ fields, values });
  // djb2 — a change detector, not a security boundary.
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `djb2:${(h >>> 0).toString(16)}:${text.length}`;
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
 * #992 — the JSON Schema `ctx.ai.generateObject` constrains a chrome answer
 * to (CLAUDE.md §12), built per call from what is offered: each answered
 * target is one of the offered ids with exactly its own paths, all
 * required, nothing else. The wire shape is {@link chromeTranslationPayload}
 * unchanged, so the same Zod parse and {@link validateChromeTranslation}
 * check every answer — the install's model and a Power-MCP agent's alike.
 * That every offered target is answered stays the validator's job:
 * structured-output decoders do not enforce `minItems` above 1.
 */
export function chromeTranslationJsonSchema(
  targets: readonly ChromeTranslationTarget[],
): Record<string, unknown> {
  const answerFor = (t: ChromeTranslationTarget) => ({
    type: "object",
    additionalProperties: false,
    required: ["target", "strings"],
    properties: {
      target: {
        type: "string",
        enum: [t.id],
        description: `The target id from the "### Target ${t.id}" heading.`,
      },
      strings: {
        type: "object",
        additionalProperties: false,
        required: t.strings.map((s) => s.path),
        properties: Object.fromEntries(
          t.strings.map((s) => [s.path, { type: "string", description: "The translated string." }]),
        ),
      },
    },
  });
  return {
    type: "object",
    additionalProperties: false,
    required: ["targets"],
    properties: {
      targets: {
        type: "array",
        description: "One entry per offered target, each target once.",
        items: { anyOf: targets.map(answerFor) },
      },
    },
  };
}

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
