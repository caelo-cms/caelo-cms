// SPDX-License-Identifier: MPL-2.0

/**
 * The AI-facing surface.
 *
 * Descriptions are written for the model, not for a reviewer (CLAUDE.md
 * §11): each says when to reach for the tool, when another one wins, and
 * — where it matters more than usual here — which way to err. Consent
 * decisions are asymmetric: over-restricting costs a placeholder,
 * under-restricting sends an unasked request to a third party, and the
 * descriptions say so rather than leaving the model to infer it.
 */

import type { PluginToolSpec } from "@caelo-cms/plugin-sdk";

const CATEGORY_ENUM = ["necessary", "functional", "analytics", "marketing"];

/** The tag fields add and update share (Zod: `tagFieldsSchema`). */
const TAG_FIELD_PROPERTIES = {
  vendor: {
    type: "string",
    description:
      "A known vendor key (google-analytics, google-tag-manager, meta-pixel, matomo, hotjar, leadinfo) or free text for anything else.",
  },
  category: { type: "string", enum: CATEGORY_ENUM },
  config: {
    type: "object",
    additionalProperties: { type: "string" },
    description:
      "Known vendors only: the ids their code is built from — google-analytics {measurementId:'G-…'}, google-tag-manager {containerId:'GTM-…'}, meta-pixel {pixelId:'<digits>'}, matomo {trackerUrl:'https://…/', siteId:'<digits>'}, hotjar {siteId:'<digits>'}, leadinfo {accountId:'LI-…'}. Ask the operator for the id; never invent one.",
  },
  scriptSrc: { type: "string", description: "Unknown vendors only: external https script URL." },
  inlineSnippet: {
    type: "string",
    description:
      "Unknown vendors only: inline JS — ONLY the code inside the vendor's <script> tag, never the <script>/<noscript> wrappers.",
  },
  position: { type: "string", enum: ["head", "body_end"] },
  justification: {
    type: "string",
    description: "Why this tag is needed. REQUIRED when category is `necessary`.",
  },
  cookies: {
    type: "array",
    description:
      "The cookies the tag sets — shown in the cookie declaration and DELETED when a visitor withdraws consent. Known vendors fill their documented defaults; pass this only to override. `pattern: true` makes `name` a prefix (`_ga_` covers `_ga_ABC123`).",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["name", "lifetime", "purpose"],
      properties: {
        name: { type: "string" },
        pattern: { type: "boolean" },
        lifetime: { type: "string", description: 'e.g. "2 years", "Session"' },
        purpose: { type: "string" },
      },
    },
  },
  vendorInfo: {
    type: "object",
    additionalProperties: false,
    description:
      "Who receives the data, for the cookie declaration. Known vendors pre-fill what is documented; pass fields to fill gaps or override (merged).",
    properties: {
      name: { type: "string" },
      seat: { type: "string", description: "Registered address." },
      purpose: { type: "string" },
      legalBasis: { type: "string" },
      thirdCountry: { type: "string", description: "Country outside the EU/EEA, empty if none." },
      transferBasis: { type: "string", description: "e.g. EU-U.S. Data Privacy Framework, SCCs." },
      privacyPolicyUrl: { type: "string" },
    },
  },
  scope: {
    type: "object",
    additionalProperties: false,
    description:
      "Where the tag runs; omit (or {}) for every page. `paths` are site paths with `*` as wildcard ('/de/*' = every page below /de). Page and template ids are resolved to their pages at each build, so new pages on a template are covered. `locales` match <html lang> ('de' covers de-AT). Excludes win over includes.",
    properties: {
      paths: { type: "array", items: { type: "string" } },
      excludePaths: { type: "array", items: { type: "string" } },
      pageIds: { type: "array", items: { type: "string", format: "uuid" } },
      excludePageIds: { type: "array", items: { type: "string", format: "uuid" } },
      templateIds: { type: "array", items: { type: "string", format: "uuid" } },
      excludeTemplateIds: { type: "array", items: { type: "string", format: "uuid" } },
      locales: { type: "array", items: { type: "string" } },
    },
  },
} as const;

export const CONSENT_TOOLS: ReadonlyArray<PluginToolSpec> = [
  {
    name: "consent_status",
    description:
      "Read the consent setup: categories (and which ones something on the site uses), policy version, the exact contract a banner module must satisfy, the cookies the site itself sets, `withheldNow` (modules visitors currently see as a placeholder — `siteChrome: true` means a header/footer/navigation missing from every page), and `consentLog` (what each recorded decision stores, for how long, where, and a paragraph for the privacy policy). " +
      "Call this FIRST whenever the operator asks for a cookie banner, consent dialog, privacy policy text, or anything about tracking, and right after the consent plugin is activated — tell the operator about anything in `withheldNow` at once. " +
      "NOT for changing anything.",
    operationName: "consent_status",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "describe_categories",
    description:
      "Reword a consent category's name or description to match the site's voice and audience. " +
      "The category KEYS are fixed (necessary, functional, analytics, marketing) because tags and withheld modules refer to them — only the operator-facing copy changes. " +
      "Use when the operator asks for different wording, another language, or a specific tone in the banner.",
    operationName: "describe_categories",
    // Consent copy is site configuration the visitor-facing banner shows.
    requiredPermission: "settings.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["categories"],
      properties: {
        categories: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key"],
            properties: {
              key: { type: "string" },
              displayName: { type: "string" },
              description: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "list_external_embeds",
    description:
      "List the modules that load something from a third party (YouTube, Maps, fonts, pixels), what each reaches for, and whether it is withheld pending consent, already gated, or explicitly allowed. " +
      "Call when the operator asks what the site loads, why a module shows a placeholder, or after adding a module with an embed. " +
      "A module marked `pending` is WITHHELD from visitors — an unrecognised vendor is not assumed harmless — so resolve those with classify_external_embed.",
    operationName: "list_embeds",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "classify_external_embed",
    description:
      "Decide what a module's third-party embed needs: pin it to a consent category (it then shows the placeholder until the visitor agrees) or mark it allowed (it renders for everyone). " +
      "Mark allowed ONLY when the request carries nothing identifying — a self-hosted asset, a CDN with no cookies and no logging of visitors. When unsure, pin it to a category; the cost is a placeholder, and the cost of the other mistake is an unasked request to a third party.",
    operationName: "classify_embed",
    // Decides which third-party requests visitors' browsers make — a consent setting.
    requiredPermission: "settings.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["moduleId"],
      properties: {
        moduleId: { type: "string", format: "uuid" },
        category: {
          type: "string",
          enum: ["necessary", "functional", "analytics", "marketing"],
        },
        allow: {
          type: "boolean",
          description: "True to render it for everyone. Mutually exclusive with `category`.",
        },
      },
    },
  },
  {
    name: "add_tracking_tag",
    description:
      "Register a tracking tag (Google Analytics, Meta pixel, Matomo, Leadinfo, …) under a consent category. It fires ONLY after the visitor grants that category, and only where its `scope` says — you do not write any gating yourself. " +
      "TWO-STEP: this PAUSES for the Owner's in-chat Approve before anything is registered. Say you have prepared it and asked for approval; do not claim the tag is live. When asking, tell the operator that approving it asks EVERY visitor for consent again (the policy version moves: their earlier consent did not cover this vendor). " +
      "Known vendors (google-analytics, google-tag-manager, meta-pixel, matomo, hotjar, leadinfo): pass `vendor` + `config` with the ids — the vendor's official code, cookies and vendor data are filled in. Never paste their snippet. Unknown vendors: `scriptSrc` or `inlineSnippet`, plus `cookies` and `vendorInfo` for the cookie declaration. " +
      "Pick the category conservatively: anything that measures or follows a visitor is analytics or marketing, never necessary. Claiming `necessary` requires a written justification and is rejected without one. " +
      "The result lists `declarationGaps` — vendor data the privacy page still lacks; ask the operator and fill them with update_tags_many. To change an existing tag use update_tags_many, not remove + add.",
    operationName: "add_tag",
    approvalMode: "user-approval",
    // #589 — the Owner who approves registers a site-wide script: the
    // same permission site settings need.
    requiredPermission: "settings.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Operator-facing label, unique." },
        ...TAG_FIELD_PROPERTIES,
      },
    },
  },
  {
    name: "update_tags_many",
    description:
      "Change one or more registered tracking tags in one call: its ids (`config`), category, cookies, vendor data, scope (which pages/languages), or `enabled`. Each item names the tag and carries only the fields to change; the rest stays. All items are checked before any is written. " +
      "TWO-STEP: this PAUSES for the Owner's in-chat Approve. If the change touches category, vendor, purpose, cookies, scope or re-enables a tag, approving it asks EVERY visitor for consent again — say so when you ask; filling in vendor data like an address or a privacy link does not. " +
      "Prefer this over remove + add, and batch several tags into one call.",
    operationName: "update_tags_many",
    approvalMode: "user-approval",
    // Changes the site-wide scripts, like add_tag.
    requiredPermission: "settings.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["tags"],
      properties: {
        tags: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: {
              name: { type: "string", description: "The tag to change (list_tracking_tags)." },
              enabled: { type: "boolean" },
              ...TAG_FIELD_PROPERTIES,
            },
          },
        },
      },
    },
  },
  {
    name: "list_tracking_tags",
    description:
      "List the registered tracking tags: category, ids (`config`), cookies, vendor data, scope, and `declarationGaps` (what the cookie declaration still lacks). Also lists the known vendors with the config each needs. " +
      "Call before adding a tag (to avoid a duplicate) and whenever the operator asks what the site loads, which ids are set, or what data leaves it.",
    operationName: "list_tags",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "remove_tracking_tag",
    description:
      "Remove a tracking tag by name. It stops being injected at the next deploy. " +
      "Not gated, and nobody is asked for consent again: removing a tag only ever reduces what the site loads.",
    operationName: "remove_tag",
    // Changes the site-wide scripts, like add_tag.
    requiredPermission: "settings.write",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "consent_stats",
    description:
      "How visitors answer the banner, in aggregate: share of accept-all, reject-all and custom choices, how often each category is granted, and the same per policy version, over the last `days` (default 30). Counts only — no individual record. " +
      "Use when the operator asks how many visitors accept tracking, how much analytics data is missing, or whether a banner change moved the rates. The individual consent records are personal data and are not available to you; the Owner exports them from the admin's consent panel.",
    operationName: "consent_stats",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        days: { type: "number", description: "Window in days, 1–3650. Default 30." },
      },
    },
  },
  {
    name: "bump_consent_policy_version",
    description:
      "Invalidate every stored consent so all visitors are asked again. " +
      "Use ONLY when what the site does with data has actually changed outside the tag registry — e.g. a new purpose described in the privacy policy. Adding or changing a tag already does this by itself. " +
      "NOT for wording changes (that is describe_categories): re-asking everyone for a reworded sentence trains people to click Accept without reading.",
    operationName: "bump_policy_version",
    // Re-asks every visitor for consent — a site-wide setting.
    requiredPermission: "settings.write",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];
