// SPDX-License-Identifier: MPL-2.0

/**
 * What a plugin release declares differently from the approved one, in the
 * Owner's words (#1420, CMS_REQUIREMENTS §14.5).
 */

import type { PluginManifest } from "@caelo-cms/plugin-sdk";
import { BATCH_SIZES } from "@caelo-cms/plugin-sdk";

/** One area of the manifest that changed; the entries are their manifest names. */
export interface ManifestChange {
  readonly area: string;
  readonly added: string[];
  readonly removed: string[];
  readonly changed: string[];
}

/** Identity: shown by the approval itself, not as a change. */
type NotCompared = "slug" | "version" | "tier";

/**
 * Every other manifest field. A `Record` over the manifest's keys, so a new
 * field does not compile until the Owner can read it here: a change the
 * digest counts must never be missing from the dialog.
 */
const AREAS: Readonly<Record<Exclude<keyof PluginManifest, NotCompared>, string>> = {
  schema: "Public data tables",
  adminSchema: "Private data tables",
  aiReadableTables: "Private data the AI may read",
  indexes: "Database indexes",
  operations: "Internal operations",
  component: "Web component",
  hasStaticRender: "Static rendering",
  hasOnActivate: "Setup it runs when it starts",
  publicOperations: "What visitors can send",
  tableKinds: "Who can reach its tables",
  requires: "Required site setup",
  mailTemplates: "Mails it sends to visitors",
  mailUnsubscribe: "Unsubscribe link in its mails",
  visitorProjection: "Private data shown to visitors",
  clientFiles: "Files added to every page",
  hasBuildData: "Data added to every page",
  hasDeferrals: "Withheld page modules",
  deferralPlaceholders: "What stands in for a withheld module",
  hasContentVariants: "Content variants",
  hasLinkResolve: "Internal link handling",
  linkResolveReads: "What its internal link handling reads",
  hasShareImages: "Default social-share images",
  hasStructuredData: "Structured data of your pages",
  hasSitemapEntries: "Entries of the news and video sitemaps",
  auditFindingsOperation: "Stage audit findings",
  writeHintsOperation: "Hints to the AI",
  changeConsumer: "Followed site changes",
  requestedCapabilities: "Permissions it asks for",
  capabilityReasons: "Its reasons for its permissions",
  capabilityConstraints: "Limits on its permissions",
  workers: "Background jobs",
  tools: "AI tools",
  urlContributions: "Page addresses",
  urlTables: "Which of its tables shape page addresses",
  contributes: "Page head and sitemap",
  skills: "AI instructions",
  listSources: "List data",
  listTypes: "List types",
  listExt: "List extensions",
  hasListResolve: "List rendering",
  adminPanels: "Admin pages",
  editorToolbar: "Editor toolbar",
  requiresPlugins: "Required plugins",
  consentPurposes: "Visitor consent purposes",
  consentProvider: "How it decides which consent covers what",
  bakedData: "Data baked into pages",
  config: "Its settings",
  entityConfig: "Its settings per page, module or page type",
  configPreviewOperation: "Preview of setting changes",
  collections: "Search indexes it keeps",
  collectionOperations: "What visitors can search and read",
  aiChatOperations: "What visitors can ask its AI, and which searches it may use to answer",
  pageOutputObserver: "What it reads from your pages at each Stage",
  batchOperations: "Long-running tasks it runs",
};

/** Stable JSON: two values compare equal whatever their key order in jsonb. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
}

/**
 * #1776 — a batch operation by its name and the machine it asks for, so
 * the Owner sees at approval what a task of it costs, and a new size or
 * width reads as the batch it is (`learn (machine M: 2 vCPU, 4 GiB, in
 * pieces on up to 8 tasks)`).
 */
function batchName(record: Record<string, unknown>): string | null {
  if (typeof record.operation !== "string" || !Array.isArray(record.triggers)) return null;
  const size = record.size === "M" || record.size === "L" ? record.size : "S";
  const machine = BATCH_SIZES[size];
  const pieces = record.pieces as { maxTasks?: unknown } | undefined;
  const width =
    pieces && typeof pieces.maxTasks === "number"
      ? `, in pieces on up to ${pieces.maxTasks} tasks`
      : "";
  return `${record.operation} (machine ${size}: ${machine.vcpu} vCPU, ${machine.memoryGiB} GiB${width})`;
}

/** The name an array entry goes by, or its JSON when it declares none. */
function entryName(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object") {
    const record = entry as Record<string, unknown>;
    const batch = batchName(record);
    if (batch) return batch;
    for (const key of ["name", "slug", "id", "key", "tag", "tagName"]) {
      const value = record[key];
      if (typeof value === "string") return value;
    }
  }
  return canonical(entry);
}

/** A field as name → value, so lists and maps compare alike; null for a scalar. */
function entries(value: unknown): Map<string, string> | null {
  if (Array.isArray(value)) return new Map(value.map((e) => [entryName(e), canonical(e)]));
  if (value !== null && typeof value === "object") {
    return new Map(Object.entries(value).map(([k, v]) => [k, canonical(v)]));
  }
  return null;
}

function compare(area: string, before: unknown, after: unknown): ManifestChange | null {
  const oldEntries = entries(before ?? (Array.isArray(after) ? [] : {}));
  const newEntries = entries(after ?? (Array.isArray(before) ? [] : {}));
  if (oldEntries === null || newEntries === null) {
    // A flag or a single name: there is nothing to list inside it.
    return canonical(before ?? false) === canonical(after ?? false)
      ? null
      : { area, added: [], removed: [], changed: [area] };
  }
  const added = [...newEntries.keys()].filter((k) => !oldEntries.has(k));
  const removed = [...oldEntries.keys()].filter((k) => !newEntries.has(k));
  const changed = [...newEntries.keys()].filter(
    (k) => oldEntries.has(k) && oldEntries.get(k) !== newEntries.get(k),
  );
  if (added.length + removed.length + changed.length === 0) return null;
  return { area, added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * The areas in which `next` differs from `previous`, in a stable order.
 *
 * @param previous the approved manifest, as stored.
 * @param next the manifest of the release waiting for approval.
 */
export function describeManifestChanges(previous: unknown, next: unknown): ManifestChange[] {
  const before = (previous ?? {}) as Record<string, unknown>;
  const after = (next ?? {}) as Record<string, unknown>;
  return Object.entries(AREAS).flatMap(([field, area]) => {
    const change = compare(area, before[field], after[field]);
    return change ? [change] : [];
  });
}
