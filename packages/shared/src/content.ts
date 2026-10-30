// SPDX-License-Identifier: MPL-2.0

/**
 * Zod schemas for the Phase 3 content layer. Lives in @caelo-cms/shared so the
 * Validator (Query API ops) and the SvelteKit form actions can both import
 * from a single source.
 *
 * The Page schemas are `.strict()` — Zod rejects any extra key, which is how
 * the §3.1 "no raw HTML on pages" invariant is enforced *in code*: a payload
 * trying to set `html` on a page fails Zod parse before any handler runs.
 */

import { z } from "zod";
import { hasEscapedLineBreaks } from "./escaped-line-breaks.js";
import { DEFAULT_LIST_TYPES, SITE_TEXTS_LIST_TYPE } from "./lists/default-types.js";
import { listItemInputSchema } from "./lists/items.js";
import { LIST_MAX_ITEMS, sourceDefSchema } from "./lists/list-type.js";
import { pageTypeDefSchema } from "./lists/page-type.js";
import { listPaginationSchema } from "./lists/pagination.js";
import { LIST_REF_RE } from "./lists/refs.js";

/** Lowercase slug, hyphenated, 1–64 chars, no leading/trailing hyphen. */
export const slugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    "slug must be lowercase letters, digits, or hyphens (1–64 chars, no leading/trailing hyphen)",
  );

/**
 * v0.12.3 (issue #106) — derive a module's stable `type` from its
 * displayName. The `type` is the semantic class of a module (`button`,
 * `hero`, `pricing-card`) shared by every instance of that class — it is
 * what a parent module's `allowedModuleTypes` whitelist matches against.
 *
 * This is the slug *base* WITHOUT the `-<timestamp>` uniqueness suffix
 * that `slugify()` appends: a module's `slug` is its unique row identity
 * (`button-mpqxq3ch`), its `type` is the reusable class (`button`). The
 * tool-side `slugify` composes as `deriveModuleType(name) + "-" + suffix`
 * so the two can never diverge.
 *
 * Mirrors `slugify`'s normalization (lowercase, non-alphanumerics → single
 * hyphen, trim hyphens, 40-char cap, `"module"` stem fallback) so a
 * round-trip is predictable.
 */
export function deriveModuleType(displayName: string): string {
  const base = displayName
    .toLowerCase()
    // Collapse every run of non-alphanumerics to a SINGLE hyphen first, so the
    // string can never contain consecutive hyphens after this point.
    .replace(/[^a-z0-9]+/g, "-")
    // Cap BEFORE trimming the edge hyphen — trimming first then slicing could
    // truncate mid-token and leave a trailing hyphen (e.g. the 40th char is a
    // hyphen), which would make `slug = type + "-" + suffix` double-hyphenate.
    .slice(0, 40)
    // Trim a single leading/trailing hyphen. `^-|-$` (not `^-+|-+$`) is both
    // sufficient — the collapse above guarantees no `--` runs — and free of the
    // polynomial backtracking CodeQL flags on `-+$` over uncontrolled input.
    .replace(/^-|-$/g, "");
  return base.length > 0 ? base : "module";
}

/**
 * v0.12.3 (issue #106) — mint a unique module slug from a displayName:
 * the stable `type` base (`deriveModuleType`) + a base36 timestamp
 * suffix. Because the slug is always `type + "-" + suffix`, a module's
 * `type` is guaranteed to be a prefix of its `slug` — the two can never
 * drift. Shared by every module-minting AI tool so the rule lives in one
 * place.
 *
 * @param suffix - override the uniqueness suffix (defaults to a base36
 *   timestamp). Pass a stable value in tests for determinism.
 */
export function slugifyModuleName(
  displayName: string,
  suffix: string = Date.now().toString(36),
): string {
  return `${deriveModuleType(displayName)}-${suffix}`;
}

/**
 * v0.12.3 (issue #106) — slug for a module minted per page-section
 * (`build_page` / legacy compose). Includes the section index so two sections
 * sharing a displayName don't collide on the unique slug constraint.
 */
export function slugifyModuleSection(
  displayName: string,
  idx: number,
  suffix: string = Date.now().toString(36),
): string {
  return `${deriveModuleType(displayName)}-${idx}-${suffix}`;
}

const displayNameSchema = z.string().min(1).max(128);

/** Caps are arbitrary but cheap — paste-of-binary mistakes get caught. */
export const MODULE_HTML_MAX = 256 * 1024;
export const MODULE_CSS_MAX = 128 * 1024;
export const MODULE_JS_MAX = 256 * 1024;
export const TEMPLATE_HTML_MAX = 512 * 1024;
export const TEMPLATE_CSS_MAX = 128 * 1024;

/**
 * Code payloads a model sometimes corrupts before they reach us, both seen
 * in PR #1121's real-AI runs and stored verbatim before this guard:
 * - JSON-encoded: the whole value wrapped in quotes with `\"` escapes
 *   (`"<footer class=\"x\">…"`) — the page showed literal quotes;
 * - HTML-escaped markup: `&lt;div&gt;&lt;caelo-slot …` with no real tag
 *   — a template without a single slot, so it had no blocks at all.
 * Refusing at the write boundary with the fix turns a broken render the
 * AI only notices from a screenshot into one corrected call (CLAUDE.md
 * §2, §11; same reasoning as the CDATA guard below). AI tool arguments
 * never reach this in that shape: `sourceTextArg` decodes both encodings
 * first (`source-text-transport.ts`); this guards every other writer.
 */
export function jsonEncodedCodeMessage(field: string, value: string): string | null {
  const t = value.trim();
  if (t.length < 2 || !t.startsWith('"') || !t.endsWith('"')) return null;
  try {
    if (typeof JSON.parse(t) !== "string") return null;
  } catch {
    return null;
  }
  return `${field} is JSON-encoded (wrapped in quotes with \\" escapes) — send the raw ${field} itself, not a JSON string of it.`;
}

/** See {@link jsonEncodedCodeMessage}: markup sent HTML-escaped. */
export function htmlEscapedMarkupMessage(field: string, value: string): string | null {
  if (value.includes("<") || !/&lt;\/?[a-zA-Z]/.test(value)) return null;
  return `${field} is HTML-escaped (&lt;…&gt; instead of <…>) — send the markup itself, unescaped.`;
}

/**
 * See {@link jsonEncodedCodeMessage}: source whose line breaks arrived as
 * literal `\n` sequences (`hasEscapedLineBreaks`) — the page shows the
 * `\n` text and the CSS rules after it break. AI tool arguments are decoded
 * first (`decodeEscapedLineBreaks`); this guards every other writer. Module
 * js is checked by parsing it (admin-core `module-js-syntax.ts`), which
 * catches this and every other syntax error.
 */
export function escapedLineBreaksMessage(field: "html" | "css", value: string): string | null {
  if (!hasEscapedLineBreaks(value, field)) return null;
  return `${field} has its line breaks escaped (literal \\n sequences, no real line break) — send the ${field} with real line breaks.`;
}

const noCorruptMarkup = (field: "html") => (value: string, ctx: z.RefinementCtx) => {
  const message =
    jsonEncodedCodeMessage(field, value) ??
    htmlEscapedMarkupMessage(field, value) ??
    escapedLineBreaksMessage(field, value);
  if (message) ctx.addIssue({ code: "custom", message });
};
const noJsonEncodedCode = (field: string) => (value: string, ctx: z.RefinementCtx) => {
  const message = jsonEncodedCodeMessage(field, value);
  if (message) ctx.addIssue({ code: "custom", message });
};
const noCorruptCss = (value: string, ctx: z.RefinementCtx) => {
  const message = jsonEncodedCodeMessage("css", value) ?? escapedLineBreaksMessage("css", value);
  if (message) ctx.addIssue({ code: "custom", message });
};

const moduleHtml = z
  .string()
  .max(MODULE_HTML_MAX, `html exceeds ${MODULE_HTML_MAX} bytes`)
  .superRefine(noCorruptMarkup("html"));

/**
 * issue #432 root-cause guard — reject XML CDATA wrappers in module css/js.
 *
 * Module css/js is stored and served VERBATIM, so a `<![CDATA[ … ]]>`
 * wrapper (an XHTML-era idiom the AI occasionally reaches for when
 * "protecting" inline code) reaches the browser unparsed: the stylesheet
 * fails to apply and the script throws `SyntaxError: Unexpected token '<'`.
 * On e2e runs 31000584991 / 31000699422 (2026-08-05) exactly this landed
 * silently, the page rendered broken, and the model burned ~15–20 extra
 * loops (~+1.2M input tokens) discovering and repairing it via
 * screenshot/inspect/edit cycles. Rejecting at the write boundary with an
 * actionable message turns that repair spiral into a single corrected call
 * (CLAUDE.md §11 — failure surfaces are AI-actionable; §2 — fail loudly).
 *
 * css/js only: CDATA is never valid CSS or JS, while an html body may
 * legitimately carry CDATA inside inline `<svg>`/`<math>` foreign content.
 */
const CDATA_OPEN = "<![CDATA[";
const noCdata = (value: string): boolean => !value.includes(CDATA_OPEN);
const cdataMessage = (field: "css" | "js"): string =>
  `${field} contains an XML CDATA marker (${CDATA_OPEN}) — module ${field} is stored and served ` +
  `verbatim, so CDATA wrappers reach the browser unparsed and break rendering. ` +
  `Remove the wrapper: pass plain ${field === "css" ? "CSS" : "JavaScript"}.`;

const moduleCss = z
  .string()
  .max(MODULE_CSS_MAX, `css exceeds ${MODULE_CSS_MAX} bytes`)
  .refine(noCdata, cdataMessage("css"))
  .superRefine(noCorruptCss);
const moduleJs = z
  .string()
  .max(MODULE_JS_MAX, `js exceeds ${MODULE_JS_MAX} bytes`)
  .refine(noCdata, cdataMessage("js"))
  .superRefine(noJsonEncodedCode("js"));

/**
 * v0.4.0 — module field schema. Each field declares one substitution slot in
 * the module's templated HTML (`{{fieldName}}`) and the kind of content it
 * holds. Field values live on each page placement (v0.4.0: in
 * `page_module_content.content_values`; v0.12.0 onward: in
 * `content_instances.values`).
 *
 * v0.12.0 — extended to nine kinds. Primitive kinds (text/richtext/url/
 * image/number/boolean/link) substitute via `{{fieldName}}` placeholders.
 * The two new nested kinds reference another module by id + content_instance:
 *
 *   - `module` — single nested module reference. HTML slot syntax: `{{>fieldName}}`.
 *     Value shape: `{ moduleId, contentInstanceId }`.
 *   - `module-list` — ordered array of nested module references. HTML slot
 *     syntax: `{{#fieldName}}…inner…{{/fieldName}}` — `inner` renders once
 *     per element. Value shape: `Array<{ moduleId, contentInstanceId }>`.
 *
 * Schema is a discriminated union by `kind` so the validator rejects, e.g., a
 * `text` kind that carries `allowedModuleTypes` (which only nested kinds use)
 * or a `module-list` that carries a `default` (nested kinds populate from
 * referenced content_instances, not from defaults).
 */
export const MODULE_FIELD_PRIMITIVE_KINDS = [
  "text",
  "richtext",
  "url",
  "image",
  "number",
  "boolean",
  "link",
] as const;

/**
 * Epic #1107 — the data-list field kind (`docs/lists.md` §7). One kind
 * for every repeated piece of data: feature bullets, a footer link group,
 * a three-level menu, a mega dropdown, a "latest news" block. The entry
 * shape comes from a LIST TYPE (`listType`, a slug); the entries come from
 * the field's binding:
 *
 *   - `local`  (default) — entries stored in the placement's value
 *                          (`ListItem[]`), only this module shows them;
 *   - `shared` — a `caelo:list/<id>` list, fixed on the field (`list`) or
 *                chosen per placement; navigation and anything needed in
 *                more than one place;
 *   - `source` — entries generated per page from `source` (a page query,
 *                a system source like breadcrumbs, a plugin source).
 *
 * The template iterates `{{#field}}…{{/field}}` the same way for every
 * binding. `module-list` stays: it composes modules, lists carry data.
 * Replaces the `text-list` / `link-list` kinds.
 */
export const MODULE_FIELD_LIST_KINDS = ["list"] as const;

export const MODULE_FIELD_NESTED_KINDS = ["module", "module-list"] as const;

/** Every module field kind. */
export const MODULE_FIELD_KINDS = [
  ...MODULE_FIELD_PRIMITIVE_KINDS,
  ...MODULE_FIELD_LIST_KINDS,
  ...MODULE_FIELD_NESTED_KINDS,
] as const;

/**
 * Canonical union of every field kind — used by callers that need to
 * type a single `kind` field (e.g. the shared template engine's
 * `TemplateField.kind`, the static-gen field parser). Importing this
 * instead of `string` catches typos like `'tetx-list'` at compile time.
 */
export type ModuleFieldKind = (typeof MODULE_FIELD_KINDS)[number];

/**
 * Field kinds the shared template engine iterates via the
 * `{{#name}}…{{/name}}` Mustache-section operator (`list` and
 * `module-list`); the engine's section-dispatch keys off it
 * (`packages/shared/src/template-engine.ts`).
 */
export const MODULE_FIELD_SECTION_KINDS = [...MODULE_FIELD_LIST_KINDS, "module-list"] as const;

const moduleFieldName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, "name must be snake_case");
const moduleFieldLabel = z.string().min(1).max(128);

const moduleFieldPrimitiveSchema = z
  .object({
    name: moduleFieldName,
    kind: z.enum(MODULE_FIELD_PRIMITIVE_KINDS),
    label: moduleFieldLabel,
    /** Default value used when a placement's content_instance has no override. */
    default: z.unknown().optional(),
  })
  .strict();

const moduleFieldModuleSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("module"),
    label: moduleFieldLabel,
    /**
     * Optional whitelist of module *types* that may fill this slot (the
     * stable `modules.type` class, e.g. `button` — NOT the unique
     * `modules.slug` like `button-mpqxq3ch`). When absent, any module is
     * permitted. The op-layer validator enforces the whitelist against
     * the referenced module's `type` at `content_instances.set_values`
     * time. v0.12.3 (issue #106) renamed this from `allowedModuleSlugs`:
     * an exact-slug whitelist could never match an AI-minted module
     * because every minted slug carries a uniqueness suffix.
     */
    allowedModuleTypes: z.array(slugSchema).max(32).optional(),
  })
  .strict();

const moduleFieldModuleListSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("module-list"),
    label: moduleFieldLabel,
    /** v0.12.3 (issue #106) — whitelist of stable module `type`s (not
     *  unique slugs). See `moduleFieldModuleSchema.allowedModuleTypes`. */
    allowedModuleTypes: z.array(slugSchema).max(32).optional(),
    /** Minimum count of elements. Validator enforces at write time. */
    min: z.number().int().nonnegative().optional(),
    /** Maximum count of elements. Validator enforces at write time. */
    max: z.number().int().positive().max(256).optional(),
  })
  .strict();

/**
 * Epic #1107 — a `list` field (`docs/lists.md` §7). The static schema
 * checks the SHAPE: the binding's parts fit together and a local default
 * is well-formed entries. Whether those entries fit the named list type
 * (nodes, fields, depth) needs the type, which is stored data — the op
 * layer validates that with `validateListItems` when the module is
 * written, and the renderer reports `list-type-missing:<slug>` for a type
 * that is gone.
 */
/** The shipped list types, quoted, for the missing-listType message. */
const SHIPPED_LIST_TYPE_SLUGS = [...DEFAULT_LIST_TYPES.map((t) => t.slug), SITE_TEXTS_LIST_TYPE]
  .map((slug) => `"${slug}"`)
  .join(", ");

const moduleFieldListSchema = z
  .object({
    name: moduleFieldName,
    kind: z.literal("list"),
    label: moduleFieldLabel,
    /**
     * Slug of the list type that defines the entries. REQUIRED — a missing
     * one says which types exist (#1190), not just "expected string".
     */
    listType: z
      .string({
        error: (iss) =>
          iss.input === undefined
            ? `a list field needs listType: ${SHIPPED_LIST_TYPE_SLUGS} or a custom type's slug (list_list_types shows them)`
            : undefined,
      })
      .regex(
        /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
        "slug must be lowercase letters, digits, or hyphens (1–64 chars, no leading/trailing hyphen)",
      ),
    bind: z.enum(["local", "shared", "source"]).optional(),
    /** `bind: "shared"` — fix the list for every placement (`caelo:list/<id>`). */
    list: z.string().regex(LIST_REF_RE, "list must be caelo:list/<id>").optional(),
    /** `bind: "source"` — where generated entries come from. */
    source: sourceDefSchema.optional(),
    /**
     * #1257 — list EVERY match across follow-up pages (`<path>/page/<n>/`)
     * instead of cutting at `limit`: a query or the term_pages source.
     * `per_page` (1..50, default 50) and `follow_ups` (`index` default |
     * `noindex`) are defaults a placement may override with its own
     * `paginate`. At most one paginated field per module.
     */
    paginate: listPaginationSchema.optional(),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().positive().max(LIST_MAX_ITEMS).optional(),
    /** `local`: entries; `shared`: `caelo:list/<id>`. */
    default: z
      .union([
        z.array(listItemInputSchema),
        z.string().regex(LIST_REF_RE, "a shared default must be caelo:list/<id>"),
      ])
      .optional(),
  })
  .strict();

/** Binding consistency of one `list` field; every problem, AI-actionable. */
function listFieldIssues(f: z.infer<typeof moduleFieldListSchema>): string[] {
  const bind = f.bind ?? "local";
  const issues: string[] = [];
  if (bind === "source" && f.source === undefined) {
    issues.push(`list field "${f.name}": bind "source" needs a source (query, system or plugin).`);
  }
  if (bind !== "source" && f.source !== undefined) {
    issues.push(`list field "${f.name}": source is only allowed with bind "source".`);
  }
  if (bind === "local" && f.list !== undefined) {
    issues.push(
      `list field "${f.name}": list is only allowed with bind "shared" — a local list stores its entries in the placement.`,
    );
  }
  if (bind === "source" && f.list !== undefined && f.source?.kind !== "system") {
    issues.push(
      `list field "${f.name}": list on a source field names the vocabulary of a page_terms source only.`,
    );
  }
  if (f.default !== undefined) {
    if (bind === "local" && typeof f.default === "string") {
      issues.push(
        `list field "${f.name}": a local default is an array of entries, not a list reference.`,
      );
    }
    if (bind === "shared" && Array.isArray(f.default)) {
      issues.push(
        `list field "${f.name}": a shared default is caelo:list/<id> — create the list with upsert_lists_many first.`,
      );
    }
    if (bind === "source") {
      issues.push(
        `list field "${f.name}": a source field has no default; its entries are generated.`,
      );
    }
  }
  if (f.min !== undefined && f.max !== undefined && f.min > f.max) {
    issues.push(`list field "${f.name}": min is greater than max.`);
  }
  if (f.paginate !== undefined) issues.push(...paginateIssues(f));
  return issues;
}

/**
 * #1257 — a paginated field lists a page query (or term_pages) across
 * follow-up pages; its page size replaces the query's `limit`.
 */
function paginateIssues(f: z.infer<typeof moduleFieldListSchema>): string[] {
  const where = `list field "${f.name}"`;
  const src = f.source;
  const pageable =
    (f.bind ?? "local") === "source" &&
    (src?.kind === "query" || (src?.kind === "system" && src.name === "term_pages"));
  if (!pageable) {
    return [
      `${where}: paginate needs bind "source" with a query or the term_pages source — an overview of pages. Remove paginate, or bind the field to {kind:"query", …}.`,
    ];
  }
  if (
    src?.kind === "query" &&
    (src.defaults.limit !== undefined || src.editable.includes("limit"))
  ) {
    return [
      `${where}: a paginated query takes its page size from paginate.per_page — remove "limit" from source.defaults and source.editable.`,
    ];
  }
  return [];
}

export const moduleFieldSchema = z.discriminatedUnion("kind", [
  moduleFieldPrimitiveSchema,
  moduleFieldListSchema,
  moduleFieldModuleSchema,
  moduleFieldModuleListSchema,
]);
export type ModuleField = z.infer<typeof moduleFieldSchema>;

/**
 * The shape of a single nested-module reference inside `content_instances.values`
 * when the field's kind is `module` or — repeated inside an array — `module-list`.
 */
export const moduleRefSchema = z
  .object({
    moduleId: z.string().uuid(),
    contentInstanceId: z.string().uuid(),
  })
  .strict();
export type ModuleRef = z.infer<typeof moduleRefSchema>;

/**
 * CLAUDE.md §1A — "repeating content is a list field, never numbered
 * scalars". This guard rejects the mechanically detectable half of that
 * rule: a RUN of 3+ sibling scalar fields sharing a base name plus a
 * numeric suffix (`label`, `label2`, `label3` / `quote_1`…`quote_3`).
 *
 * Threshold is 3 (issue #417): a two-field split (`col1`/`col2` for a
 * two-column layout) is routinely a genuine layout role, so a pair stays
 * legal; three-or-more numbered siblings is repeating content that must
 * be ONE list field. The bare base name counts as an implicit member of
 * its run — `label` next to `label2`/`label3` is item 1 in disguise.
 *
 * Deliberately out of scope (guidance-only, per the issue): content-
 * derived names (`quote_justamazing`) and mid-name numbering
 * (`step1_title`) — neither is detectable without false positives.
 * Nested/list kinds are excluded too: a numbered run of lists is
 * already a modelling question, not scalar fanout. The server-side
 * extractor fallback (`extract-module-structure.ts`) is also
 * unguarded on purpose: it numbers repeated tags in messy HUMAN-
 * authored HTML, runs only when the caller declared no fields, and its
 * output never re-enters this schema — the guard polices the boundary
 * where the AI (or a human) AUTHORS `fields[]` explicitly.
 */
const NUMBERED_SCALAR_FANOUT_THRESHOLD = 3;
const numberedFieldName = /^([a-z][a-z0-9_]*?)_?\d+$/;

function findNumberedScalarFanoutRuns(
  fields: readonly { name: string; kind: string }[],
): string[][] {
  const scalarKinds = new Set<string>(MODULE_FIELD_PRIMITIVE_KINDS);
  const scalarNames = fields.filter((f) => scalarKinds.has(f.kind)).map((f) => f.name);
  const byBase = new Map<string, string[]>();
  for (const name of scalarNames) {
    const m = numberedFieldName.exec(name);
    const base = m?.[1];
    if (base === undefined) continue;
    const members = byBase.get(base);
    if (members) members.push(name);
    else byBase.set(base, [name]);
  }
  const runs: string[][] = [];
  for (const [base, members] of byBase) {
    const run = scalarNames.includes(base) ? [base, ...members] : members;
    if (run.length >= NUMBERED_SCALAR_FANOUT_THRESHOLD) runs.push(run);
  }
  return runs;
}

const moduleFieldsArray = z
  .array(moduleFieldSchema)
  .max(64, "modules may declare at most 64 fields")
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    for (const f of arr) {
      if (seen.has(f.name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate field name: ${f.name}` });
        return;
      }
      seen.add(f.name);
      if (f.kind === "list") {
        for (const message of listFieldIssues(f)) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message });
        }
      }
    }
    const paginated = arr.filter((f) => f.kind === "list" && f.paginate !== undefined);
    if (paginated.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `only one paginated list field per module (${paginated.map((f) => `"${f.name}"`).join(", ")}) — a page has one page sequence. Keep paginate on the overview's main list; give the others a limit.`,
      });
    }
    for (const run of findNumberedScalarFanoutRuns(arr)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `numbered-scalar fanout: ${run.map((n) => `"${n}"`).join(", ")} repeat one role as ` +
          "numbered scalar fields — repeating content is ONE list field, never numbered scalars " +
          '(CLAUDE.md §1A). Replace the run with a single field: kind "list" with a list type ' +
          '(listType "texts" for plain strings — the template iterates {{#f}}{{text}}{{/f}}; ' +
          '"links" for label + link — {{#f}}<a href="{{link}}">{{label}}</a>{{/f}}), or ' +
          '"module-list" (rich per-item structure: mint a card sub-module and reference it per ' +
          "item — in build_page, author the card detached with `ref` and pass " +
          '[{"$ref": "<ref>"}, …] as the field value). A two-field split like col1/col2 is fine; ' +
          `${NUMBERED_SCALAR_FANOUT_THRESHOLD}+ numbered siblings is a list.`,
      });
    }
  });

/**
 * v0.12.0 — coarse role tag for the AI's `list_modules` catalog.
 * Constrained by `modules_kind_check` in migration 0095. Adding a
 * new kind means: (1) bump the SQL CHECK, (2) update this schema,
 * (3) update the add_module / build_page kind guidance so the AI knows when to use it.
 */
export const MODULE_KINDS = ["chrome", "hero", "content", "cta", "utility"] as const;
export const moduleKindSchema = z.enum(MODULE_KINDS);
export type ModuleKind = (typeof MODULE_KINDS)[number];

/**
 * v0.12.0 — description is `.default("")` at the Zod boundary so the
 * 82+ legacy callers in tests/seed scripts keep working unchanged.
 * AI tool descriptions (add_module / build_page / update_modules_many) require the AI
 * to supply a real description explicitly — see CLAUDE.md §1A.
 */
const moduleDescription = z.string().max(1000);

export const moduleCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    description: moduleDescription.default(""),
    kind: moduleKindSchema.default("content"),
    /**
     * v0.12.3 (issue #106) — stable semantic class shared by every
     * instance of this module (`button`, `pricing-card`). What a parent
     * module's `allowedModuleTypes` whitelist matches against. Optional:
     * when omitted, `modules.create` derives it from `displayName` via
     * `deriveModuleType()`. Pass it explicitly to reuse an existing
     * class (e.g. a second `button` variant should share `type: "button"`).
     */
    type: slugSchema.optional(),
    html: moduleHtml,
    css: moduleCss.default(""),
    js: moduleJs.default(""),
    fields: moduleFieldsArray.default([]),
  })
  .strict();

export const moduleUpdateSchema = z
  .object({
    moduleId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    description: moduleDescription.optional(),
    kind: moduleKindSchema.optional(),
    /** v0.12.3 (issue #106) — re-classify a module's stable `type`. */
    type: slugSchema.optional(),
    html: moduleHtml.optional(),
    css: moduleCss.optional(),
    js: moduleJs.optional(),
    fields: moduleFieldsArray.optional(),
  })
  .strict();

/** A page type slug (epic #1107, docs/lists.md §5). */
export const pageTypeSlugSchema = z
  .string()
  .regex(
    /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
    "page type slug: lowercase letters, digits, hyphens",
  );

/**
 * #1276 — slugs a new page type is deliberately distinct from: the
 * duplicate guard refuses a new type whose slug normalises to an existing
 * one (`blogs` next to `blog`) unless the caller names it here.
 */
export const pageTypeDistinctFromSchema = z.array(pageTypeSlugSchema).max(16);

/**
 * #1276 — a page type created together with its first template
 * (`templates.create` `newPageType`): the definition without `templates`
 * and `defaultTemplate`, which are the new template.
 */
export const newPageTypeSchema = pageTypeDefSchema
  .omit({ templates: true, defaultTemplate: true })
  .extend({ distinctFrom: pageTypeDistinctFromSchema.optional() })
  .strict();
export type NewPageTypeInput = z.infer<typeof newPageTypeSchema>;

export const templateCreateSchema = z
  .object({
    slug: slugSchema,
    displayName: displayNameSchema,
    /**
     * Epic #1107 / #1276 — the page type this template serves. Exactly one
     * of `pageType` (an existing type's slug: the template is appended to
     * its `templates`) and `newPageType` (a new type created in the same
     * transaction with this template as its `defaultTemplate`) is
     * required; `templates.create` refuses neither or both.
     */
    pageType: pageTypeSlugSchema.optional(),
    newPageType: newPageTypeSchema.optional(),
    html: z
      .string()
      .max(TEMPLATE_HTML_MAX, `html exceeds ${TEMPLATE_HTML_MAX} bytes`)
      .superRefine(noCorruptMarkup("html")),
    css: z.string().max(TEMPLATE_CSS_MAX, `css exceeds ${TEMPLATE_CSS_MAX} bytes`).default(""),
    /**
     * P6.7.6 — every template binds to one layout. When omitted, the
     * handler resolves to `site_defaults.default_layout_id` at create
     * time. (Stored data, not a render-time fallback — see CLAUDE.md §2.)
     */
    layoutId: z.string().uuid().optional(),
    /**
     * Optional block-set metadata — SYMMETRIC with `create_layout` and
     * `propose_update_template`, which both take `blocks`. Omit it and the
     * handler auto-derives one block per `<caelo-slot name="X">` in `html`
     * (displayName = name, position = order of appearance) — the common case.
     * Pass it to give blocks a nicer `displayName` or an explicit `position`;
     * every entry's `name` MUST match a `<caelo-slot>` in `html` (a block with
     * no slot renders nothing), else the create fails loudly (CLAUDE.md §2).
     */
    blocks: z
      .array(
        z.object({
          name: z.string().min(1).max(80),
          displayName: z.string().min(1).max(200),
          position: z.number().int().min(0).max(1000),
        }),
      )
      .optional(),
  })
  .strict();

export const templateBlockSchema = z
  .object({
    name: slugSchema,
    displayName: displayNameSchema,
    position: z.number().int().nonnegative(),
  })
  .strict();

export const templateUpdateSchema = z
  .object({
    templateId: z.string().uuid(),
    displayName: displayNameSchema.optional(),
    /** Epic #1107 — also allow this template for the page type (slug); appended to its `templates`. */
    pageType: pageTypeSlugSchema.optional(),
    html: z.string().max(TEMPLATE_HTML_MAX).superRefine(noCorruptMarkup("html")).optional(),
    css: z.string().max(TEMPLATE_CSS_MAX).optional(),
    /** P6.7.6 — re-point the template to a different layout. */
    layoutId: z.string().uuid().optional(),
    /**
     * v0.2.65 — Optional block-set replacement. When present, the
     * update atomically applies the provided block list to
     * `template_blocks` (DELETE-then-INSERT, same path as
     * `template_blocks.set`). Critical for AI-driven flows: the AI's
     * `propose_update_template` previously only wrote the html string
     * and never touched the block table, so an approved proposal that
     * added `<!-- block:content -->` markup left the page unable to
     * find a "content" block. Allowing blocks here lets one
     * propose+execute round add both the markup AND the block
     * definition atomically.
     */
    blocks: z.array(templateBlockSchema).optional(),
  })
  .strict();

export const templateBlocksSetSchema = z
  .object({
    templateId: z.string().uuid(),
    blocks: z.array(templateBlockSchema),
  })
  .strict();

export const pageStatusSchema = z.enum(["draft", "published"]);

/** `pages.short_title` (#1142): a crumb-sized public label, never blank. */
export const pageShortTitleSchema = z
  .string()
  .trim()
  .min(1, "the short title is the page's breadcrumb label and cannot be blank")
  // Same bound as the title it is backfilled and defaulted from, so every
  // stored page stays editable; keeping it crumb-sized is guidance.
  .max(256);

/**
 * Page payloads are `.strict()` — passing an `html` field is rejected by Zod
 * before the handler runs. This is the §3.1 "no raw HTML on pages" invariant
 * at the Validator boundary, complementing the schema-level guarantee that
 * the `pages` table has no `html` column.
 */
export const pageCreateSchema = z
  .object({
    slug: slugSchema,
    title: z.string().min(1).max(256),
    /**
     * #1142 — the page's public label in breadcrumbs, navigation and the
     * page picker ("Pricing" for "Pricing for teams of every size").
     * Omitted = the create-time resolver stores `title` (stored data).
     */
    shortTitle: pageShortTitleSchema.optional(),
    /**
     * Optional: one of the page type's templates; omitted = the type's
     * `defaultTemplate`. Without `pageType` it must belong to exactly one
     * page type, which the page then gets (#1276).
     */
    templateId: z.string().uuid().optional(),
    /**
     * Optional — omit to let `pages.create` pick a context-aware default:
     * `published` on a bootstrap site (0 live published pages), else
     * `draft`. A bootstrap homepage MUST ship or the first Stage has
     * nothing to serve ("0 published pages for env='staging'"). Pass an
     * explicit value to override. (Was `.default("draft")`, which silently
     * left the first page unpublished.)
     */
    status: pageStatusSchema.optional(),
    /**
     * 0263 — nested page URLs: create the page under this parent; its URL
     * becomes "<parent's path>/<slug>". Omit (or null) for a top-level page.
     */
    parentPageId: z.string().uuid().nullable().optional(),
    /**
     * Epic #1107 — what the page IS (page type slug). Required unless
     * `templateId` belongs to exactly one page type; there is no stored
     * default type (#1276), so a create with neither is refused.
     */
    pageType: pageTypeSlugSchema.optional(),
    /** Property values, validated against the page type. */
    properties: z.record(z.string(), z.unknown()).optional(),
    /** Terms (`caelo:term/<listId>/<itemId>`) from the page type's vocabularies. */
    terms: z.array(z.string().max(120)).max(100).optional(),
  })
  .strict();

/**
 * 0263 — `pages.move_many`: reparent pages (their whole subtrees move
 * with them) and optionally rename them in the same step.
 */
export const pageMoveSchema = z
  .object({
    pageId: z.string().uuid(),
    /** The new parent page, or null for the top level. */
    parentPageId: z.string().uuid().nullable(),
    /** Rename while moving — required when the target URL is taken. */
    newSlug: slugSchema.optional(),
  })
  .strict();

export const pagesMoveManySchema = z
  .object({
    moves: z.array(pageMoveSchema).min(1).max(200),
    /** `'skip'` suppresses the 301s from the old URLs (operator asked for 404s). */
    redirectFromOld: z.enum(["auto", "skip"]).default("auto"),
  })
  .strict();

export const pageUpdateSchema = z
  .object({
    pageId: z.string().uuid(),
    /**
     * Optional optimistic-concurrency token. When present, the op rejects
     * with HandlerError("Conflict") if the row's version no longer matches.
     * Routes that load the page first should always pass it back.
     */
    expectedVersion: z.number().int().nonnegative().optional(),
    title: z.string().min(1).max(256).optional(),
    /** #1142 — the breadcrumb / navigation label; see {@link pageCreateSchema}. */
    shortTitle: pageShortTitleSchema.optional(),
    slug: slugSchema.optional(),
    templateId: z.string().uuid().optional(),
    status: pageStatusSchema.optional(),
    /**
     * Only meaningful together with `slug`. A slug change moves the page's
     * public URL, so the op creates a 301 from the old path by default,
     * inside the same transaction as the slug write. Links on the site are
     * page references (epic #724) and follow the page without a rewrite;
     * the 301 is for links from outside the site.
     *
     * `'skip'` suppresses the redirect and is for the rare case where the
     * operator explicitly says the old URL should 404. Defaults to `'auto'`: silently dropping the 301 would strand
     * every inbound link, which is never a safe default (CLAUDE.md §2).
     */
    redirectFromOld: z.enum(["auto", "skip"]).optional(),
    /**
     * Epic #1107 — switch the page type (slug). The template must be one of
     * the type's templates (pass `templateId` too when it is not), and the
     * page's properties and terms must fit the new type.
     */
    pageType: pageTypeSlugSchema.optional(),
    /** Merged into the page's properties; `null` removes a property. */
    properties: z.record(z.string(), z.unknown()).optional(),
    /** Replaces the page's terms (`caelo:term/<listId>/<itemId>`). */
    terms: z.array(z.string().max(120)).max(100).optional(),
  })
  .strict();

export const pageSetModulesSchema = z
  .object({
    pageId: z.string().uuid(),
    expectedVersion: z.number().int().nonnegative().optional(),
    blocks: z.array(
      z
        .object({
          blockName: slugSchema,
          moduleIds: z.array(z.string().uuid()),
          /**
           * #1195 — the placement each entry of `moduleIds` IS, by its
           * content instance (same index; null = a new placement). Given,
           * a placement keeps its content wherever it moves — across
           * blocks too — and two placements of one module never trade
           * content. Omitted, bindings carry over per (block, module) in
           * order, which cannot tell repeated placements apart.
           */
          contentInstanceIds: z.array(z.string().uuid().nullable()).optional(),
        })
        .strict()
        .refine(
          (b) =>
            b.contentInstanceIds === undefined ||
            b.contentInstanceIds.length === b.moduleIds.length,
          { message: "contentInstanceIds needs one entry (or null) per moduleIds entry" },
        ),
    ),
  })
  .strict();

export type ModuleCreateInput = z.infer<typeof moduleCreateSchema>;
export type ModuleUpdateInput = z.infer<typeof moduleUpdateSchema>;
export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;
export type TemplateBlocksSetInput = z.infer<typeof templateBlocksSetSchema>;
export type PageCreateInput = z.infer<typeof pageCreateSchema>;
export type PageUpdateInput = z.infer<typeof pageUpdateSchema>;
export type PageSetModulesInput = z.infer<typeof pageSetModulesSchema>;

// ─── v0.12.0 — content_instances ops ─────────────────────────────────

/**
 * v0.12.0 — content sync mode on a placement.
 *
 * `synced`   — editing the placement's content_instance propagates to
 *              every other placement bound to the same row.
 * `unsynced` — placement holds a private row. Default.
 */
export const syncModeSchema = z.enum(["synced", "unsynced"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

/**
 * `values` jsonb shape — keyed by module field name. Values are arbitrary
 * jsonb. For nested-module field kinds, the value satisfies `moduleRefSchema`
 * (single) or `moduleRefSchema[]` (list); the renderer + write-side validator
 * enforces shape against the module's declared `fields[]`.
 */
const contentValuesSchema = z.record(z.string(), z.unknown());

/**
 * v0.12.0 — why this row exists as a shared/reusable instance.
 * Shown by the AI's list_content_instances tool so the AI can decide
 * *reuse the synced row* vs *fork to unsynced* vs *mint new* without
 * asking the operator. Required by the AI's
 * create_content_instances tool description; legacy callers may pass
 * null (the migration-0093 unsynced rows have purpose=NULL).
 * See CLAUDE.md §1A.
 */
const contentInstancePurpose = z.string().max(1000);

export const contentInstanceCreateSchema = z
  .object({
    moduleId: z.string().uuid(),
    slug: slugSchema.optional(),
    displayName: z.string().min(1).max(128).optional(),
    purpose: contentInstancePurpose.optional(),
    values: contentValuesSchema.default({}),
  })
  .strict();

export const contentInstanceUpdateSchema = z
  .object({
    id: z.string().uuid(),
    /** Fully replaces existing values. */
    values: contentValuesSchema,
    /** Optional optimistic-concurrency token; mirrors pages.update. */
    expectedVersion: z.number().int().nonnegative().optional(),
    /** Optional rename in the same write; mirrors how pages.update accepts metadata edits. */
    slug: slugSchema.nullable().optional(),
    displayName: z.string().min(1).max(128).nullable().optional(),
    /** v0.12.0 — rewrite the purpose (or clear via null). */
    purpose: contentInstancePurpose.nullable().optional(),
  })
  .strict();

export const contentInstanceDeleteSchema = z
  .object({
    id: z.string().uuid(),
  })
  .strict();

export const setPlacementContentSchema = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.number().int().nonnegative(),
    contentInstanceId: z.string().uuid(),
    syncMode: syncModeSchema,
  })
  .strict();

export const forkPlacementContentSchema = z
  .object({
    pageId: z.string().uuid(),
    blockName: z.string().min(1).max(80),
    position: z.number().int().nonnegative(),
  })
  .strict();

export type ContentInstanceCreateInput = z.infer<typeof contentInstanceCreateSchema>;
export type ContentInstanceUpdateInput = z.infer<typeof contentInstanceUpdateSchema>;
export type ContentInstanceDeleteInput = z.infer<typeof contentInstanceDeleteSchema>;
export type SetPlacementContentInput = z.infer<typeof setPlacementContentSchema>;
export type ForkPlacementContentInput = z.infer<typeof forkPlacementContentSchema>;
