// SPDX-License-Identifier: MPL-2.0

/**
 * What the site actually does with consent: which categories control
 * something (#1129) and the cookie declaration built from the same data
 * (#1133).
 *
 * ## Why the banner only offers used categories
 *
 * A checkbox for a category nothing on the site belongs to is a choice
 * that controls nothing, and visitors read it as a claim that the site
 * does such tracking. So `consent_categories` lists the required
 * categories plus the ones something is pinned to: an enabled tag, an
 * embed withheld under that category, or a consent purpose another
 * active plugin declared. An embed still awaiting classification does
 * not count: its placeholder offers nothing to grant until the operator
 * rules on it, so neither may the banner.
 */

import type {
  DeclaredConsentPurpose,
  PluginAdminQuery,
  PluginContextTier1,
  PluginListSourceSpec,
} from "@caelo-cms/plugin-sdk";
import type { CategoryRow } from "./categories.js";
import { CONSENT_COOKIE } from "./runtime.js";
import { isoDate, type SettingsRow } from "./storage.js";
import { type CookieDecl, cookieLabel, defaultLegalBasis, type TagRow } from "./tags.js";

/**
 * The purposes the active plugins declared, read through the
 * `consent_provider` grant. Missing means the grant was not given, and a
 * consent provider that cannot see what the site asks visitors for would
 * offer the wrong choices, so that fails loudly (CLAUDE.md §2).
 */
export async function consentPurposesOf(
  ctx: PluginContextTier1,
): Promise<ReadonlyArray<DeclaredConsentPurpose>> {
  if (!ctx.consentPurposes) {
    throw new Error(
      "consent-manager: ctx.consentPurposes missing — the consent_provider capability was not granted. Approve that grant for consent-manager at /settings/plugins.",
    );
  }
  return ctx.consentPurposes.list();
}

/**
 * The category keys something is pinned to.
 *
 * @param embedCategories the categories withheld embeds wait for, from
 *   the stored verdicts. Those are rewritten on the write that adds an
 *   embed (`module_changes`, #1214), not only by the 5-minute scan, so a
 *   banner built right after an embed was added offers the category its
 *   placeholder asks for.
 */
export async function usedCategoryKeys(
  q: PluginAdminQuery,
  categories: ReadonlyArray<CategoryRow>,
  purposes: ReadonlyArray<DeclaredConsentPurpose>,
  embedCategories: ReadonlySet<string>,
): Promise<Set<string>> {
  const used = new Set([...purposes.map((p) => p.category), ...embedCategories]);
  for (const c of categories) {
    if (c.required || used.has(c.key)) continue;
    // `limit: 1` asks "is there any", which stays cheap however many
    // tags a site has.
    if ((await q.list("tags", { category_key: c.key, enabled: true, limit: 1 })).length > 0) {
      used.add(c.key);
    }
  }
  return used;
}

/** One row of the cookie declaration, as the `consent_vendors` list source carries it. */
export interface VendorEntry {
  id: string;
  values: Record<string, unknown>;
}

function cookieSummary(cookies: ReadonlyArray<CookieDecl>): string {
  return cookies.map((c) => `${cookieLabel(c)} (${c.lifetime}): ${c.purpose}`).join(" · ");
}

/**
 * The cookie declaration: every recipient of visitor data, grouped by
 * category in display order. Lists are flat, so `category_first` marks
 * the first entry of a group for its heading and `cookies` is one line.
 * `updated` is the date the declaration last changed — the date a
 * privacy page has to show.
 */
export function vendorEntries(args: {
  categories: ReadonlyArray<CategoryRow>;
  tags: ReadonlyArray<TagRow>;
  purposes: ReadonlyArray<DeclaredConsentPurpose>;
  settings: SettingsRow;
}): VendorEntry[] {
  const updated = isoDate(args.settings.declaration_updated_at);
  const rows: Array<{ category: string; id: string; values: Record<string, unknown> }> = [];
  // The site's own consent cookie: always set, always necessary.
  rows.push({
    category: "necessary",
    id: "site:consent",
    values: {
      kind: "site",
      vendor: "This website",
      purpose: "Remembers the visitor's consent choice.",
      legal_basis: defaultLegalBasis("necessary"),
      cookies: `${CONSENT_COOKIE} (1 year): stores which consent categories the visitor granted.`,
    },
  });
  for (const p of args.purposes) {
    rows.push({
      category: p.category,
      id: `plugin:${p.pluginSlug}:${p.key}`,
      values: {
        kind: "site",
        vendor: "This website",
        purpose: p.purpose,
        legal_basis: defaultLegalBasis(p.category),
        cookies: cookieSummary(p.cookies),
      },
    });
  }
  for (const t of args.tags) {
    if (!t.enabled) continue;
    const v = t.vendor_info ?? {};
    rows.push({
      category: t.category_key,
      id: `tag:${t.id}`,
      values: {
        kind: "tag",
        vendor: v.name || t.name,
        ...(v.seat ? { vendor_seat: v.seat } : {}),
        ...(v.purpose ? { purpose: v.purpose } : {}),
        legal_basis: v.legalBasis || defaultLegalBasis(t.category_key),
        ...(v.thirdCountry ? { third_country: v.thirdCountry } : {}),
        ...(v.transferBasis ? { transfer_basis: v.transferBasis } : {}),
        ...(v.privacyPolicyUrl ? { privacy_policy: { href: v.privacyPolicyUrl } } : {}),
        cookies: cookieSummary(t.cookies ?? []),
      },
    });
  }
  const position = new Map(args.categories.map((c) => [c.key, c.position]));
  const label = new Map(args.categories.map((c) => [c.key, c.display_name]));
  rows.sort((a, b) => (position.get(a.category) ?? 99) - (position.get(b.category) ?? 99));
  return rows.map((r, i) => ({
    id: r.id,
    values: {
      category: r.category,
      category_label: label.get(r.category) ?? r.category,
      category_first: i === 0 || rows[i - 1]?.category !== r.category,
      ...r.values,
      updated,
    },
  }));
}

/** The node fields of `consent_vendors`, declared once for the manifest. */
export const CONSENT_VENDOR_FIELDS: PluginListSourceSpec["node"]["fields"] = [
  { name: "category", label: "Category key", type: "text", required: true, maxLength: 64 },
  { name: "category_label", label: "Category", type: "text", required: true },
  { name: "category_first", label: "First of its category", type: "boolean" },
  { name: "kind", label: "Kind", type: "select", options: ["site", "tag"] },
  { name: "vendor", label: "Recipient", type: "text", required: true },
  { name: "vendor_seat", label: "Registered address", type: "text" },
  { name: "purpose", label: "Purpose", type: "text", maxLength: 2000 },
  { name: "legal_basis", label: "Legal basis", type: "text" },
  { name: "third_country", label: "Third country", type: "text" },
  { name: "transfer_basis", label: "Transfer basis", type: "text" },
  { name: "privacy_policy", label: "Privacy policy", type: "link" },
  { name: "cookies", label: "Cookies", type: "text", maxLength: 2000 },
  { name: "updated", label: "Last updated", type: "date" },
];
