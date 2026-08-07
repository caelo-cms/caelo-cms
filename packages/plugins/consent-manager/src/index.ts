// SPDX-License-Identifier: MPL-2.0

/**
 * @caelo-cms/plugin-consent-manager — GDPR consent and tracking
 * management, entirely as a plugin (epic #448).
 *
 * ## The split this plugin is built around
 *
 * The plugin owns BEHAVIOUR and DATA; the AI owns everything visible.
 *
 * Recording a choice, keeping a tag from firing before it, and holding
 * a third-party embed until the visitor agrees are the parts a
 * regulator asks about — they cannot depend on AI-authored module JS
 * being right this time. Every pixel, though, should look like the site
 * it lives on: a banner carrying a plugin's fixed markup is the reason
 * every consent dialog on the web looks the same and none of them look
 * like the site behind it.
 *
 * So: the plugin ships a runtime (#449) that binds to documented
 * attributes, and a `consent_categories` data list (#447) the banner
 * module iterates. The AI writes the markup.
 *
 * ## Where the pieces live
 *
 *   cms_admin  plugin_consent_manager.categories  — the four categories
 *              plugin_consent_manager.settings    — policy version, retention
 *   cms_public plugin_consent_manager.consent_log — proof of consent
 *
 * Consent records are the evidence half of the obligation, so they live
 * in cms_public where the gateway can write them on a visitor request,
 * and they outlive deactivation (uninstall drops the schema — export
 * first; see `export_log`).
 */

import {
  definePlugin,
  type PluginAdminQuery,
  type PluginContextTier1,
} from "@caelo-cms/plugin-sdk";
import { type CategoryRow, DEFAULT_CATEGORIES } from "./categories.js";
import { buildRuntimeJs, RUNTIME_CSS } from "./runtime.js";

const SLUG = "consent-manager";
const RECORD_ENDPOINT = `/api/plugin/${SLUG}/record_consent`;

interface SettingsRow {
  id: string;
  policy_version: number;
  retention_days: number;
}

function adminQueryOf(ctx: unknown): PluginAdminQuery {
  const q = (ctx as { adminQuery?: PluginAdminQuery }).adminQuery;
  if (!q) {
    throw new Error(
      "consent-manager: ctx.adminQuery missing — the cms_admin_schema capability was not granted",
    );
  }
  return q;
}

/**
 * Read settings, seeding the row on first use.
 *
 * The seed is not a fallback (CLAUDE.md §2): it is the create-time
 * default for a table that has exactly one row, written once and then
 * read like any other data. A missing row after that would be a bug,
 * and `list` returning empty twice in a row would surface it.
 */
async function settingsOf(q: PluginAdminQuery): Promise<SettingsRow> {
  const rows = (await q.list("settings", { limit: 1 })) as unknown as SettingsRow[];
  const existing = rows[0];
  if (existing) return existing;
  await q.insert("settings", { policy_version: 1, retention_days: 365 });
  const seeded = (await q.list("settings", { limit: 1 })) as unknown as SettingsRow[];
  const row = seeded[0];
  if (!row) throw new Error("consent-manager: settings row could not be created");
  return row;
}

/** Categories in display order, seeding the defaults on first use. */
async function categoriesOf(q: PluginAdminQuery): Promise<CategoryRow[]> {
  const rows = (await q.list("categories", {
    limit: 100,
    orderBy: "position",
    orderDir: "asc",
  })) as unknown as CategoryRow[];
  if (rows.length > 0) return rows;
  for (const c of DEFAULT_CATEGORIES) {
    await q.insert("categories", {
      key: c.key,
      display_name: c.displayName,
      description: c.description,
      required: c.required,
      position: c.position,
    });
  }
  return (await q.list("categories", {
    limit: 100,
    orderBy: "position",
    orderDir: "asc",
  })) as unknown as CategoryRow[];
}

export default definePlugin<PluginContextTier1>({
  slug: SLUG,
  version: "0.1.0",
  tier: 1,
  requestedCapabilities: ["cms_admin_schema", "chat_runner_tools"],

  /** Proof of consent. Written by the gateway on a visitor request. */
  schema: {
    consent_log: {
      visitor_id: "string",
      ip_hash: "string",
      granted: "jsonb",
      policy_version: "int",
      user_agent: "text",
      created_at: "timestamp",
    },
  },

  adminSchema: {
    categories: {
      key: "string",
      display_name: "string",
      description: "text",
      required: "bool",
      position: "int",
      created_at: "timestamp",
    },
    settings: {
      policy_version: "int",
      retention_days: "int",
      created_at: "timestamp",
    },
  },

  /** Only the record itself. Everything else is the Owner's. */
  publicOperations: ["record_consent"],

  /**
   * The banner iterates this instead of receiving markup from the
   * plugin, so it looks like the site it lives on. Placing that module
   * in the LAYOUT covers every page from one placement.
   */
  dataLists: [
    {
      name: "consent_categories",
      description:
        "The consent categories a visitor can accept or decline, in display order. Always non-empty while the plugin runs.",
      itemFields: ["key", "label", "description", "required"],
    },
  ],
  dataListsOperation: "consent_data_lists",

  /**
   * The runtime + its stylesheet, with this site's categories baked in
   * (#449). Baked rather than fetched because the runtime has to decide
   * whether a tag may fire before anything else loads, and a static
   * site cannot afford a blocking request to find out.
   */
  buildAssets: async (ctx) => {
    const q = adminQueryOf(ctx);
    const settings = await settingsOf(q);
    const categories = await categoriesOf(q);
    return {
      "runtime.js": buildRuntimeJs({
        slug: SLUG,
        policyVersion: settings.policy_version,
        recordEndpoint: RECORD_ENDPOINT,
        categories: categories.map((c) => ({
          key: c.key,
          displayName: c.display_name,
          required: c.required,
        })),
      }),
      "runtime.css": RUNTIME_CSS,
    };
  },

  operations: {
    /**
     * The visitor's decision. The ONLY operation reachable from the
     * gateway; it takes no identity from the caller beyond what the
     * gateway itself resolved.
     */
    record_consent: async (ctx, args) => {
      const { granted, policyVersion } = args as {
        granted?: unknown;
        policyVersion?: unknown;
      };
      if (!Array.isArray(granted) || granted.some((g) => typeof g !== "string")) {
        throw new Error("record_consent: `granted` must be an array of category keys");
      }
      if (typeof policyVersion !== "number" || !Number.isInteger(policyVersion)) {
        throw new Error("record_consent: `policyVersion` must be an integer");
      }
      await ctx.query.insert("consent_log", {
        visitor_id: ctx.visitor.id,
        ip_hash: ctx.visitor.ipHash,
        granted,
        policy_version: policyVersion,
        user_agent: "",
      });
      return { recorded: true };
    },

    consent_data_lists: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const categories = await categoriesOf(adminQueryOf(ctx));
      const items = categories.map((c) => ({
        key: c.key,
        label: c.display_name,
        description: c.description,
        required: c.required ? "true" : "false",
      }));
      // The same list on every page: the banner is site chrome, and a
      // per-page answer would invite placing it per page.
      const lists: Record<string, Record<string, typeof items>> = {};
      for (const id of pageIds) lists[id] = { consent_categories: items };
      return { lists };
    },

    /** Everything the AI needs to set the banner up, in one call. */
    consent_status: async (ctx) => {
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      const categories = await categoriesOf(q);
      return {
        policyVersion: settings.policy_version,
        retentionDays: settings.retention_days,
        categories: categories.map((c) => ({
          key: c.key,
          displayName: c.display_name,
          description: c.description,
          required: c.required,
        })),
        bannerContract: {
          list: "{{#consent_categories}}…{{/consent_categories}} with key, label, description, required",
          hooks: [
            "data-consent-banner (the dialog root)",
            'data-consent-category="<key>" (a checkbox)',
            "data-consent-accept-all",
            "data-consent-reject-all",
            "data-consent-save",
            "data-consent-open (re-open it later)",
          ],
          placement: "Put the banner module in the site LAYOUT — one placement covers every page.",
        },
      };
    },

    /**
     * Rewrite a category's operator-facing copy. The keys themselves are
     * fixed: they are what tags and withheld modules refer to, so
     * renaming one would orphan every reference to it.
     */
    describe_categories: async (ctx, args) => {
      const { categories } = args as {
        categories?: Array<{ key?: unknown; displayName?: unknown; description?: unknown }>;
      };
      if (!Array.isArray(categories) || categories.length === 0) {
        throw new Error("describe_categories: pass at least one category");
      }
      const q = adminQueryOf(ctx);
      const existing = await categoriesOf(q);
      let updated = 0;
      for (const c of categories) {
        if (typeof c.key !== "string") throw new Error("describe_categories: `key` is required");
        const row = existing.find((r) => r.key === c.key);
        if (!row) {
          throw new Error(
            `describe_categories: no category "${c.key}". The keys are fixed (${existing.map((r) => r.key).join(", ")}) because tags and withheld modules refer to them.`,
          );
        }
        const patch: Record<string, unknown> = {};
        if (typeof c.displayName === "string") patch.display_name = c.displayName;
        if (typeof c.description === "string") patch.description = c.description;
        if (Object.keys(patch).length === 0) continue;
        await q.update("categories", row.id, patch);
        updated += 1;
      }
      return { updated };
    },

    /**
     * Re-ask everyone. Separate from `describe_categories` because
     * rewording a description is cosmetic while invalidating consent
     * puts the banner back in front of every visitor.
     */
    bump_policy_version: async (ctx) => {
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      const next = settings.policy_version + 1;
      await q.update("settings", settings.id, { policy_version: next });
      return { policyVersion: next };
    },
  },

  tools: [
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
      name: "bump_consent_policy_version",
      description:
        "Invalidate every stored consent so all visitors are asked again. " +
        "Use ONLY when what the site does with data has actually changed — a new tracking vendor, a new purpose. " +
        "NOT for wording changes (that is describe_categories): re-asking everyone for a reworded sentence trains people to click Accept without reading.",
      operationName: "bump_policy_version",
      inputJsonSchema: { type: "object", additionalProperties: false, properties: {} },
    },
  ],

  skills: [
    {
      slug: "consent-banner-setup",
      displayName: "Set up the consent banner",
      description:
        "Build a GDPR consent dialog that matches the site's design, wired to the consent runtime.",
      body: [
        "The operator asks for a cookie banner, a consent dialog, or 'the GDPR thing'. They will not describe categories or attributes — that is your job.",
        "",
        "The split: the PLUGIN owns behaviour (recording the choice, holding tags and embeds back). YOU own everything visible — markup, copy, layout, colour. Never hand-write the consent logic in module JS; it is already there and it is the part that has to be right.",
        "",
        "Flow:",
        "1. Call consent_status FIRST. It returns the categories, the data list to iterate, and the exact attribute contract.",
        "2. Author ONE module for the banner and place it in the site LAYOUT — one placement covers every page. A per-page placement will miss the next page the operator adds.",
        "3. Iterate the categories rather than hard-coding four blocks:",
        '   <div data-consent-banner>{{#consent_categories}}<label><input type="checkbox" data-consent-category="{{key}}"> {{label}} <span>{{description}}</span></label>{{/consent_categories}}<button data-consent-accept-all>…</button><button data-consent-reject-all>…</button><button data-consent-save>…</button></div>',
        "4. Style it as part of the site: its own tokens, its own type scale. It should look like the footer belongs to the same site, not like a third-party widget.",
        "5. Declining must be exactly as easy as accepting — same prominence, same number of clicks. The runtime warns when data-consent-reject-all is missing, and a banner without it is not lawful consent.",
        "6. Add a data-consent-open link in the footer so visitors can change their mind later.",
        "7. Do NOT hide the banner yourself in CSS. The runtime decides when it is shown; a hand-rolled rule fights it and usually wins in the wrong direction.",
        "",
        "If the operator wants different wording or another language, use describe_categories — do not fork the copy into the module, or the two drift.",
      ].join("\n"),
      allowlistedTools: ["consent_status", "describe_categories"],
      autoEngagementHints: {
        keywords: ["cookie", "consent", "banner", "gdpr", "dsgvo", "tracking", "privacy"],
      },
    },
  ],
});
