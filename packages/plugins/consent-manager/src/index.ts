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
 * attributes, and a `consent_categories` list source (#447) the banner
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
 * first; see `export_log`). They are personal data, so the AI sees them
 * only as counts (`consent_stats`); the rows are the Owner's.
 */

import {
  definePlugin,
  type PluginAdminQuery,
  type PluginContextTier1,
  z,
} from "@caelo-cms/plugin-sdk";
import { DEFAULT_CATEGORIES } from "./categories.js";
import { consentLogCsv, consentLogPage, consentStats, describeConsentLog } from "./consent-log.js";
import {
  CONSENT_VENDOR_FIELDS,
  consentPurposesOf,
  usedCategoryKeys,
  vendorEntries,
} from "./declaration.js";
import { defaultPlaceholder } from "./placeholder.js";
import { buildRuntimeJs, CONSENT_COOKIE, RUNTIME_CSS } from "./runtime.js";
import { deferralReason, moduleHosts } from "./scan.js";
import { CONSENT_SKILLS } from "./skills.js";
import {
  adminQueryOf,
  bumpPolicyVersion,
  categoriesOf,
  cmsOf,
  type GuardRow,
  settingsOf,
} from "./storage.js";
import { addTag, bakeTags, listTags, removeTag, updateTagsMany } from "./tag-ops.js";
import { buildTagInjector, describeIssues, type TagRow } from "./tags.js";
import { CONSENT_TOOLS } from "./tools.js";

const SLUG = "consent-manager";
const RECORD_ENDPOINT = `/api/plugin/${SLUG}/record_consent`;

/** A visitor's decision as the runtime posts it through the gateway. */
const recordConsentArgs = z.object({
  consentId: z.string().uuid(),
  granted: z
    .array(
      z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9_-]*$/),
    )
    .max(32),
  policyVersion: z.number().int().positive(),
});

/**
 * What the Owner may change in the consent panel. Retention has a floor
 * because a decision stays valid for the consent cookie's year: proof of
 * it must outlive it, or the log cannot demonstrate a consent still in use.
 */
const settingsArgs = z
  .object({
    retentionDays: z.number().int().min(365).max(3650),
    placeholderModuleSlug: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be a module slug"),
  })
  .strict();

/** A module's third-party hosts now, next to the verdict stored for it (if any). */
interface EmbedScan {
  readonly moduleId: string;
  readonly moduleSlug: string;
  /** Site chrome (header, footer, navigation): withheld, it vanishes from every page. */
  readonly siteChrome: boolean;
  readonly hosts: string[];
  readonly guard: GuardRow | undefined;
}

/** The verdict a guard row should hold, as stored fields. */
type GuardVerdict = Pick<GuardRow, "category_key" | "detected_hosts" | "status" | "decided_by">;

/**
 * What a module's guard should say given the hosts it reaches now (the
 * same `moduleHosts` judgement the render-time gate applies):
 *
 * - `null` — no third-party host; any stored guard is stale.
 * - the stored guard — the hosts it was decided about are unchanged.
 * - a fresh verdict — vendor-table classification, else pending.
 */
function verdictFor(scan: EmbedScan): GuardVerdict | null {
  if (scan.hosts.length === 0) return null;
  const existing = scan.guard;
  if (existing && JSON.stringify(existing.detected_hosts ?? []) === JSON.stringify(scan.hosts)) {
    return existing;
  }
  // Hosts changed under an existing verdict (or none was recorded): the
  // decision was made about a different set, so it no longer applies.
  const known = classifyHosts(scan.hosts);
  return {
    category_key: known ?? existing?.category_key ?? "marketing",
    detected_hosts: scan.hosts,
    status: known ? "gated" : "pending",
    decided_by: known ? "vendor-table" : "",
  };
}

/**
 * Every module with its current hosts and stored guard. Read-only; in a
 * chat it reads the chat's branch, so the AI sees the modules it just
 * edited.
 */
async function scanEmbeds(ctx: PluginContextTier1): Promise<EmbedScan[]> {
  const q = adminQueryOf(ctx);
  const cms = cmsOf(ctx);
  const modules = await cms.call<{
    modules: Array<{
      id: string;
      slug: string;
      kind: string;
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
  const valuesByModule = new Map<string, unknown[]>();
  for (const inst of instances.instances) {
    const bucket = valuesByModule.get(inst.moduleId) ?? [];
    bucket.push(inst.values ?? {});
    valuesByModule.set(inst.moduleId, bucket);
  }
  const guards = (await q.list("module_guards", { limit: 1000 })) as unknown as GuardRow[];
  const byModule = new Map(guards.map((g) => [g.module_id, g]));
  return modules.modules.map((m) => ({
    moduleId: m.id,
    moduleSlug: m.slug,
    siteChrome: m.kind === "chrome",
    hosts: moduleHosts({ ...m, contentValues: valuesByModule.get(m.id) ?? [] }),
    guard: byModule.get(m.id),
  }));
}

/** A module the render-time gate withholds now, and why. */
interface Withheld {
  readonly scan: EmbedScan;
  /** A consent category key, or `unclassified` while nobody has ruled. */
  readonly reason: string;
}

/**
 * Every module the render-time gate would withhold right now — the same
 * `deferralReason` judgement, over the same scan `list_embeds` reports.
 */
async function withheldModules(ctx: PluginContextTier1): Promise<Withheld[]> {
  const out: Withheld[] = [];
  for (const scan of await scanEmbeds(ctx)) {
    const reason = deferralReason(scan.hosts, scan.guard, classifyHosts);
    if (reason !== null) out.push({ scan, reason });
  }
  return out;
}

/** The categories the banner offers: required ones plus everything something uses. */
async function offeredCategories(ctx: PluginContextTier1, withheld: ReadonlyArray<Withheld>) {
  const q = adminQueryOf(ctx);
  const categories = await categoriesOf(q);
  const used = await usedCategoryKeys(
    q,
    categories,
    await consentPurposesOf(ctx),
    new Set(withheld.map((w) => w.reason).filter((r) => r !== "unclassified")),
  );
  return { categories, used };
}

/**
 * Bring every module's guard row in line with what it reaches now. The
 * scheduled scan (`scan_modules`, a worker on main) is the only writer;
 * `list_embeds` reports the same verdicts without storing them.
 */
async function syncGuards(ctx: PluginContextTier1): Promise<{ flagged: number; cleared: number }> {
  const q = adminQueryOf(ctx);
  let flagged = 0;
  let cleared = 0;
  for (const scan of await scanEmbeds(ctx)) {
    const verdict = verdictFor(scan);
    const existing = scan.guard;
    if (verdict === null) {
      // The module stopped reaching out — drop the guard rather than
      // leaving a stale one that withholds a now-harmless module.
      if (existing) {
        await q.delete("module_guards", existing.id);
        cleared += 1;
      }
      continue;
    }
    if (verdict === existing) continue;
    if (existing) {
      await q.update("module_guards", existing.id, verdict);
    } else {
      await q.insert("module_guards", { module_id: scan.moduleId, ...verdict });
    }
    flagged += 1;
  }
  return { flagged, cleared };
}

/** The module an operator decision is about; refuses one with no third-party host. */
async function embedToDecide(
  ctx: PluginContextTier1,
  op: string,
  moduleId: string,
): Promise<EmbedScan> {
  const scan = (await scanEmbeds(ctx)).find((e) => e.moduleId === moduleId);
  if (!scan || scan.hosts.length === 0) {
    throw new Error(
      `${op}: module ${moduleId} has no detected third-party host — nothing to decide. Run list_external_embeds to see what does.`,
    );
  }
  return scan;
}

/**
 * Store a decision about the hosts the module reaches now; the row may
 * not exist yet, since only the scheduled scan records them. A chat call
 * is the AI's decision (an approved one is the approver's), and the
 * stored `decided_by` says so rather than crediting the operator.
 */
async function recordEmbedVerdict(
  ctx: PluginContextTier1,
  scan: EmbedScan,
  decision: Pick<GuardRow, "category_key" | "status">,
): Promise<void> {
  const q = adminQueryOf(ctx);
  const decidedBy = ctx.invocation.origin === "chat" ? "ai" : "operator";
  const fields = { ...decision, detected_hosts: scan.hosts, decided_by: decidedBy };
  if (scan.guard) await q.update("module_guards", scan.guard.id, fields);
  else await q.insert("module_guards", { module_id: scan.moduleId, ...fields });
}

const deferralsArgs = z.object({
  modules: z.array(
    z.object({
      moduleId: z.string().uuid(),
      html: z.string(),
      css: z.string(),
      js: z.string(),
      fields: z.unknown(),
      contentValues: z.array(z.unknown()),
    }),
  ),
});

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

/**
 * Write the create-time defaults — the one settings row and the default
 * categories — when they are missing. Runs from `onActivate`, on main:
 * render and visitor calls cannot write private storage, so the read
 * helpers below never seed (CMS_REQUIREMENTS §14.7). The host serializes
 * activations (#1144), so the check-then-insert below cannot race; an
 * install seeded twice before that collapses here to one settings row and
 * one category per key (the oldest of each), so its next build passes the
 * duplicate-id check of list sources.
 */
async function seedDefaults(q: PluginAdminQuery): Promise<void> {
  const settings = await q.list<string, { id: string }>("settings", {
    orderBy: "created_at",
    orderDir: "asc",
    limit: 1000,
  });
  if (settings.length === 0) {
    await q.insert("settings", {
      policy_version: 1,
      retention_days: 365,
      placeholder_module_slug: DEFAULT_PLACEHOLDER_SLUG,
    });
  }
  for (const extra of settings.slice(1)) await q.delete("settings", extra.id);

  const categories = await q.list<string, { id: string; key: string }>("categories", {
    orderBy: "created_at",
    orderDir: "asc",
    limit: 1000,
  });
  if (categories.length === 0) {
    for (const c of DEFAULT_CATEGORIES) {
      await q.insert("categories", {
        key: c.key,
        display_name: c.displayName,
        description: c.description,
        required: c.required,
        position: c.position,
      });
    }
    return;
  }
  const seen = new Set<string>();
  for (const c of categories) {
    if (seen.has(c.key)) await q.delete("categories", c.id);
    else seen.add(c.key);
  }
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
    "list_sources",
    "consent_provider",
  ],

  /** Proof of consent. Written by the gateway on a visitor request. */
  schema: {
    consent_log: {
      /** Random, from the consent cookie itself; see `describeConsentLog`. */
      consent_id: "uuid",
      granted: "jsonb",
      policy_version: "int",
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
      /** Last change to the cookie declaration; the date the privacy page shows. */
      declaration_updated_at: "timestamp",
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
      /** Validated vendor ids (`{measurementId}`) a known vendor's code is built from. */
      config: "jsonb",
      /** `[{name, pattern?, lifetime, purpose}]` — declared, and deleted on withdrawal. */
      cookies: "jsonb",
      /** Recipient, seat, purpose, legal basis, third country, transfer basis, privacy URL. */
      vendor_info: "jsonb",
      /** Where it runs: path globs, page ids, template ids, locales. */
      scope: "jsonb",
      updated_at: "timestamp",
      created_at: "timestamp",
    },
  },

  /** Only the record itself. Everything else is the Owner's. */
  publicOperations: ["record_consent"],

  /**
   * What the API gateway may read of the private storage (#635): the
   * current policy version (the consent rule + `record_consent`'s version
   * check) and the category keys (`record_consent` rejects unknown ones).
   * The gateway has no cms_admin login; the admin publishes exactly these
   * columns into cms_public. Tags, guards and descriptions stay private.
   */
  visitorProjection: {
    settings: ["policy_version"],
    categories: ["key", "position"],
  },

  /**
   * The banner iterates this instead of receiving markup from the
   * plugin, so it looks like the site it lives on. Placing that module
   * in the LAYOUT covers every page from one placement.
   */
  listSources: [
    {
      name: "consent_categories",
      label: "Consent categories",
      description:
        "The consent categories a visitor can accept or decline, in display order. Always non-empty while the plugin runs.",
      node: {
        label: "Consent category",
        fields: [
          { name: "key", label: "Key", type: "text", required: true, maxLength: 64 },
          { name: "label", label: "Label", type: "text", required: true },
          { name: "description", label: "Description", type: "text", maxLength: 2000 },
          { name: "required", label: "Always on", type: "boolean" },
          { name: "used", label: "Controls something on this site", type: "boolean" },
        ],
      },
    },
    {
      name: "consent_vendors",
      label: "Cookie declaration",
      description:
        "Every recipient of visitor data and the cookies it sets, grouped by consent category, with the date the declaration last changed. For the privacy page's cookie table.",
      node: { label: "Recipient", fields: CONSENT_VENDOR_FIELDS },
    },
  ],
  listSourcesOperation: "consent_data_lists",

  /**
   * Which modules core must withhold (#450). A module whose third-party
   * host has no verdict yet is withheld too — see `scan_modules`.
   */
  deferralsOperation: "consent_deferrals",

  /** Keeps the scan current without anyone remembering to run it. */
  workers: [
    { name: "consent-embed-scan", cron: "*/5 * * * *", operationName: "scan_modules" },
    // Keeping consent evidence forever is itself a data-protection
    // problem, so the window is enforced rather than documented.
    { name: "consent-log-retention", cron: "17 3 * * *", operationName: "prune_log" },
  ],

  /**
   * The runtime + its stylesheet, with this site's categories baked in
   * (#449). Baked rather than fetched because the runtime has to decide
   * whether a tag may fire before anything else loads, and a static
   * site cannot afford a blocking request to find out.
   */
  onActivate: async (ctx) => {
    await seedDefaults(adminQueryOf(ctx));
  },

  buildAssets: async (ctx) => {
    const q = adminQueryOf(ctx);
    const settings = await settingsOf(q);
    // Only what the banner offers can be granted: "accept all" must not
    // record consent to a category the visitor was never shown, or a
    // plugin activated later would run under a consent nobody gave.
    const { categories: all, used } = await offeredCategories(ctx, await withheldModules(ctx));
    const categories = all.filter((c) => c.required || used.has(c.key));
    const baked = await bakeTags(ctx);
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
      // A consent row is evidence: one with a shape, category or policy
      // version the site never offered is worse than none, because it
      // looks like proof.
      const parsed = recordConsentArgs.safeParse(args);
      if (!parsed.success) {
        throw new Error(
          "record_consent: expected `consentId` as a UUID, `granted` as an array of category keys (at most 32) and `policyVersion` as a positive integer",
        );
      }
      const { consentId, granted, policyVersion } = parsed.data;
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      if (policyVersion !== settings.policy_version) {
        throw new Error(
          `record_consent: policy version ${policyVersion} is not the current one (${settings.policy_version}); the visitor must be asked again`,
        );
      }
      const known = new Set((await categoriesOf(q)).map((c) => c.key));
      const unknown = granted.filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new Error(`record_consent: unknown consent categories: ${unknown.join(", ")}`);
      }
      // The record holds the decision and the consent cookie's own random
      // id, nothing that identifies the visitor anywhere else: the visitor
      // id belongs to the plugins that declared it (#1136 round).
      await ctx.query.insert("consent_log", {
        consent_id: consentId,
        granted: [...new Set(granted)],
        policy_version: policyVersion,
      });
      return { recorded: true };
    },

    consent_data_lists: async (ctx, args) => {
      const { pageIds } = args as { pageIds: string[] };
      const q = adminQueryOf(ctx);
      const purposes = await consentPurposesOf(ctx);
      const { categories, used } = await offeredCategories(ctx, await withheldModules(ctx));
      // Only real choices (#1129): the required categories, told rather
      // than asked, plus the ones something on the site is pinned to.
      // The category key is the entry id: stable across renders, and the
      // same thing the banner's data-consent-category hook names.
      const entries = categories
        .filter((c) => c.required || used.has(c.key))
        .map((c) => ({
          id: c.key,
          values: {
            key: c.key,
            label: c.display_name,
            description: c.description,
            required: c.required,
            used: used.has(c.key),
          },
        }));
      const tags = (await q.list("tags", { limit: 200 })) as unknown as TagRow[];
      const vendors = vendorEntries({
        categories,
        tags,
        purposes,
        settings: await settingsOf(q),
      });
      // The same lists on every page: the banner is site chrome, and a
      // per-page answer would invite placing it per page.
      const sources: Record<string, Record<string, unknown[]>> = {};
      for (const id of pageIds) {
        sources[id] = { consent_categories: entries, consent_vendors: vendors };
      }
      return { sources };
    },

    /** Everything the AI needs to set the banner up, in one call. */
    consent_status: async (ctx) => {
      const q = adminQueryOf(ctx);
      const declared = await consentPurposesOf(ctx);
      const settings = await settingsOf(q);
      const withheld = await withheldModules(ctx);
      const { categories, used } = await offeredCategories(ctx, withheld);
      // What visitors do not see right now (#1123): reported here so the
      // AI can tell the operator straight after activation, before they
      // find a missing header themselves.
      const withheldNow = withheld.map(({ scan, reason }) => ({
        moduleId: scan.moduleId,
        moduleSlug: scan.moduleSlug,
        hosts: scan.hosts,
        status: reason === "unclassified" ? "pending" : "gated",
        ...(reason === "unclassified" ? {} : { category: reason }),
        siteChrome: scan.siteChrome,
      }));
      return {
        policyVersion: settings.policy_version,
        retentionDays: settings.retention_days,
        categories: categories.map((c) => ({
          key: c.key,
          displayName: c.display_name,
          description: c.description,
          required: c.required,
          // Only used and required categories reach the banner's list.
          used: used.has(c.key),
        })),
        withheldNow,
        ...(withheldNow.some((w) => w.siteChrome)
          ? {
              withheldNote:
                "Site chrome (header, footer, navigation) is withheld: visitors see a placeholder instead on EVERY page. Tell the operator now, then resolve each module with classify_external_embed (or allow_external_embed, which asks the Owner to approve).",
            }
          : {}),
        consentLog: describeConsentLog(settings.retention_days),
        bannerContract: {
          list: "{{#consent_categories}}…{{/consent_categories}} with key, label, description, required, used — only the required categories and the ones something on the site uses",
          declaration:
            "{{#consent_vendors}}…{{/consent_vendors}} with category, category_label, category_first, vendor, vendor_seat, purpose, legal_basis, third_country, transfer_basis, privacy_policy (link), cookies, updated — the cookie declaration for the privacy page",
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
        // The cookies the site's own code sets, so the banner's category
        // copy and the privacy policy can name them (#677): this plugin's
        // decision cookie, plus whatever the active plugins declare
        // (`consentPurposes`). Registered tags add their vendors' cookies
        // on top.
        siteCookies: [
          {
            name: CONSENT_COOKIE,
            category: "necessary",
            lifetime: "1 year",
            purpose: "Remembers the visitor's consent choice.",
          },
          ...declared.flatMap((p) =>
            p.cookies.map((c) => ({
              name: c.name,
              category: p.category,
              lifetime: c.lifetime,
              purpose: c.purpose,
              declaredBy: p.pluginSlug,
            })),
          ),
        ],
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
      const { modules } = deferralsArgs.parse(args);
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      const labelOf = new Map((await categoriesOf(q)).map((c) => [c.key, c.display_name]));
      const deferrals: Record<
        string,
        {
          reason: string;
          placeholderModuleSlug: string;
          defaultPlaceholder: { html: string; css: string };
        }
      > = {};
      for (const m of modules) {
        const hosts = moduleHosts(m);
        if (hosts.length === 0) continue;
        // Looked up per module: a list capped at 1000 rows would drop the
        // verdicts of every module past it, and those would ship ungated.
        const [guard] = (await q.list("module_guards", {
          module_id: m.moduleId,
          limit: 1,
        })) as unknown as GuardRow[];
        const reason = deferralReason(hosts, guard, classifyHosts);
        if (reason === null) continue;
        deferrals[m.moduleId] = {
          reason,
          placeholderModuleSlug: settings.placeholder_module_slug,
          defaultPlaceholder: defaultPlaceholder(reason, labelOf.get(reason) ?? null),
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
    scan_modules: async (ctx) => syncGuards(ctx),

    // Read-only: reports the verdict every module would get now, stored
    // or not, so the list is never older than what the render gate
    // withholds — without a read tool writing author data.
    list_embeds: async (ctx) => {
      const embeds = [];
      for (const scan of await scanEmbeds(ctx)) {
        const verdict = verdictFor(scan);
        if (verdict === null) continue;
        embeds.push({
          moduleId: scan.moduleId,
          moduleSlug: scan.moduleSlug,
          hosts: verdict.detected_hosts,
          status: verdict.status,
          category: verdict.category_key,
          decidedBy: verdict.decided_by,
        });
      }
      return { embeds };
    },

    // Only the direction that keeps a module withheld until consent. A
    // category every visitor is in (`necessary`) renders the module for
    // everyone, which is allow_embed's decision and needs its approval.
    classify_embed: async (ctx, args) => {
      const { moduleId, category } = args as { moduleId?: unknown; category?: unknown };
      if (typeof moduleId !== "string") throw new Error("classify_embed: `moduleId` is required");
      const q = adminQueryOf(ctx);
      const scan = await embedToDecide(ctx, "classify_embed", moduleId);
      const consentCategories = (await categoriesOf(q)).filter((c) => !c.required);
      if (typeof category !== "string" || !consentCategories.some((c) => c.key === category)) {
        throw new Error(
          `classify_embed: \`category\` must be one of ${consentCategories.map((c) => c.key).join(", ")}. To render the module for every visitor without consent, use allow_external_embed (it asks the Owner to approve).`,
        );
      }
      await recordEmbedVerdict(ctx, scan, { category_key: category, status: "gated" });
      return { moduleId, status: "gated", category };
    },

    // The loosening direction: the module renders for every visitor,
    // before any consent. A §11.A tool (approvalMode), so a chat reaches
    // this only through the Owner's click, and the approver sees the
    // hosts they let through — which must be exactly the ones the module
    // reaches now, or the approval would cover requests nobody named.
    allow_embed: async (ctx, args) => {
      const { moduleId, moduleSlug, hosts } = args as {
        moduleId?: unknown;
        moduleSlug?: unknown;
        hosts?: unknown;
      };
      if (typeof moduleId !== "string") throw new Error("allow_embed: `moduleId` is required");
      const scan = await embedToDecide(ctx, "allow_embed", moduleId);
      if (moduleSlug !== scan.moduleSlug) {
        throw new Error(
          `allow_embed: module ${moduleId} is "${scan.moduleSlug}", not ${JSON.stringify(moduleSlug)}. Pass the slug list_external_embeds reports.`,
        );
      }
      const named = Array.isArray(hosts) ? [...hosts].map(String).sort() : [];
      if (JSON.stringify(named) !== JSON.stringify(scan.hosts)) {
        throw new Error(
          `allow_embed: module "${scan.moduleSlug}" reaches ${scan.hosts.join(", ")} now, not ${named.join(", ") || "nothing"}. Call list_external_embeds again and ask for approval of exactly those hosts.`,
        );
      }
      await recordEmbedVerdict(ctx, scan, {
        category_key: scan.guard?.category_key ?? "marketing",
        status: "allowed",
      });
      return { moduleId, status: "allowed" };
    },

    add_tag: async (ctx, args) => addTag(ctx, args),
    update_tags_many: async (ctx, args) => updateTagsMany(ctx, args),
    list_tags: async (ctx) => listTags(ctx),
    remove_tag: async (ctx, args) => removeTag(ctx, args),

    /** How visitors decide, in aggregate (#1131) — counts only, never a record. */
    consent_stats: async (ctx, args) => {
      const { categories, used } = await offeredCategories(ctx, await withheldModules(ctx));
      return consentStats(ctx.query, args, categories, used);
    },

    /**
     * The evidence half of the obligation: who consented to what, when.
     *
     * Returned as CSV text rather than written to a file, because the
     * operator's next step is always to hand it to someone — a DPO, an
     * auditor, a form — and a path inside the install is not that.
     *
     * Deactivating the plugin stops it running; UNINSTALL drops its
     * schema and takes these rows with it. Export before that, not
     * after: there is no recovery path once the schema is gone.
     *
     * No AI tool reaches it: the rows are personal data, so only the
     * Owner exports them, from the admin panel.
     */
    export_log: async (ctx) => consentLogCsv(ctx.query),

    /** One newest-first page of the log for the Owner's consent panel. */
    list_log: async (ctx, args) => consentLogPage(ctx.query, args),

    /** The settings the Owner edits in the consent panel. */
    get_settings: async (ctx) => {
      const settings = await settingsOf(adminQueryOf(ctx));
      return {
        retentionDays: settings.retention_days,
        placeholderModuleSlug: settings.placeholder_module_slug,
        policyVersion: settings.policy_version,
      };
    },

    set_settings: async (ctx, args) => {
      const parsed = settingsArgs.safeParse(args);
      if (!parsed.success) throw new Error(describeIssues("set_settings", parsed.error));
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      await q.update("settings", settings.id, {
        retention_days: parsed.data.retentionDays,
        placeholder_module_slug: parsed.data.placeholderModuleSlug,
      });
      return { retentionDays: parsed.data.retentionDays };
    },

    /**
     * Drop records past the retention window.
     *
     * Keeping consent evidence forever is itself a data-protection
     * problem, so the window is data the operator sets rather than a
     * constant nobody revisits.
     */
    prune_log: async (ctx) => {
      const q = adminQueryOf(ctx);
      const settings = await settingsOf(q);
      const cutoff = Date.now() - settings.retention_days * 24 * 60 * 60 * 1000;
      // Oldest first, a batch at a time, until the oldest remaining
      // record is inside the window. A single capped pass per day never
      // caught up on a site recording more decisions than the cap.
      const batch = 1000;
      let deleted = 0;
      for (;;) {
        const oldest = (await ctx.query.list("consent_log", {
          limit: batch,
          orderBy: "created_at",
          orderDir: "asc",
        })) as unknown as Array<{ id: string; created_at: string | Date }>;
        let reachedWindow = false;
        for (const row of oldest) {
          // Compare instants, not strings. The driver hands back a Date
          // (or a Postgres timestamp string, whose format differs from an
          // ISO one) and lexical comparison across those two silently
          // deletes records that are well inside the window.
          const at = new Date(row.created_at).getTime();
          if (!Number.isFinite(at)) {
            throw new Error(`prune_log: unreadable created_at on consent record ${row.id}`);
          }
          if (at >= cutoff) {
            reachedWindow = true;
            break;
          }
          await ctx.query.delete("consent_log", row.id);
          deleted += 1;
        }
        if (reachedWindow || oldest.length < batch) break;
      }
      return { deleted, cutoff: new Date(cutoff).toISOString() };
    },

    /**
     * Core's question to the consent provider (#677): which cookie holds
     * the visitor's decision, which policy version a decision must carry
     * to count, and which category covers each purpose the active plugins
     * declare. The API gateway asks before it sets `caelo_visitor_id`
     * (the `visitor_id` purpose).
     *
     * The categories are the declaring plugins' own (`consentPurposes`,
     * read through `ctx.consentPurposes`): the plugin that needs a purpose
     * knows what it is for. Two plugins declaring one key under different
     * categories get the stricter one (marketing > analytics >
     * functional), so a visitor is never recognised under a looser
     * consent than one of the uses asks for. No declaring plugin, no
     * entry — and the gateway sets no cookie for a purpose nobody uses.
     */
    visitor_consent_rule: async (ctx) => {
      const settings = await settingsOf(adminQueryOf(ctx));
      const strictness = ["functional", "analytics", "marketing"];
      const purposes: Record<string, string> = {};
      for (const p of await consentPurposesOf(ctx)) {
        const current = purposes[p.key];
        if (current === undefined || strictness.indexOf(p.category) > strictness.indexOf(current)) {
          purposes[p.key] = p.category;
        }
      }
      return {
        cookie: CONSENT_COOKIE,
        policyVersion: settings.policy_version,
        purposes,
      };
    },

    /**
     * Re-ask everyone. Separate from `describe_categories` because
     * rewording a description is cosmetic while invalidating consent
     * puts the banner back in front of every visitor.
     */
    bump_policy_version: async (ctx) => ({
      policyVersion: await bumpPolicyVersion(adminQueryOf(ctx)),
    }),
  },

  /**
   * The Owner's view of the consent log. `privacy.view`, which only the
   * Owner role holds: the log is personal data, so editors and the AI see
   * the aggregate `consent_stats` and nothing row by row.
   */
  adminPanels: [
    {
      slug: "consent",
      title: "Consent",
      description:
        "How visitors answer the cookie banner, the record of every decision, and how long it is kept.",
      icon: "shield-check",
      permission: "privacy.view",
      sections: [
        {
          kind: "stats",
          id: "rates",
          title: "Last 30 days",
          description:
            'Share of decisions; "accept all" means every optional category the banner offers now.',
          operation: "consent_stats",
          args: { days: 30 },
          items: [
            { key: "decisions", label: "Decisions", format: "number" },
            { key: "acceptAll.percent", label: "Accept all (%)", format: "number", decimals: 1 },
            { key: "rejectAll.percent", label: "Reject all (%)", format: "number", decimals: 1 },
            { key: "custom.percent", label: "Custom choice (%)", format: "number", decimals: 1 },
          ],
        },
        {
          kind: "stats",
          id: "categories",
          title: "Per category, last 30 days",
          operation: "consent_stats",
          args: { days: 30 },
          entriesKey: "categoryShares",
        },
        {
          kind: "table",
          id: "log",
          title: "Consent log",
          description:
            "Every decision, newest first: the proof of consent an authority or a data protection officer asks for.",
          operation: "list_log",
          rowsKey: "rows",
          rowKey: "id",
          emptyMessage: "No decisions recorded yet.",
          columns: [
            { key: "recordedAt", label: "Recorded", format: "datetime" },
            { key: "consentId", label: "Consent id", format: "code" },
            { key: "policyVersion", label: "Policy version", format: "number" },
            { key: "granted", label: "Granted", format: "list" },
          ],
          paging: {
            pageSize: 50,
            limitArg: "limit",
            // The last row's own timestamp is the cursor: `list_log` cuts each
            // page at a millisecond boundary, so it equals its `nextBefore`.
            cursor: { arg: "before", key: "recordedAt" },
            hasMoreKey: "hasMore",
          },
          download: {
            label: "Download CSV",
            operation: "export_log",
            csvKey: "csv",
            filename: "consent-log.csv",
          },
        },
        {
          kind: "settings",
          id: "settings",
          title: "Settings",
          readOperation: "get_settings",
          writeOperation: "set_settings",
          submitLabel: "Save",
          successMessage: "Saved. Records older than {retentionDays} days are deleted nightly.",
          fields: [
            {
              arg: "retentionDays",
              valueKey: "retentionDays",
              label: "Keep records for (days)",
              description:
                "At least a year: a decision stays valid for a year, and its record has to prove it for that long.",
              input: "number",
              required: true,
              integer: true,
              min: 365,
              max: 3650,
            },
            {
              arg: "placeholderModuleSlug",
              valueKey: "placeholderModuleSlug",
              label: "Placeholder module",
              description: "The module shown in place of an embed until the visitor agrees.",
              input: "text",
              required: true,
              maxLength: 120,
            },
          ],
        },
      ],
    },
  ],

  tools: CONSENT_TOOLS,

  skills: CONSENT_SKILLS,
});
