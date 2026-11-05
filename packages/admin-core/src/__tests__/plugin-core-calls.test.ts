// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1390 — a shipped plugin's background work costs what changed, not
 * the site.
 *
 * A plugin's change consumer runs after every write of every chat, its
 * crons on a timer, its render hooks on every preview. A core op such a
 * path calls is therefore paid many times per agent turn. On searchVIU
 * production (2026-11-03) the consent-manager's consumer called
 * `content_instances.list` after every agent write; its reach read every
 * module, list and pending state of the draft and starved the
 * db-f1-micro's CPU. The rows-read gate did not object: the op was on its
 * allowlist as a whole, and the narrow shape the plugin calls was never
 * measured.
 *
 * This guard scans every shipped plugin's source for the registered core
 * ops it names and requires each (plugin, op) pair to be classified in
 * {@link PLUGIN_CORE_CALLS}:
 * - `measured`: the rows-read labels of the shapes the plugin calls in the
 *   background; each must exist, name the plugin in its `plugins`, and —
 *   unless the pair is also `pending` — meet the bar (not be allowlisted);
 * - `pending`: a `FIXME(#n)` naming the issue that makes it request-sized;
 * - `notBackground`: why no change consumer, cron or render hook reaches it
 *   (an AI/Owner tool, the Stage build — `readScope: "site"` by design).
 * A new call fails until it is classified; `pending` only shrinks.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { OperationRegistry } from "@caelo-cms/query-api";
import { registerAdminOps } from "../register.js";
import { ALLOWLIST } from "./rows-read/allowlist.js";
import { inputKey, ROWS_READ_INPUTS } from "./rows-read/inputs.js";

const PLUGINS_DIR = resolve(import.meta.dir, "../../../plugins");

interface Classification {
  readonly measured?: readonly string[];
  readonly pending?: string;
  readonly notBackground?: string;
}

const LIST_RESOLVE_1270 =
  "FIXME(#1270) the list_resolve/link_resolve render hooks read whole lists, modules and pages per preview";
const INTL_1255 =
  "FIXME(#1255) international-site's translation consumer and crons read site-sized lists";

/** Every (plugin, core op) pair a shipped plugin names, classified. */
const PLUGIN_CORE_CALLS: Readonly<Record<string, Readonly<Record<string, Classification>>>> = {
  "consent-manager": {
    "content_instances.list": {
      measured: ["content_instances.list {ids}", "content_instances.list {moduleIds}"],
      pending:
        "FIXME(#1391) the module_changes consumer re-reads the instances of each change through the whole-site reach; the 5-minute scan reads every instance",
    },
    "modules.list": {
      measured: ["modules.list {moduleIds}"],
      pending: "FIXME(#1391) the 5-minute scan reads every module",
    },
    "pages.list": {
      notBackground:
        "tag-ops: the add/list/remove tag tools and buildAssets (the Stage build, readScope site by design)",
    },
    "templates.list": {
      notBackground:
        "tag-ops: the add/list/remove tag tools and buildAssets (the Stage build, readScope site by design)",
    },
  },
  comments: {
    "comment_archive.list_for_page": {
      pending:
        "FIXME(#1269) bakedData reads one page's archive per plugin-data build; not yet measured",
    },
    "comment_archive.insert": {
      notBackground: "the moderate / ai_moderate tools write one archived comment each",
    },
  },
  "international-site": {
    "content_instances.get": { measured: ["content_instances.get"] },
    "content_instances.list": { pending: LIST_RESOLVE_1270 },
    "content_instances.rendered_on_many": {
      measured: ["content_instances.rendered_on_many"],
    },
    "deploy.list_runs": { notBackground: "list translation tools report the last Stage" },
    "links.canonicalise_values": { pending: INTL_1255 },
    "list_types.list": { measured: ["list_types.list"] },
    "lists.list": { pending: LIST_RESOLVE_1270 },
    "modules.list": { pending: LIST_RESOLVE_1270 },
    "page_module_content.list_for_page": { measured: ["page_module_content.list_for_page"] },
    "page_module_content.set": { notBackground: "translate tools write one page's content" },
    "page_types.list": { measured: ["page_types.list"] },
    "pages.duplicate": { notBackground: "the create_variant tool duplicates one page" },
    "pages.list": { measured: ["pages.list {pageIds}"], pending: INTL_1255 },
    "pages.list_shared_content": { pending: LIST_RESOLVE_1270 },
    "pages.list_statuses": { pending: INTL_1255 },
    "pages.refresh_current_path": { measured: ["pages.refresh_current_path"] },
    "pages.resolve_public_urls": { pending: LIST_RESOLVE_1270 },
    "pages.update": { notBackground: "variant tools update the pages they name" },
    "pages_seo.apply_translation": { notBackground: "translate tools write one page's SEO" },
    // The staleness consumer reads each changed source's meta description.
    "pages_seo.get": { measured: ["pages_seo.get"] },
    "media.get": { notBackground: "set_locale_share_image checks the image it is given" },
    "placement.fork_paths": { notBackground: "translate tools copy content of one placement" },
    "redirects.create": { notBackground: "variant tools create the redirect of a moved page" },
    "redirects.page_conflicts": {
      notBackground: "create_variant, an AI tool, names a rule on the new page's URL",
    },
    "site_defaults.get": { measured: ["site_defaults.get"] },
  },
};

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== "__tests__") sources(path, out);
    } else if (path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** The registered core ops each shipped plugin names in its source. */
function pluginCoreCalls(): Map<string, Set<string>> {
  const registry = new OperationRegistry();
  registerAdminOps(registry);
  const ops = new Set(registry.names());
  const out = new Map<string, Set<string>>();
  for (const slug of readdirSync(PLUGINS_DIR)) {
    const src = join(PLUGINS_DIR, slug, "src");
    try {
      if (!statSync(src).isDirectory()) continue;
    } catch {
      continue;
    }
    const called = new Set<string>();
    for (const file of sources(src)) {
      // Every string-literal form: "op", 'op' and `op`.
      for (const m of readFileSync(file, "utf8").matchAll(/["'`]([a-z_]+\.[a-z_]+)["'`]/g)) {
        const name = m[1] ?? "";
        if (ops.has(name)) called.add(name);
      }
    }
    if (called.size > 0) out.set(slug, called);
  }
  return out;
}

describe("#1390 — plugin background paths call request-sized core ops", () => {
  const calls = pluginCoreCalls();
  const inputs = new Map(ROWS_READ_INPUTS.map((e) => [inputKey(e), e]));

  it("classifies every core op a shipped plugin calls", () => {
    const unclassified: string[] = [];
    for (const [slug, ops] of calls) {
      for (const op of ops) if (!PLUGIN_CORE_CALLS[slug]?.[op]) unclassified.push(`${slug}: ${op}`);
    }
    // Classify each in PLUGIN_CORE_CALLS: measured (rows-read label),
    // pending (FIXME with the issue), or notBackground (why).
    expect(unclassified).toEqual([]);
  });

  it("keeps the classification current", () => {
    const stale: string[] = [];
    for (const [slug, ops] of Object.entries(PLUGIN_CORE_CALLS)) {
      for (const op of Object.keys(ops))
        if (!calls.get(slug)?.has(op)) stale.push(`${slug}: ${op}`);
    }
    expect(stale).toEqual([]);
  });

  it("holds measured background shapes to the rows-read bar", () => {
    const problems: string[] = [];
    for (const [slug, ops] of Object.entries(PLUGIN_CORE_CALLS)) {
      for (const [op, c] of Object.entries(ops)) {
        const kinds = [c.measured, c.pending, c.notBackground].filter((x) => x !== undefined);
        if (c.notBackground !== undefined && kinds.length > 1) {
          problems.push(`${slug}: ${op} is notBackground and something else`);
        }
        if (kinds.length === 0) problems.push(`${slug}: ${op} has no classification`);
        if (c.pending !== undefined && !/^FIXME\(#\d+\) /.test(c.pending)) {
          problems.push(`${slug}: ${op} pending without FIXME(#n)`);
        }
        for (const label of c.measured ?? []) {
          const entry = inputs.get(label);
          if (!entry) problems.push(`${slug}: ${op} names unmeasured shape "${label}"`);
          else if (entry.op !== op) problems.push(`${slug}: "${label}" measures ${entry.op}`);
          else if (!entry.plugins?.includes(slug)) {
            problems.push(`${slug}: "${label}" does not list the plugin in its plugins`);
          } else if (label in ALLOWLIST && c.pending === undefined) {
            problems.push(
              `${slug}: "${label}" is allowlisted (${ALLOWLIST[label]}) — not request-sized`,
            );
          }
        }
      }
    }
    // Every rows-read shape that names a plugin is claimed by it.
    for (const entry of ROWS_READ_INPUTS) {
      for (const slug of entry.plugins ?? []) {
        if (!PLUGIN_CORE_CALLS[slug]?.[entry.op]?.measured?.includes(inputKey(entry))) {
          problems.push(`rows-read "${inputKey(entry)}" names ${slug}, which does not claim it`);
        }
      }
    }
    expect(problems).toEqual([]);
  });
});
