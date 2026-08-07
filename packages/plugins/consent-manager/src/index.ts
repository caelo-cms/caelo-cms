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
import { externalHosts } from "./scan.js";
import { CONSENT_SKILLS } from "./skills.js";
import { type BakedTag, buildTagInjector, KNOWN_VENDORS, type TagRow } from "./tags.js";
import { CONSENT_TOOLS } from "./tools.js";

const SLUG = "consent-manager";
const RECORD_ENDPOINT = `/api/plugin/${SLUG}/record_consent`;

interface SettingsRow {
  id: string;
  policy_version: number;
  retention_days: number;
  /** Module rendered in place of anything withheld. */
  placeholder_module_slug: string;
}

interface GuardRow {
  id: string;
  module_id: string;
  category_key: string;
  detected_hosts: string[];
  status: "pending" | "gated" | "allowed";
  decided_by: string;
}

interface CmsHandle {
  call: <O>(opName: string, input: unknown) => Promise<O>;
}

function cmsOf(ctx: unknown): CmsHandle {
  const cms = (ctx as { cms?: CmsHandle }).cms;
  if (!cms) {
    throw new Error("consent-manager: ctx.cms missing — the cms_admin capability was not granted");
  }
  return cms;
}

/**
 * Which consent category a set of third-party hosts falls under, or
 * null when any of them is unrecognised.
 *
 * Null is deliberately sticky: one unknown host makes the whole module
 * unclassified, because the known ones say nothing about what the
 * unknown one does.
 */
function classifyHosts(hosts: ReadonlyArray<string>): string | null {
  let strongest: string | null = null;
  for (const host of hosts) {
    const match = Object.entries(HOST_CATEGORIES).find(
      ([domain]) => host === domain || host.endsWith(`.${domain}`),
    );
    if (!match) return null;
    const category = match[1];
    // Marketing wins over analytics: a module carrying both must be
    // held to the stricter of the two.
    if (category === "marketing" || strongest === null) strongest = category;
  }
  return strongest;
}

/**
 * Vendors whose category is not in question, so the common cases need
 * no operator decision. Everything else is `pending` until someone
 * says otherwise — the list is a shortcut, never a judgement that an
 * absent host is harmless.
 */
const HOST_CATEGORIES: Readonly<Record<string, string>> = {
  "youtube.com": "marketing",
  "youtube-nocookie.com": "functional",
  "vimeo.com": "marketing",
  "google.com": "marketing",
  "googleapis.com": "marketing",
  "gstatic.com": "functional",
  "googletagmanager.com": "marketing",
  "google-analytics.com": "analytics",
  "doubleclick.net": "marketing",
  "facebook.net": "marketing",
  "facebook.com": "marketing",
  "twitter.com": "marketing",
  "x.com": "marketing",
  "linkedin.com": "marketing",
  "instagram.com": "marketing",
  "hotjar.com": "analytics",
  "openstreetmap.org": "functional",
  "soundcloud.com": "marketing",
  "spotify.com": "marketing",
};

/** Default placeholder module slug, seeded with the settings row. */
const DEFAULT_PLACEHOLDER_SLUG = "consent-placeholder";

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
  await q.insert("settings", {
    policy_version: 1,
    retention_days: 365,
    placeholder_module_slug: DEFAULT_PLACEHOLDER_SLUG,
  });
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
  requestedCapabilities: [
    "cms_admin_schema",
    "chat_runner_tools",
    "cms_admin",
    "domain_events",
    "background_workers",
  ],

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
      placeholder_module_slug: "string",
      created_at: "timestamp",
    },
    /**
     * One verdict per module that reaches a third party. `pending`
     * means the scanner found a host nobody has ruled on yet — and a
     * pending module is WITHHELD, because "we have not decided" and
     * "it is fine" must not render the same.
     */
    module_guards: {
      module_id: "ref:modules:cascade",
      category_key: "string",
      detected_hosts: "jsonb",
      status: "enum:pending,gated,allowed",
      decided_by: "string",
      created_at: "timestamp",
    },
    tags: {
      name: "string",
      vendor: "string",
      category_key: "string",
      script_src: "text",
      inline_snippet: "text",
      position: "enum:head,body_end",
      /** Required for `necessary`; the audit trail for claiming a tag
       *  may run before anyone is asked. */
      justification: "text",
      enabled: "bool",
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
   * Which modules core must withhold (#450). A module whose third-party
   * host has no verdict yet is withheld too — see `scan_modules`.
   */
  deferralsOperation: "consent_deferrals",

  /** Keeps the scan current without anyone remembering to run it. */
  workers: [{ name: "consent-embed-scan", cron: "*/5 * * * *", operationName: "scan_modules" }],

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
    const tags = (await q.list("tags", { limit: 200 })) as unknown as TagRow[];
    const baked: BakedTag[] = tags
      .filter((t) => t.enabled)
      .map((t) => ({
        name: t.name,
        category: t.category_key,
        src: t.script_src,
        inline: t.inline_snippet,
        position: t.position === "head" ? "head" : "body_end",
      }));
    return {
      "runtime.js": buildRuntimeJs(
        {
          slug: SLUG,
          policyVersion: settings.policy_version,
          recordEndpoint: RECORD_ENDPOINT,
          categories: categories.map((c) => ({
            key: c.key,
            displayName: c.display_name,
            required: c.required,
          })),
        },
        buildTagInjector(baked),
      ),
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
     * Core asks which modules to withhold; this answers.
     *
     * `pending` withholds exactly like `gated` does. A module whose
     * vendor nobody has ruled on is not known to be harmless, and
     * rendering it while the question is open would send the request
     * this whole mechanism exists to hold back. The difference between
     * the two is surfaced to the EDITOR, not to the visitor.
     */
    consent_deferrals: async (ctx, args) => {
      const { moduleIds } = args as { moduleIds: string[] };
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      const guards = (await q.list("module_guards", { limit: 1000 })) as unknown as GuardRow[];
      const wanted = new Set(moduleIds);
      const deferrals: Record<string, { reason: string; placeholderModuleSlug: string }> = {};
      for (const g of guards) {
        if (!wanted.has(g.module_id)) continue;
        if (g.status === "allowed") continue;
        deferrals[g.module_id] = {
          reason: g.status === "pending" ? "unclassified" : g.category_key,
          placeholderModuleSlug: settings.placeholder_module_slug,
        };
      }
      return { deferrals };
    },

    /**
     * Scan changed modules for third-party hosts and record a verdict.
     *
     * Runs on a schedule rather than on demand because the operator
     * edits a module and deploys minutes later; a scan that only ran
     * when someone remembered would be a scan that ran after the
     * request went out.
     */
    scan_modules: async (ctx) => {
      const q = adminQueryOf(ctx);
      const cms = cmsOf(ctx);
      const modules = await cms.call<{
        modules: Array<{
          id: string;
          slug: string;
          html: string;
          css: string;
          js: string;
          fields?: unknown;
        }>;
      }>("modules.list", {});
      // The vendor URL is DATA, not markup. Authoring lifts
      // `src="https://youtube.com/…"` out of the HTML into a field
      // default, and a placement can point the same module at a
      // different vendor through its content values. Scanning the HTML
      // alone would therefore find nothing on exactly the modules that
      // matter most.
      const instances = await cms.call<{
        instances: Array<{ moduleId: string; values: unknown }>;
      }>("content_instances.list", {});
      const valuesByModule = new Map<string, string[]>();
      for (const inst of instances.instances) {
        const bucket = valuesByModule.get(inst.moduleId) ?? [];
        bucket.push(JSON.stringify(inst.values ?? {}));
        valuesByModule.set(inst.moduleId, bucket);
      }
      const guards = (await q.list("module_guards", { limit: 1000 })) as unknown as GuardRow[];
      const byModule = new Map(guards.map((g) => [g.module_id, g]));

      let flagged = 0;
      let cleared = 0;
      for (const m of modules.modules) {
        const hosts = externalHosts({
          html: m.html,
          css: m.css,
          js: [m.js, JSON.stringify(m.fields ?? []), ...(valuesByModule.get(m.id) ?? [])].join(
            "\n",
          ),
        });
        const existing = byModule.get(m.id);
        if (hosts.length === 0) {
          // The module stopped reaching out — drop the guard rather than
          // leaving a stale one that withholds a now-harmless module.
          if (existing) {
            await q.delete("module_guards", existing.id);
            cleared += 1;
          }
          continue;
        }
        const known = classifyHosts(hosts);
        if (!existing) {
          await q.insert("module_guards", {
            module_id: m.id,
            category_key: known ?? "marketing",
            detected_hosts: hosts,
            status: known ? "gated" : "pending",
            decided_by: known ? "vendor-table" : "",
          });
          flagged += 1;
          continue;
        }
        // Hosts changed under an existing verdict: the decision was made
        // about a different set, so it no longer applies.
        const before = JSON.stringify(existing.detected_hosts ?? []);
        if (before !== JSON.stringify(hosts)) {
          const rescored = classifyHosts(hosts);
          await q.update("module_guards", existing.id, {
            detected_hosts: hosts,
            category_key: rescored ?? existing.category_key,
            status: rescored ? "gated" : "pending",
            decided_by: rescored ? "vendor-table" : "",
          });
          flagged += 1;
        }
      }
      return { flagged, cleared };
    },

    list_embeds: async (ctx) => {
      const q = adminQueryOf(ctx);
      const guards = (await q.list("module_guards", { limit: 1000 })) as unknown as GuardRow[];
      const cms = cmsOf(ctx);
      const modules = await cms.call<{ modules: Array<{ id: string; slug: string }> }>(
        "modules.list",
        {},
      );
      const slugOf = new Map(modules.modules.map((m) => [m.id, m.slug]));
      return {
        embeds: guards.map((g) => ({
          moduleId: g.module_id,
          moduleSlug: slugOf.get(g.module_id) ?? "(deleted)",
          hosts: g.detected_hosts,
          status: g.status,
          category: g.category_key,
          decidedBy: g.decided_by,
        })),
      };
    },

    classify_embed: async (ctx, args) => {
      const { moduleId, category, allow } = args as {
        moduleId?: unknown;
        category?: unknown;
        allow?: unknown;
      };
      if (typeof moduleId !== "string") throw new Error("classify_embed: `moduleId` is required");
      const q = adminQueryOf(ctx);
      const rows = (await q.list("module_guards", {
        module_id: moduleId,
        limit: 1,
      })) as unknown as GuardRow[];
      const row = rows[0];
      if (!row) {
        throw new Error(
          `classify_embed: module ${moduleId} has no detected third-party host — nothing to classify. Run list_embeds to see what does.`,
        );
      }
      if (allow === true) {
        await q.update("module_guards", row.id, { status: "allowed", decided_by: "operator" });
        return { moduleId, status: "allowed" };
      }
      const categories = await categoriesOf(q);
      const known = new Set(categories.map((c) => c.key));
      if (typeof category !== "string" || !known.has(category)) {
        throw new Error(`classify_embed: \`category\` must be one of ${[...known].join(", ")}`);
      }
      await q.update("module_guards", row.id, {
        category_key: category,
        status: "gated",
        decided_by: "operator",
      });
      return { moduleId, status: "gated", category };
    },

    /**
     * Register a tracking tag. Gated at the tool layer (#452): the SDK
     * pauses for the Owner's in-chat Approve before this runs.
     *
     * The §11.A test is "can the user undo it with one tool call?" —
     * deleting the tag, yes; the data already sent to the vendor, no.
     */
    add_tag: async (ctx, args) => {
      const { name, vendor, category, scriptSrc, inlineSnippet, position, justification } =
        args as {
          name?: unknown;
          vendor?: unknown;
          category?: unknown;
          scriptSrc?: unknown;
          inlineSnippet?: unknown;
          position?: unknown;
          justification?: unknown;
        };
      if (typeof name !== "string" || name.trim().length === 0) {
        throw new Error("add_tag: `name` is required");
      }
      const q = adminQueryOf(ctx);
      const categories = await categoriesOf(q);
      const known = new Set(categories.map((c) => c.key));
      const vendorKey = typeof vendor === "string" ? vendor : "";
      const suggested = KNOWN_VENDORS[vendorKey]?.category;
      const categoryKey = typeof category === "string" ? category : suggested;
      if (!categoryKey || !known.has(categoryKey)) {
        throw new Error(
          `add_tag: \`category\` must be one of ${[...known].join(", ")}${
            suggested ? ` (${vendorKey} is normally ${suggested})` : ""
          }`,
        );
      }
      const src =
        typeof scriptSrc === "string" && scriptSrc.length > 0
          ? scriptSrc
          : (KNOWN_VENDORS[vendorKey]?.scriptSrc ?? "");
      const inline = typeof inlineSnippet === "string" ? inlineSnippet : "";
      if (src.length === 0 && inline.length === 0) {
        throw new Error("add_tag: give the tag something to load — `scriptSrc` or `inlineSnippet`");
      }
      const reason = typeof justification === "string" ? justification.trim() : "";
      // A `necessary` tag runs for everyone, unasked. That is right for
      // a session cookie and wrong for anything that measures or follows
      // a visitor, so claiming it costs a written reason — otherwise
      // "necessary" is just the category that makes the banner stop
      // being an obstacle.
      if (categoryKey === "necessary" && reason.length < 20) {
        throw new Error(
          "add_tag: a tag in `necessary` runs before the visitor is asked, so it needs a written `justification` saying why it is strictly required. If it measures or follows visitors, it belongs in analytics or marketing instead.",
        );
      }
      const existing = (await q.list("tags", { name, limit: 1 })) as unknown as TagRow[];
      if (existing[0]) {
        throw new Error(`add_tag: a tag named "${name}" already exists — remove it first`);
      }
      const r = await q.insert("tags", {
        name,
        vendor: vendorKey,
        category_key: categoryKey,
        script_src: src,
        inline_snippet: inline,
        position: position === "head" ? "head" : "body_end",
        justification: reason,
        enabled: true,
      });
      return { tagId: r.id, name, category: categoryKey };
    },

    list_tags: async (ctx) => {
      const q = adminQueryOf(ctx);
      const tags = (await q.list("tags", { limit: 200 })) as unknown as TagRow[];
      return {
        tags: tags.map((t) => ({
          id: t.id,
          name: t.name,
          vendor: t.vendor,
          category: t.category_key,
          loads: t.script_src || "(inline snippet)",
          position: t.position,
          enabled: t.enabled,
          justification: t.justification,
        })),
        knownVendors: Object.entries(KNOWN_VENDORS).map(([key, v]) => ({
          vendor: key,
          category: v.category,
          note: v.note,
        })),
      };
    },

    remove_tag: async (ctx, args) => {
      const { name } = args as { name?: unknown };
      if (typeof name !== "string") throw new Error("remove_tag: `name` is required");
      const q = adminQueryOf(ctx);
      const rows = (await q.list("tags", { name, limit: 1 })) as unknown as TagRow[];
      const row = rows[0];
      if (!row) throw new Error(`remove_tag: no tag named "${name}"`);
      await q.delete("tags", row.id);
      return { removed: name };
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

  tools: CONSENT_TOOLS,

  skills: CONSENT_SKILLS,
});
