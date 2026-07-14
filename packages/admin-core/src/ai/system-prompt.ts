// SPDX-License-Identifier: MPL-2.0

/**
 * Composes the system prompt sent to the AI provider on every chat
 * call. Pulls Owner-curated `site_ai_memory` slots, orders them
 * deterministically (so prompt-cache hits accumulate across calls),
 * and appends a brief tool catalogue.
 *
 * Returns ordered chunks (P5.2 #4) so adapters that support prompt-
 * cache can mark the long-lived chunks (`base`, `memory`, `tools`)
 * cacheable while leaving short-lived chunks (per-turn chips,
 * engaged-skill bodies) outside the cache. `composeSystemPromptString`
 * concatenates for callers that don't care about the structure.
 */

const SLOT_ORDER = [
  "purpose",
  "brand-voice",
  "tone",
  "banned-phrases",
  "instructions",
  "glossary",
] as const;

const SLOT_HEADINGS: Record<(typeof SLOT_ORDER)[number], string> = {
  purpose: "Purpose",
  "brand-voice": "Brand voice",
  tone: "Tone",
  "banned-phrases": "Banned phrases",
  instructions: "Recurring instructions",
  glossary: "Glossary",
};

export interface MemoryRow {
  readonly slot: string;
  readonly body: string;
}

export interface ToolCatalogueEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * v0.10.20 — Build the `## Structured-data sets you can edit` block from
 * the `structured_sets.list` result. Extracted from chat-runner.ts so
 * the formatter is unit-testable without spinning up a chat session.
 *
 * v0.10.21 — Always emits the **concept primer**, even when no sets
 * exist on this install. Pre-v0.10.21 this returned `undefined` on an
 * empty list, so the AI didn't know structured-data sets existed as a
 * concept and fell back to editing the header module's HTML directly
 * when asked to "update the navigation."
 *
 * v0.10.22 — primer rewritten to reference the unified CRUD surface
 * (`list_structured_sets` / `get_structured_set` / `set_structured_set`
 * / `delete_structured_set`). The kind-specific wrappers `set_nav_menu`
 * and `update_theme` were removed; the AI uses `kind` as a discriminator
 * argument and the per-kind JSON Schema on `set_structured_set`
 * enforces the right item shape at the tool-call boundary.
 *
 * For `kind === "nav-menu"` (and only that kind), inline each item as
 * `{ label, href[, target, children: N] }` so the AI can copy-modify
 * without a `structured_sets.get` round-trip. Other kinds carry
 * larger / less-frequently-edited shapes and stay summarized to
 * bound the prompt size. Cap nav-menu inlining at 30 items per menu;
 * outliers fall back to count-only.
 */
export function formatStructuredSetsBlock(
  sets: readonly { kind: string; slug: string; displayName: string; items: unknown }[],
): string {
  const primer = [
    "# Structured-data sets you can edit",
    "Caelo has typed named lists for **global repeated content**: navigation menus, tags, taxonomies, link-lists, and language-selectors. When the user asks about any of these, prefer creating or editing a structured set over hardcoding values in module HTML — that's what these lists are for.",
    "",
    "Kinds: `nav-menu`, `tags`, `taxonomy`, `link-list`, `language-selector`. Item shape is per-kind and enforced by the JSON Schema on `set_structured_set` (a mismatch is rejected at the tool boundary with a structured error). " +
      "**Theme tokens are NOT a structured-set kind anymore (v0.11.0)** — see the `## Theme` block below; use `set_theme_tokens` for token tweaks and `propose_create_theme` to mint a new theme.",
    "",
    "Tools (one unified CRUD surface — `kind` is a discriminator argument):",
    "- `list_structured_sets({ kind? })` — list sets; omit `kind` for all. Existing sets are already inlined below at session start; call this only after writes or if the listing was truncated.",
    "- `get_structured_set({ kind, slug })` — fetch one set's items. Use before a partial update so you can merge in JS.",
    "- `set_structured_set({ kind, slug, displayName, items })` — UPSERT. Creates the set when the slug doesn't exist; REPLACES `items` if it does (NOT append — pass the full desired list).",
    "- `delete_structured_set({ kind, slug })` — remove a set.",
    "",
    "Renderer convention: a module with slug `<kind>-<slug>` auto-renders the matching `<kind>/<slug>` set. Currently only `nav-menu-<slug>` and `language-selector-<slug>` auto-wire — for the other kinds, the rendering module's HTML/JS references the items directly via the structured-sets API. To wire a brand-new nav menu onto a layout: (1) `set_structured_set({ kind: 'nav-menu', slug: 'X', displayName: '…', items: [...] })` to create the items, (2) ensure a module named `nav-menu-X` is on the layout's header (or footer) block — use `add_module_to_layout` if it doesn't exist yet.",
    "",
    'If the user mentions "navigation", "the nav", "the menu", "header links", "footer menu" — that\'s a nav-menu, NOT a module to edit. Reach for `set_structured_set` with `kind: "nav-menu"` first.',
  ].join("\n");
  if (sets.length === 0) {
    return [
      primer,
      "",
      "_No sets exist yet on this install — create one with the tool above._",
    ].join("\n");
  }
  return [
    primer,
    "",
    "Existing sets on this install:",
    ...sets.map((s) => {
      const items = Array.isArray(s.items) ? (s.items as unknown[]) : [];
      const header = `- ${s.kind}/${s.slug} ("${s.displayName}") — ${items.length} item${items.length === 1 ? "" : "s"}`;
      if (s.kind !== "nav-menu" || items.length === 0 || items.length > 30) {
        return header;
      }
      const lines = (
        items as Array<{
          label?: unknown;
          href?: unknown;
          target?: unknown;
          children?: unknown;
        }>
      ).map((it, i) => {
        const label = typeof it.label === "string" ? it.label : "?";
        const href = typeof it.href === "string" ? it.href : "?";
        const target = it.target ? `, target: "${String(it.target)}"` : "";
        const kids =
          Array.isArray(it.children) && it.children.length > 0
            ? `, children: ${it.children.length}`
            : "";
        return `    ${i + 1}. { label: ${JSON.stringify(label)}, href: ${JSON.stringify(href)}${target}${kids} }`;
      });
      return `${header}:\n${lines.join("\n")}`;
    }),
  ].join("\n");
}

/**
 * v0.12.0 — `## Modules` decision-support catalog.
 *
 * Per CLAUDE.md §1A: the operator says "I need a pricing page", never
 * "add the product-header module". The AI translates intent → the
 * right module. This block gives the AI enough context to make that
 * call without round-tripping back to the operator:
 *
 *   - `description` — what this module is for + when to use it
 *   - `kind` — chrome | hero | content | cta | utility (grouping key)
 *   - `placements` — count + top sample slugs the module appears on
 *   - `fields` — short list of field names + kinds so the AI sees the
 *      content shape without an extra modules.get call
 *
 * Grouped by `kind` so the AI scans by intent ("which hero do I want?")
 * rather than slug-alphabetic. Capped at ~40 modules / <3 KB; the AI
 * calls `list_modules` for the full set.
 */
export function formatModulesBlock(
  modules: readonly {
    id: string;
    slug: string;
    displayName: string;
    description: string;
    kind: "chrome" | "hero" | "content" | "cta" | "utility";
    /** v0.12.3 (issue #106) — stable class the AI references when
     *  satisfying a parent's `allowedModuleTypes`. */
    type?: string;
    fields: readonly { name: string; kind: string; allowedModuleTypes?: readonly string[] }[];
  }[],
  usageByModuleId: ReadonlyMap<string, { placementCount: number; sampleSlugs: readonly string[] }>,
): string {
  const primer = [
    "## Modules",
    "",
    'The full module catalog on this install. Pick modules by **kind** + **description** — the operator describes outcomes ("add a footer to the blog"), you decide which module fits.',
    "",
    "Tools: `list_modules` (full catalog; filter by kind/search), `add_module_to_page` (pass `moduleId` to place an existing module — reuse first; or `displayName` + `html` + `fields` to mint new, REQUIRES `description` + `kind` + semantic snake_case field names), `add_module_to_template` / `add_module_to_layout` (template-/site-wide variants), `edit_module` (modify HTML/fields/description).",
    "",
    "**When the catalog has no fit:** mint a new module directly through `add_module_to_page` (or the template/layout variant) with a meaningful `description` (what the module is for, when to use it) — authoring and placement happen in one call; there is no separate create step. Don't ask the operator which module to use — pick the closest fit by kind, or mint a new one.",
  ].join("\n");
  if (modules.length === 0) {
    return [
      primer,
      "",
      "_0 modules on this install — every page composition starts by minting modules via `add_module_to_page` (or `build_page` for a whole page)._",
    ].join("\n");
  }
  // Group by kind so the AI scans by intent.
  const KIND_ORDER = ["chrome", "hero", "content", "cta", "utility"] as const;
  const byKind = new Map<(typeof KIND_ORDER)[number], typeof modules>();
  for (const k of KIND_ORDER) byKind.set(k, [] as unknown as typeof modules);
  for (const m of modules) {
    const bucket = byKind.get(m.kind) as unknown as (typeof modules)[number][];
    bucket.push(m);
  }
  const lines: string[] = [primer, ""];
  let emitted = 0;
  for (const k of KIND_ORDER) {
    const bucket = byKind.get(k) as unknown as (typeof modules)[number][];
    if (bucket.length === 0) continue;
    if (emitted >= 40) break;
    lines.push(`### kind=${k}`);
    for (const m of bucket) {
      if (emitted >= 40) {
        lines.push(`    … (${bucket.length - (emitted - bucket.length)} more — call list_modules)`);
        break;
      }
      const u = usageByModuleId.get(m.id);
      const usage =
        u && u.placementCount > 0
          ? ` — placements=${u.placementCount}${
              u.sampleSlugs.length > 0
                ? ` (e.g. ${u.sampleSlugs
                    .slice(0, 3)
                    .map((s) => `/${s}`)
                    .join(", ")})`
                : ""
            }`
          : " — unplaced";
      const desc = m.description.trim() === "" ? "(no description)" : m.description.trim();
      // v0.12.3 (issue #106) — field summary. Primitive fields are capped
      // at 5 (name:kind) to bound the prompt, but `module`/`module-list`
      // fields are ALWAYS shown in full with their `allowedModuleTypes`
      // whitelist: that constraint is exactly what the AI needs to pick a
      // valid nested module without guessing (and then punting the
      // validator failure to the operator).
      const nestedFields = m.fields.filter((f) => f.kind === "module" || f.kind === "module-list");
      const plainFields = m.fields.filter((f) => f.kind !== "module" && f.kind !== "module-list");
      const plainSummary =
        plainFields.length === 0
          ? ""
          : ` fields=[${plainFields
              .slice(0, 5)
              .map((f) => `${f.name}:${f.kind}`)
              .join(", ")}${plainFields.length > 5 ? ", …" : ""}]`;
      const nestedSummary =
        nestedFields.length === 0
          ? ""
          : ` nested=[${nestedFields
              .map((f) => {
                const allow =
                  f.allowedModuleTypes && f.allowedModuleTypes.length > 0
                    ? ` allowedModuleTypes=[${f.allowedModuleTypes.join(", ")}]`
                    : " (any type)";
                return `${f.name}:${f.kind}${allow}`;
              })
              .join(", ")}]`;
      // v0.12.3 — surface `type` (the reusable class) distinctly from the
      // unique `slug`, so the AI references the right value in a parent's
      // allowedModuleTypes.
      const typeTag = m.type ? ` type=\`${m.type}\`` : "";
      lines.push(`- \`${m.slug}\`${typeTag} "${m.displayName}"${usage}`);
      lines.push(`    ${desc}${plainSummary}${nestedSummary}`);
      emitted += 1;
    }
  }
  return lines.join("\n");
}

/**
 * v0.12.0 — `## Content Library` decision-support block.
 *
 * Per CLAUDE.md §1A: the AI must be able to decide *reuse the synced
 * row* vs *fork to unsynced* vs *mint new* without asking the
 * operator. This block surfaces, per instance:
 *
 *   - `purpose` — why this row exists as a shared instance
 *   - `placementCount` — blast radius of an edit
 *   - sample page slugs the instance appears on (pattern hint)
 *   - parent module kind so the AI can group by intent
 *
 * Sorted by placementCount DESC so the highest-impact shared content
 * stays above the 30-row cap. Grouped by module kind for legibility.
 */
export function formatContentLibraryBlock(
  instances: readonly {
    id: string;
    moduleSlug: string;
    moduleKind?: "chrome" | "hero" | "content" | "cta" | "utility";
    slug: string | null;
    displayName: string | null;
    purpose?: string | null;
    placementCount: number;
  }[],
  usageByCiId?: ReadonlyMap<string, { sampleSlugs: readonly string[] }>,
): string {
  const primer = [
    "## Content Library",
    "",
    "Reusable `content_instances` rows on this install. Each row is a typed bag of values for one module, bindable to N placements via `set_placement_content({ syncMode: 'synced' })` so edits propagate everywhere bound.",
    "",
    "Tools: `list_content_instances` (browse), `get_content_instance` (one + placements), `create_content_instance` (mint reusable), `set_content_instance_values` (edit; placementCount = blast radius), `delete_content_instance` (orphans only), `set_placement_content` (bind placement -> instance + sync_mode), `fork_placement_content` (detach synced -> private).",
  ].join("\n");
  if (instances.length === 0) {
    return [
      primer,
      "",
      "_0 shared content_instances on this install. The unsynced default (one private CI per placement) is fine for most content — only mint a shared instance via `create_content_instance` when the same content should appear identically on N pages (footers, banners, repeated CTAs)._",
    ].join("\n");
  }
  // v0.12.2 — sort by placementCount DESC so the highest-impact shared
  // content stays above the 30-row cap. The op's default ORDER BY
  // created_at ASC otherwise hides heavily-placed shared content
  // behind older orphan rows.
  const sortedInstances = [...instances].sort((a, b) => b.placementCount - a.placementCount);
  // v0.12.0 — group by module kind for legibility (chrome / hero / …).
  // Falls back to "content" when moduleKind isn't surfaced.
  const KIND_ORDER = ["chrome", "hero", "content", "cta", "utility"] as const;
  const byKind = new Map<(typeof KIND_ORDER)[number], typeof sortedInstances>();
  for (const k of KIND_ORDER) byKind.set(k, [] as unknown as typeof sortedInstances);
  for (const inst of sortedInstances) {
    const k = (inst.moduleKind ?? "content") as (typeof KIND_ORDER)[number];
    const bucket = byKind.get(k) as unknown as (typeof sortedInstances)[number][];
    bucket.push(inst);
  }
  const lines: string[] = [
    primer,
    "",
    "Active instances grouped by parent-module kind (truncated to 30 rows; call `list_content_instances` for more):",
  ];
  let emitted = 0;
  for (const k of KIND_ORDER) {
    const bucket = byKind.get(k) as unknown as (typeof sortedInstances)[number][];
    if (bucket.length === 0) continue;
    if (emitted >= 30) break;
    lines.push(`### kind=${k}`);
    for (const r of bucket) {
      if (emitted >= 30) break;
      const label = r.displayName ?? r.slug ?? r.id;
      const purpose = r.purpose && r.purpose.trim() !== "" ? r.purpose.trim() : "(no purpose set)";
      const usage = usageByCiId?.get(r.id);
      const samples =
        usage && usage.sampleSlugs.length > 0
          ? ` on ${usage.sampleSlugs
              .slice(0, 3)
              .map((s) => `/${s}`)
              .join(", ")}${r.placementCount > usage.sampleSlugs.length ? ", …" : ""}`
          : "";
      lines.push(
        `- ${r.id} module=\`${r.moduleSlug}\` "${label}" — placements=${r.placementCount}${samples}`,
      );
      lines.push(`    ${purpose}`);
      emitted += 1;
    }
  }
  return lines.join("\n");
}

// SystemPromptChunk is defined in ./provider.ts so adapters can import
// it without pulling in the system-prompt composer; we re-use that type here.
import type { SystemPromptChunk } from "./provider.js";
import { ANCHOR_HUE_HINTS, DEPTH_AND_SURFACE_HINTS, TOKEN_SHAPE_HINTS } from "./theme-guidance.js";

export type { SystemPromptChunk } from "./provider.js";

// v0.5.10 — tightened "describe before calling" → "briefly state, then
// call". The old phrasing combined with the STAGING_BLOCK anti-pattern
// invited the model to describe extensively and skip the tool calls.
const BASE_SYSTEM = [
  "You are Caelo, an AI co-editor for a content management system.",
  "Editors describe what they want changed; you respond conversationally and use tools",
  "to make the changes. Briefly state what you're about to do (one sentence), then call",
  "the tools that do it. Never call tools other than the ones listed below.",
  // v0.12.3 (issue #106) — recover, don't punt. The operator is
  // non-technical and describes OUTCOMES; you decide the implementation.
  "When a tool call fails validation with an error that names a valid set of choices",
  "(available blocks, allowedModuleTypes, candidate modules, etc.), DO NOT ask the operator",
  "to fix it and DO NOT defer it — pick a value from the named set (or take the next step the",
  "error suggests, e.g. widen an allowlist via edit_module) and retry within this same turn.",
  "Never tell the operator to perform an editor-UI action or hand them an implementation",
  "detail (block names, module slugs/types, field shapes) — that is your job to resolve.",
].join(" ");

// v0.4.0 — module model. Tells the AI when to use edit_module
// (structural / global) vs set_page_module_content (per-page content).
// Cacheable since it's stable across every call.
//
// v0.5.1+ — module edits are now CHAT-BRANCHED until publish (same as
// content). See `## Staging` block below for the full three-state flow.
const MODULE_MODEL_BLOCK = [
  "## Module model",
  "",
  "Caelo separates STRUCTURE from CONTENT:",
  "",
  "- A **module** is reusable code (HTML template + CSS + JS) plus a declared **field schema** (an array of named slots).",
  "  Module HTML references slots as `{{fieldName}}`. Field kinds: text, richtext, url, image, number, boolean, link, **module**, **module-list**.",
  "  The last two are NESTED module references — use `{{>fieldName}}` for a single nested module, `{{#fieldName}}…{{/fieldName}}` for a list. Value shape: `{ moduleId, contentInstanceId }`.",
  "  Module-code edits are CHAT-BRANCHED until publish.",
  // v0.12.3 (issue #106) — the type-vs-slug distinction + nested-ref
  // contract, surfaced so the AI satisfies allowedModuleTypes without a
  // round-trip.
  "- Every module has a stable **`type`** (its reusable class, e.g. `button`) separate from its unique **`slug`** (`button-mpqxq3ch`). The `## Modules` block shows both.",
  "  A `module`/`module-list` field may declare **`allowedModuleTypes`** — a whitelist of `type`s permitted in that slot. To fill such a slot, reference an existing module whose `type` is in the list (check `## Modules`); REUSE one of that type rather than minting a near-duplicate. The whitelist matches the referenced module's `type`, NEVER its slug.",
  "  If no existing module of an allowed type fits, create one and pass `type: \"<an-allowed-type>\"` so it satisfies the whitelist. If a module SHOULD be allowed but isn't, widen the field's `allowedModuleTypes` via `edit_module` on the PARENT module.",
  "- **A content_instance** is a typed bag of values for one module. Two placements can bind to the SAME content_instance (`sync_mode='synced'`) so editing it propagates to every page bound to it.",
  "  An UNSYNCED placement (the default) holds a private content_instance — edits stay local to that page.",
  "  Content edits are CHAT-BRANCHED until publish; the new content_instance lock prevents two chats from racing on a shared row.",
  "",
  "Tool selection:",
  "",
  "- **Creating or composing a page with MORE THAN ONE section → use `build_page` (ONE call).** It creates the page + every section module (each with its own semantic `fields[]`) + their content in a single all-or-nothing transaction. Do NOT hand-orchestrate `create_page` + `add_module_to_page`×N + `set_page_module_content`×N — that is the exact N+1 round-trip chain build_page exists to replace (§11 bulk-first). Reach for `add_module_to_page` only to add ONE more module to an already-built page.",
  "- Use `edit_module` to change structure / styling / layout / the list of fields a module exposes.",
  "  → Affects every page using the module, branched to this chat until publish.",
  "- Use `set_page_module_content` to change what a specific placement on a specific page shows in its fields.",
  "  → Routes through content_instances.set_values for UNSYNCED placements (local edit). For SYNCED placements, the tool refuses and points you at fork_placement_content (detach first) or set_content_instance_values (commit to the blast radius).",
  "- Use `create_content_instance` + `set_placement_content({syncMode:'synced'})` to make content REUSABLE across pages — edit once, propagates everywhere.",
  "- Use `set_content_instance_values` to edit shared content (blast radius = placementCount).",
  "- Use `fork_placement_content` to detach a synced placement into a private one before editing.",
  "- Use `list_content_instances` / `get_content_instance` to inspect blast radius before any set_values call.",
  "",
  'When the operator says "change the hero text on /home" → set_page_module_content (the shim handles synced vs unsynced).',
  'When the operator says "the hero looks ugly, redesign it" → edit_module.',
  "When the operator says \"this contact info should be the same on /about and /contact\" → create_content_instance + set_placement_content({syncMode:'synced'}) on both placements.",
  "When in doubt: structural / cross-page styling → edit_module; per-page content → set_page_module_content; explicit cross-page CONTENT reuse → set_placement_content with syncMode='synced'.",
].join("\n");

// v0.5.5 — staging model. Every chat write is "pending" until the user
// stages + publishes it. Cacheable — applies to every chat session.
//
// v0.5.9 — rewritten to lead with action over description.
// v0.5.10 — trimmed: dropped redundant clauses already covered by the
// lead; cut from 13 lines to 7. Tighter prompts give the model fewer
// instructions to misread.
const STAGING_BLOCK = [
  "## Staging",
  "",
  "When the user asks for changes, **make them via the tools below first.** Every write lands in this chat's branch — invisible to the live site until the user clicks Stage.",
  "",
  "Tell the user what you did + that the Stage button in /edit ships it to staging. Don't claim a change is live.",
  "",
  "The user has a split-button `[Stage | ▾]` in the /edit overlay. Clicking Stage merges every branched edit into main and rebuilds staging in one shot (the staging URL is a 1:1 preview of what production would see). The `▾` dropdown gates production publish with per-kind checkboxes. You don't drive either — propose, then narrate.",
  "",
  "**Anti-pattern: describing what you would do without calling tools.** If the user asks you to build, edit, or create something, your response MUST include the tool calls that do the work. Text saying 'I will do X' without an actual tool call is wrong — make X happen via the tools, then explain what you did.",
].join("\n");

/**
 * Optional per-call volatile context: chips, ephemeral skill bodies,
 * the active /edit page's modules + blocks. Anything that changes
 * turn-to-turn goes here so the cache prefix stays stable.
 */
export interface VolatileContext {
  readonly chipsBlock?: string;
  readonly pageContextBlock?: string;
  /** P6.7.5 — full site page list, so AI can pick real link targets. */
  readonly allPagesBlock?: string;
  /** P6.7.5 — current theme tokens (CSS variables). */
  readonly themeBlock?: string;
  /** issue #165 — `## Design system` rendered from the Design Manifest. */
  readonly designSystemBlock?: string;
  /**
   * v0.11.4 (issue #76 follow-up) — operator-captured site name +
   * purpose (from /onboarding ?/identity). Brand context the AI uses
   * for every page it builds. Renders before `## Theme` so the AI
   * reads brand intent before tokens.
   */
  readonly siteIdentityBlock?: string;
  /** P6.7.5 — named structured-data sets the AI can edit (nav-menu, tags, etc.). */
  readonly structuredSetsBlock?: string;
  /** v0.12.0 — `## Modules` decision-support catalog (modules grouped
   *  by kind, with description + placement usage + field summary per
   *  module). Per CLAUDE.md §1A the AI picks modules by intent, not
   *  slug — this block carries the context for that decision. */
  readonly modulesBlock?: string;
  /** v0.12.0 — `## Content Library` decision-support block (shared
   *  content_instances with purpose + placementCount + sample pages).
   *  Lets the AI decide reuse vs fork vs mint new without a tool
   *  round-trip. */
  readonly contentLibraryBlock?: string;
  /** P6.7.6 — available layouts + their blocks (chrome shells). */
  readonly layoutsBlock?: string;
  /** P6.7.6 — site_defaults singleton + per-template layout binding. */
  readonly siteDefaultsBlock?: string;
  /** P7 — recent + most-used media so the AI can pick existing assets. */
  readonly mediaBlock?: string;
  /** P8 AI-first — recent redirects so the AI can plan + cite without round-trip. */
  readonly redirectsBlock?: string;
  /** P9 — locales registry + AI's own pending locale-change proposals. */
  readonly localesBlock?: string;
  /** v0.2.32 — cross-domain `## Pending proposals` block. Aggregates
   *  every status='pending' row across the 15 *_pending tables so the
   *  AI doesn't re-queue what the Owner is already reviewing. */
  readonly pendingProposalsBlock?: string;
  /** issue #262 — `## Locks held by other chats`. Entities locked by
   *  OTHER chat sessions, so the AI flags collisions in its plan step
   *  instead of hitting Locked errors mid-run. Interim guard until
   *  task leases replace chat locks (epic #264). */
  readonly foreignLocksBlock?: string;
  /** v0.2.38 — `## Users` inventory (email + roleNames per row). */
  readonly usersBlock?: string;
  /** v0.2.38 — `## Roles` inventory (name + permission count + builtin). */
  readonly rolesBlock?: string;
  /** v0.2.38 — `## AI providers` inventory (active + has-key per row). */
  readonly aiProvidersBlock?: string;
  /** v0.2.38 — `## Domains` inventory (hostname + kind + TLS status). */
  readonly domainsBlock?: string;
  /** P10A — engaged skills' bodies, tagged with slug + source. */
  readonly skillsBlock?: string;
  /** P10.5 #5 — hint that spawn_subagent / spawn_subagents exist + when to use them. */
  readonly subagentsBlock?: string;
  /** P11 opt 4 — AI's own pending or rejected plugin submissions, so it
   *  doesn't re-propose what's already in the queue and reads the
   *  Owner's rejection reasons before resubmitting. */
  readonly pluginsBlock?: string;
  /** P11.5 audit fix #1 — Tier-1 plugin-emitted system-prompt blocks.
   *  Plugins declare `promptContext: [{label, render}]` arrays; chat-runner
   *  calls renderAll() per turn and folds non-empty results here. Disabled
   *  plugins are skipped at the registry level. */
  readonly pluginContextBlock?: string;
}

export function composeSystemPromptChunks(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
  volatile: VolatileContext = {},
): SystemPromptChunk[] {
  const chunks: SystemPromptChunk[] = [
    { body: BASE_SYSTEM, cacheable: true, label: "base" },
    { body: MODULE_MODEL_BLOCK, cacheable: true, label: "module-model" },
    { body: STAGING_BLOCK, cacheable: true, label: "staging" },
  ];

  const bySlot = new Map(memory.map((m) => [m.slot, m.body.trim()]));
  const memoryLines: string[] = [];
  for (const slot of SLOT_ORDER) {
    const body = bySlot.get(slot);
    if (!body) continue;
    memoryLines.push(`## ${SLOT_HEADINGS[slot]}\n${body}`);
  }
  if (memoryLines.length > 0) {
    chunks.push({
      body: ["# Site memory", ...memoryLines].join("\n\n"),
      cacheable: true,
      label: "memory",
    });
  }

  if (tools.length > 0) {
    const toolLines = tools.map((t) => `- **${t.name}** — ${t.description}`);
    chunks.push({
      body: ["# Available tools", ...toolLines].join("\n"),
      cacheable: true,
      label: "tools",
    });
  }

  // Volatile chunks go last so the cache prefix above stays byte-stable.
  if (volatile.skillsBlock && volatile.skillsBlock.trim().length > 0) {
    chunks.push({ body: volatile.skillsBlock, cacheable: false, label: "skills" });
  }
  if (volatile.subagentsBlock && volatile.subagentsBlock.trim().length > 0) {
    chunks.push({ body: volatile.subagentsBlock, cacheable: false, label: "subagents" });
  }
  if (volatile.pluginsBlock && volatile.pluginsBlock.trim().length > 0) {
    chunks.push({ body: volatile.pluginsBlock, cacheable: false, label: "plugins" });
  }
  if (volatile.pluginContextBlock && volatile.pluginContextBlock.trim().length > 0) {
    chunks.push({
      body: volatile.pluginContextBlock,
      cacheable: false,
      label: "plugin-context",
    });
  }
  // v0.11.4 (issue #76 follow-up) — site identity comes BEFORE theme
  // so the AI reads brand intent before reading tokens. With both
  // blocks visible, the AI can judge whether the theme matches the
  // brand and evolve tokens if not.
  if (volatile.siteIdentityBlock && volatile.siteIdentityBlock.trim().length > 0) {
    chunks.push({ body: volatile.siteIdentityBlock, cacheable: false, label: "site-identity" });
  }
  if (volatile.themeBlock && volatile.themeBlock.trim().length > 0) {
    chunks.push({ body: volatile.themeBlock, cacheable: false, label: "theme" });
  }
  if (volatile.designSystemBlock && volatile.designSystemBlock.trim().length > 0) {
    chunks.push({ body: volatile.designSystemBlock, cacheable: false, label: "design-system" });
  }
  if (volatile.allPagesBlock && volatile.allPagesBlock.trim().length > 0) {
    chunks.push({ body: volatile.allPagesBlock, cacheable: false, label: "all-pages" });
  }
  if (volatile.structuredSetsBlock && volatile.structuredSetsBlock.trim().length > 0) {
    chunks.push({ body: volatile.structuredSetsBlock, cacheable: false, label: "structured-sets" });
  }
  if (volatile.modulesBlock && volatile.modulesBlock.trim().length > 0) {
    chunks.push({ body: volatile.modulesBlock, cacheable: false, label: "modules" });
  }
  if (volatile.contentLibraryBlock && volatile.contentLibraryBlock.trim().length > 0) {
    chunks.push({ body: volatile.contentLibraryBlock, cacheable: false, label: "content-library" });
  }
  if (volatile.layoutsBlock && volatile.layoutsBlock.trim().length > 0) {
    chunks.push({ body: volatile.layoutsBlock, cacheable: false, label: "layouts" });
  }
  if (volatile.siteDefaultsBlock && volatile.siteDefaultsBlock.trim().length > 0) {
    chunks.push({ body: volatile.siteDefaultsBlock, cacheable: false, label: "site-defaults" });
  }
  if (volatile.mediaBlock && volatile.mediaBlock.trim().length > 0) {
    chunks.push({ body: volatile.mediaBlock, cacheable: false, label: "media" });
  }
  if (volatile.redirectsBlock && volatile.redirectsBlock.trim().length > 0) {
    chunks.push({ body: volatile.redirectsBlock, cacheable: false, label: "redirects" });
  }
  if (volatile.localesBlock && volatile.localesBlock.trim().length > 0) {
    chunks.push({ body: volatile.localesBlock, cacheable: false, label: "locales" });
  }
  if (volatile.pendingProposalsBlock && volatile.pendingProposalsBlock.trim().length > 0) {
    chunks.push({
      body: volatile.pendingProposalsBlock,
      cacheable: false,
      label: "pending_proposals",
    });
  }
  if (volatile.foreignLocksBlock && volatile.foreignLocksBlock.trim().length > 0) {
    chunks.push({
      body: volatile.foreignLocksBlock,
      cacheable: false,
      label: "foreign_locks",
    });
  }
  if (volatile.usersBlock && volatile.usersBlock.trim().length > 0) {
    chunks.push({ body: volatile.usersBlock, cacheable: false, label: "users" });
  }
  if (volatile.rolesBlock && volatile.rolesBlock.trim().length > 0) {
    chunks.push({ body: volatile.rolesBlock, cacheable: false, label: "roles" });
  }
  if (volatile.aiProvidersBlock && volatile.aiProvidersBlock.trim().length > 0) {
    chunks.push({ body: volatile.aiProvidersBlock, cacheable: false, label: "ai_providers" });
  }
  if (volatile.domainsBlock && volatile.domainsBlock.trim().length > 0) {
    chunks.push({ body: volatile.domainsBlock, cacheable: false, label: "domains" });
  }
  if (volatile.pageContextBlock && volatile.pageContextBlock.trim().length > 0) {
    chunks.push({ body: volatile.pageContextBlock, cacheable: false, label: "page-context" });
  }
  if (volatile.chipsBlock && volatile.chipsBlock.trim().length > 0) {
    chunks.push({ body: volatile.chipsBlock, cacheable: false, label: "chips" });
  }

  return chunks;
}

/** Backwards-compatible flat-string composer. */
export function composeSystemPrompt(
  memory: readonly MemoryRow[],
  tools: readonly ToolCatalogueEntry[],
): string {
  return composeSystemPromptChunks(memory, tools)
    .map((c) => c.body)
    .join("\n\n");
}

/**
 * v0.11.4 (issue #76 follow-up) — `## Site identity` system-prompt
 * block. Caelo is chat-first per CLAUDE.md §1A: there's no forms-
 * based onboarding. The AI captures site identity (`siteName`,
 * `sitePurpose`) from the operator's first chat via the
 * `set_site_identity` tool, and that captured state then anchors
 * every future chat's brand context.
 *
 * Two branches:
 *
 * - **Untouched install** (both fields null): the block renders an
 *   instruction telling the AI to infer + capture identity from the
 *   FIRST user prompt before authoring anything. This is the cold-
 *   start path Caelo expects.
 * - **Populated**: the block renders the captured name + purpose
 *   plus a primer telling the AI to match copy/layout/theme to the
 *   brand context.
 *
 * Always returns a non-null block — even the empty case carries
 * cold-start instructions the AI needs to read.
 */
export function formatSiteIdentityBlock(
  identity: {
    siteName: string | null;
    sitePurpose: string | null;
    /** issue #163 — structured Design Brief captured by Site Genesis. */
    designBrief?: import("@caelo-cms/shared").DesignBrief | null;
  } | null,
): string | null {
  const hasName = identity && identity.siteName && identity.siteName.trim().length > 0;
  const hasPurpose = identity && identity.sitePurpose && identity.sitePurpose.trim().length > 0;

  if (!hasName && !hasPurpose) {
    // Cold-start path: no identity captured yet. Tell the AI what to
    // do BEFORE it authors any modules.
    return [
      "## Site identity",
      "",
      "> ⚠️ **Untouched install** — no site identity captured yet.",
      "",
      "Caelo is chat-first. Before you author any modules on the FIRST request that asks you to build/restyle/extend the site, you MUST:",
      "",
      "1. **Infer** `siteName` + `sitePurpose` from the operator's prompt. Example: *'build me a homepage for an AI-first CMS called Caelo, trustworthy and developer-focused'* → siteName `Caelo`, sitePurpose `An AI-first CMS for developers — trustworthy, branched edits, plugin sandbox`.",
      "2. **Capture** them via `set_site_identity({siteName, sitePurpose})`. This persists into every future chat so the next session inherits the brand context.",
      "3. **Evolve the theme** if the brand suggests a specific palette — `set_theme_tokens({set: {primaryColor: '#…'}})` + `set_theme_meta({description})` (the `## Theme` block below has more detail).",
      "4. **Then** author the modules the operator asked for.",
      "",
      "If the operator's prompt is too vague to infer (e.g. *'add a contact form'* on an unconfigured install with no brand signal), ASK ONE concise question for the essentials (\"What's this site for?\") before proceeding. Don't guess silently.",
      "",
      "**Route the FIRST conversation by what the operator already has** (issue #187 — the operator answers in chat; never send them to a form or wizard):",
      "",
      "- **Building a whole new site from scratch?** Run Site Genesis instead of composing directly: capture a design brief (`set_site_identity` with `designBrief`), spawn 3 parallel draft subagents for distinct design directions, `save_genesis_draft` each, and let the operator pick at /design/genesis — the site-genesis skill carries the full workflow.",
      "- **They already have a website** (they name a domain/URL, or say they want to move/migrate/import their site)? That is a MIGRATION, not Genesis. Inspect their site first, then ask ONE question — keep the current design, or redesign — and propose the crawl via `propose_site_import` (the proposal renders as a card with an Approve button RIGHT IN THIS CHAT — point the operator at that button, never at an admin page, and never claim the crawl already ran). Do NOT rebuild an existing site from memory or from the operator's description alone.",
      "- **They already have a finished design** (a mockup image, a styleguide export, existing HTML)? Ask them to share it in the chat and build on THAT design — do not generate divergent Genesis drafts that discard their asset.",
    ].join("\n");
  }

  const lines: string[] = ["## Site identity", ""];
  if (hasName) lines.push(`Site name: **${identity?.siteName}**`);
  if (hasPurpose) {
    lines.push("");
    lines.push(`What this site is for:`);
    lines.push(`> ${identity?.sitePurpose}`);
  }
  const brief = identity?.designBrief;
  if (brief) {
    const briefParts: string[] = [];
    if (brief.audience) briefParts.push(`audience: ${brief.audience}`);
    if (brief.moodWords && brief.moodWords.length > 0)
      briefParts.push(`mood: ${brief.moodWords.join(", ")}`);
    if (brief.tone) briefParts.push(`tone: ${brief.tone}`);
    if (brief.industry) briefParts.push(`industry: ${brief.industry}`);
    if (brief.differentiators) briefParts.push(`differentiators: ${brief.differentiators}`);
    if (brief.imageryDirection) briefParts.push(`imagery: ${brief.imageryDirection}`);
    if (brief.avoid) briefParts.push(`avoid: ${brief.avoid}`);
    if (briefParts.length > 0) {
      lines.push("");
      lines.push("Design brief (issue #163 — every design decision honours this):");
      for (const part of briefParts) lines.push(`> ${part}`);
    }
  }
  lines.push("");
  lines.push(
    "Use this context for every page you build — pick fitting copy, layout, and theme tokens. " +
      "If the active theme's palette doesn't match this brand, evolve it (`set_theme_tokens` + `set_theme_meta`) BEFORE authoring modules so the new tokens cascade through `var(--…)` references. " +
      "If the operator's request implies the identity has shifted (rebrand, new audience), update it with `set_site_identity`.",
  );
  return lines.join("\n");
}

/**
 * v0.11.0 (#45) — `## Theme` system-prompt block. Names the active
 * theme + a one-line summary so the AI knows the surface exists
 * without paying for the full DTCG document in every turn. Full tokens
 * load on demand via `get_theme({slug})` (which in v0.11.1 accepts
 * `as: "css-vars" | "tailwind" | "summary"` too).
 *
 * v0.11.1 (issue #76) — `summary` is the value formatThemeSummary()
 * produces from the tokens document directly (primary color shorthand,
 * body font, default radius, category counts). Callers compute it via
 * `formatThemeSummary(activeTheme.tokens)` and pass as `tokensSummary`.
 *
 * v0.11.4 (issue #76 follow-up) — leads with `origin` + `description`
 * so the AI distinguishes "untouched seed" from "operator brand choice"
 * and knows whether to evolve the theme. Also carries two behavioural
 * primers (theme = starting palette; module CSS uses theme vars) that
 * close the regression where the AI would inherit a neutral seed and
 * emit monochrome modules.
 *
 * Renders nothing when no active theme exists (pre-migration test
 * states only — production installs always carry one is_active row
 * post-0097).
 */
export function formatThemeBlock(
  theme: {
    slug: string;
    displayName: string;
    /**
     * Round-2 opt §4: the operator-supplied description column from
     * the themes table. Optional — pre-v0.11.0 single-theme installs
     * leave it null. When set, the AI uses it as the intent signal
     * for multi-theme installs ("Brand Orange — campaign-page variant").
     */
    description?: string | null;
    /**
     * v0.11.4 (issue #76 follow-up) — provenance of current state.
     * `seed` = untouched starter palette (the AI should evolve it for
     * the site being built). `ai` / `operator` = someone has shaped it
     * deliberately (preserve unless asked otherwise).
     */
    origin?: "seed" | "ai" | "operator";
    /**
     * v0.11.1 (issue #76) — terse summary line built by
     * `formatThemeSummary(tokens)` (palette/font/radius shorthand +
     * category counts). Replaces v0.11.0's flat category-count string.
     */
    tokensSummary: string;
    /**
     * v0.11.4 (issue #76 follow-up) — the actual CSS variable names
     * the renderer emits for this theme's tokens. Listed inline so the
     * AI uses real names in module CSS instead of guessing
     * (`--color-text` doesn't exist; `--color-foreground` does).
     * Without this, AI-authored module CSS falls through to hardcoded
     * fallbacks and pages render monochrome regardless of theme values.
     */
    cssVarNames?: readonly string[];
  } | null,
): string {
  if (!theme) {
    return [
      "## Theme",
      "",
      "_No active theme on this install. An Owner must propose+approve one via `propose_create_theme`._",
    ].join("\n");
  }
  const origin = theme.origin ?? "seed";
  const originLabel: Record<typeof origin, string> = {
    seed: "**seed** — untouched starter palette",
    ai: "**ai** — last edited by an AI turn",
    operator: "**operator** — last edited by a human",
  };
  const descriptionLine = theme.description
    ? `Design intent: _${theme.description}_`
    : "Design intent: _(none recorded — call `set_theme_meta({description: '…'})` after editing tokens so the next turn knows WHY this palette)_";
  const seedNotice =
    origin === "seed"
      ? [
          "",
          "> ⚠️ **This theme is a SEED** — neutral placeholders (primary, accent, etc. are all gray). Pages rendered against it look monochrome.",
          ">",
          "> **Required action when you create or restyle ANY visitor-facing page** (homepage, landing, product, marketing — anything that isn't pure admin chrome): compose a full brand palette from what you know about the site (name, content, industry, the operator's wording) and apply it BEFORE authoring modules:",
          ">",
          "> ```",
          "> set_theme_tokens({set: {primaryColor: '#4f46e5', accentColor: '...', fontHeading: '...'}})  // full palette in ONE call, not just one color",
          "> set_theme_meta({description: 'Indigo primary chosen because ...'})",
          "> ```",
          ">",
          `> Anchor-hue inspiration by feel: ${ANCHOR_HUE_HINTS}. The hue anchors the palette — the supporting colors and typography are yours to compose. Never default to neutral grayscale on a real site.`,
          ">",
          `> ${DEPTH_AND_SURFACE_HINTS}`,
          `> ${TOKEN_SHAPE_HINTS}`,
          ">",
          "> This warning clears once the theme is non-seed AND has a recorded `description` — `set_theme_meta` is not optional.",
        ].join("\n")
      : "";
  return [
    "## Theme",
    "",
    `Active theme: **${theme.displayName}** (slug \`${theme.slug}\`, origin: ${originLabel[origin]}) — ${theme.tokensSummary}.`,
    descriptionLine,
    seedNotice,
    "",
    "**Module CSS must reference theme vars** so token edits cascade: `background: var(--color-primary)`, `padding: var(--spacing-md)`, `font-family: var(--font-heading)`. Hardcoded hex defeats the theme — the operator can no longer tune the site by editing tokens.",
    "",
    // issue #150 — the AI picks families knowing they actually render:
    // web fonts are fetched + self-hosted automatically, so any Google
    // Fonts family is safe; a family that is neither a system stack nor
    // resolvable fails the deploy loudly.
    '**Web fonts are self-hosted automatically.** Any Google Fonts family in `typography.*.fontFamily` (e.g. `"Poppins", sans-serif`) is downloaded at deploy and served from the site — pick real typefaces that fit the brand instead of defaulting to system stacks. System stacks (`system-ui`, `Georgia`, …) load nothing. A family that is neither resolves as `theme-font-unresolvable:<family>` in the preview\'s missing-content list and BLOCKS the deploy — fix it via `set_theme_tokens` when you see that marker.',
    "",
    // v0.11.4 (issue #76 follow-up) — list the EXACT CSS var names the
    // renderer emits for THIS theme. Without this the AI guesses
    // (--color-text, --color-surface, etc. — names that look reasonable
    // but don't exist in shadcn-style themes). With this, the AI uses
    // only var names it knows resolve, and module CSS no longer falls
    // through to hardcoded slate/white fallbacks.
    theme.cssVarNames && theme.cssVarNames.length > 0
      ? `**CSS vars this theme defines** (use these exact names — do NOT invent others; unknown var names fall through to your fallbacks and render as the hardcoded value):\n${formatCssVarInventory(theme.cssVarNames)}`
      : "**CSS vars this theme defines:** _(none — theme is empty; ask the operator to configure tokens)_",
    "",
    "Tools (all read tokens by canonical DTCG path; `set_theme_tokens` ALSO accepts loose names that the server normalizes):",
    "- `list_themes()` — list every theme (one active, rest variants).",
    "- `get_theme({slug, as?})` — `as` is one of `dtcg` (default) / `css-vars` / `tailwind` / `summary`. Use `css-vars` when authoring module HTML so you don't translate DTCG paths.",
    "- `set_theme_tokens({set: {primaryColor: '#ff6600', fontHeading: 'Inter'}})` — edit the active theme. Pass loose names; the server returns the canonical paths it wrote.",
    "- `set_theme_meta({description?, displayName?})` — record design intent (and/or rename). Call after evolving a `seed` so future turns stay coherent.",
    "- `list_theme_history({limit?})` — recent edits with who/when/what. Check before proposing a rewrite — the operator may have already done it.",
    "- `set_theme_asset({slot, mediaId})` — bind logo / logoDark / favicon / socialShare.",
    "- `duplicate_theme({sourceSlug, newSlug, newDisplayName})` — clone tokens + assets into an inactive variant.",
    "- `import_theme({themeSlug, body})` — auto-detects DTCG / Style Dictionary / Tailwind 4 / shadcn / loose. `export_theme({themeSlug})` — DTCG out.",
    "",
    "Gated (each is a §11.A propose/execute; the AI proposes, the operator approves on the proposal card shown right in the chat — queue: `/security/themes/pending`):",
    "- `propose_create_theme({slug, displayName, description, tokens, overrides?})` — YOU compose the complete DTCG `tokens` document from brand context (color + typography + spacing + radius + shadow; primary with real chroma — no presets exist). `description` records why the palette fits. `overrides.primaryColor` triggers a 50–900 OKLCh ramp (each stop `_derived: true`).",
    "- `propose_activate_theme({themeId})` — flips the DB row only. A deploy must be approved separately via `propose_deploy_promote` for the new CSS to ship.",
    "- `propose_delete_theme({themeId})` — inactive themes only.",
  ].join("\n");
}

/**
 * v0.11.4 (issue #76 follow-up) — group + render CSS var names for the
 * `## Theme` block. Groups by category prefix (`--color-*`, `--spacing-*`,
 * etc.) so the AI scans the right group quickly without reading a flat
 * 60-line list. Compact: 4-up where short, one-per-line when long.
 */
function formatCssVarInventory(names: readonly string[]): string {
  // Group by category: everything after `--` up to the first `-`.
  const groups = new Map<string, string[]>();
  for (const name of names) {
    const stripped = name.startsWith("--") ? name.slice(2) : name;
    const dash = stripped.indexOf("-");
    const category = dash > 0 ? stripped.slice(0, dash) : stripped;
    const arr = groups.get(category) ?? [];
    arr.push(name);
    groups.set(category, arr);
  }
  // Stable order — match the renderer's category iteration.
  const ORDER = [
    "color",
    "spacing",
    "radius",
    "font",
    "text",
    "font-weight",
    "leading",
    "tracking",
    "shadow",
    "duration",
    "ease",
    "breakpoint",
  ];
  const sortedCategories = [...groups.keys()].sort((a, b) => {
    const ai = ORDER.indexOf(a);
    const bi = ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return a.localeCompare(b);
  });
  const lines: string[] = [];
  for (const cat of sortedCategories) {
    const items = groups.get(cat) ?? [];
    lines.push(`- \`--${cat}-*\`: ${items.join(", ")}`);
  }
  return lines.join("\n");
}
