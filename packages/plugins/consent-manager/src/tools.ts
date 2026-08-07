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

export const CONSENT_TOOLS: ReadonlyArray<PluginToolSpec> = [
  {
    name: "consent_status",
    description:
      "Read the consent setup: categories, policy version, and the exact contract a banner module must satisfy. " +
      "Call this FIRST whenever the operator asks for a cookie banner, consent dialog, or anything about tracking — it tells you which data list to iterate and which data-attributes the runtime binds to. " +
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
      "Register a tracking tag (Google Analytics, Meta pixel, Matomo, …) under a consent category. It fires ONLY after the visitor grants that category — you do not need to write any gating yourself. " +
      "TWO-STEP: this PAUSES for the Owner's in-chat Approve before anything is registered. Say you have prepared it and asked for approval; do not claim the tag is live. " +
      "Pick the category conservatively: anything that measures or follows a visitor is analytics or marketing, never necessary. Claiming `necessary` requires a written justification and is rejected without one. " +
      "Known vendors (google-analytics, google-tag-manager, meta-pixel, matomo, hotjar) supply their own category and script URL — pass `vendor` and you can omit both.",
    operationName: "add_tag",
    approvalMode: "user-approval",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: {
        name: { type: "string", description: "Operator-facing label, unique." },
        vendor: {
          type: "string",
          description: "One of the known vendor keys, or free text for anything else.",
        },
        category: {
          type: "string",
          enum: ["necessary", "functional", "analytics", "marketing"],
        },
        scriptSrc: { type: "string", description: "External script URL." },
        inlineSnippet: { type: "string", description: "Inline JS, when the vendor gives one." },
        position: { type: "string", enum: ["head", "body_end"] },
        justification: {
          type: "string",
          description: "Why this tag is needed. REQUIRED when category is `necessary`.",
        },
      },
    },
  },
  {
    name: "list_tracking_tags",
    description:
      "List the registered tracking tags with the consent category each is pinned to, plus the vendors whose category and script URL are already known. " +
      "Call before adding a tag (to avoid a duplicate) and whenever the operator asks what the site loads or what data leaves it.",
    operationName: "list_tags",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "remove_tracking_tag",
    description:
      "Remove a tracking tag by name. It stops being injected at the next deploy. " +
      "Not gated: removing a tag only ever reduces what the site loads.",
    operationName: "remove_tag",
    inputJsonSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name"],
      properties: { name: { type: "string" } },
    },
  },
  {
    name: "bump_consent_policy_version",
    description:
      "Invalidate every stored consent so all visitors are asked again. " +
      "Use ONLY when what the site does with data has actually changed — a new tracking vendor, a new purpose. " +
      "NOT for wording changes (that is describe_categories): re-asking everyone for a reworded sentence trains people to click Accept without reading.",
    operationName: "bump_policy_version",
    inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
  },
];
