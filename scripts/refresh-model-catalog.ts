// SPDX-License-Identifier: MPL-2.0

/**
 * Weekly model-catalog refresh (.github/workflows/model-catalog-refresh.yml).
 *
 * Lists the models each provider currently serves and moves every slot in
 * `packages/admin-core/src/ai/model-catalog.json` to the newest id matching
 * the slot's `match` regex. The workflow turns a changed catalog into a PR —
 * nothing here ships without review, because a new model can also need an
 * `ai_pricing` row and (Anthropic) a capability-predicate update. The
 * summary written with `--summary <file>` lists exactly those follow-ups.
 *
 * A provider whose key is not set is skipped and reported, never guessed.
 *
 *   bun scripts/refresh-model-catalog.ts [--summary <file>] [--dry-run]
 *
 * Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = join(import.meta.dir, "..");
const CATALOG_PATH = join(ROOT, "packages/admin-core/src/ai/model-catalog.json");
const MIGRATIONS_DIR = join(ROOT, "packages/migrations/migrations/cms_admin");

export type Provider = "anthropic" | "openai" | "google";

export interface ListedModel {
  id: string;
  label: string;
}

interface Slot {
  role: string;
  note: string;
  match: string;
  id: string;
  label: string;
}

export interface Catalog {
  $comment?: string;
  providers: Record<Provider, { slots: Slot[] }>;
}

export interface SlotChange {
  provider: Provider;
  role: string;
  from: string;
  to: string;
  label: string;
}

/** Every integer group in an id: `claude-sonnet-5-5` → [5, 5], `gpt-4.1` → [4, 1]. */
export function versionKey(id: string): number[] {
  return (id.match(/\d+/g) ?? []).map(Number);
}

/** Compares ids by version numbers; a longer key wins a tie (`5-5` > `5`). */
export function compareVersions(a: string, b: string): number {
  const ka = versionKey(a);
  const kb = versionKey(b);
  for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
    const d = (ka[i] ?? -1) - (kb[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

/** Newest listed model whose id matches the slot's regex. */
export function pickNewest(models: readonly ListedModel[], match: string): ListedModel | undefined {
  const re = new RegExp(match);
  return models.filter((m) => re.test(m.id)).sort((a, b) => compareVersions(b.id, a.id))[0];
}

/**
 * Moves each slot of every listed provider to its newest match. A slot also
 * moves when its current id is no longer served (retired), even if the
 * replacement's version isn't higher. Providers missing from `listed` stay as-is.
 */
export function refreshCatalog(
  catalog: Catalog,
  listed: Partial<Record<Provider, readonly ListedModel[]>>,
): { catalog: Catalog; changes: SlotChange[]; unmatched: string[] } {
  const next = structuredClone(catalog);
  const changes: SlotChange[] = [];
  const unmatched: string[] = [];
  for (const provider of Object.keys(next.providers) as Provider[]) {
    const models = listed[provider];
    if (!models) continue;
    for (const slot of next.providers[provider].slots) {
      const newest = pickNewest(models, slot.match);
      if (!newest) {
        unmatched.push(`${provider}/${slot.role} (${slot.match})`);
        continue;
      }
      const retired = !models.some((m) => m.id === slot.id);
      if (newest.id === slot.id || (!retired && compareVersions(newest.id, slot.id) <= 0)) continue;
      changes.push({
        provider,
        role: slot.role,
        from: slot.id,
        to: newest.id,
        label: newest.label,
      });
      slot.id = newest.id;
      slot.label = newest.label;
    }
  }
  return { catalog: next, changes, unmatched };
}

/** `gpt-4.1-mini` → `GPT-4.1 Mini` — OpenAI's list has no display names. */
export function openAiLabel(id: string): string {
  return id
    .split("-")
    .map((part, i) => (i === 0 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("-")
    .replace(/-(?=[A-Z][a-z])/g, " ");
}

/** Model ids that already have an `ai_pricing` row in some migration. */
export function pricedModels(migrationSql: readonly string[]): Set<string> {
  const priced = new Set<string>();
  for (const sql of migrationSql) {
    for (const m of sql.matchAll(/\(\s*'(?:anthropic|openai|google)'\s*,\s*'([^']+)'/g)) {
      priced.add(m[1] as string);
    }
  }
  return priced;
}

export function renderSummary(args: {
  changes: readonly SlotChange[];
  skipped: readonly string[];
  unmatched: readonly string[];
  priced: ReadonlySet<string>;
}): string {
  const lines: string[] = ["## Model catalog refresh", ""];
  if (args.changes.length === 0) {
    lines.push("No newer models found — `model-catalog.json` is up to date.");
  } else {
    lines.push("| Provider | Slot | From | To |", "|---|---|---|---|");
    for (const c of args.changes) {
      lines.push(`| ${c.provider} | ${c.role} | \`${c.from}\` | \`${c.to}\` (${c.label}) |`);
    }
    lines.push("", "### Before merging", "");
    for (const c of args.changes) {
      if (!args.priced.has(c.to)) {
        lines.push(
          `- [ ] Add an \`ai_pricing\` migration for \`${c.provider}\` / \`${c.to}\` (calls are recorded as \`unpriced\` until then)`,
        );
      }
      if (c.provider === "anthropic") {
        lines.push(
          `- [ ] Check \`isAdaptiveModel\` / \`rejectsForcedToolChoice\` in \`packages/admin-core/src/ai/providers/anthropic.ts\` cover \`${c.to}\``,
        );
      }
      lines.push(
        `- [ ] Confirm the installed \`@ai-sdk/${c.provider}\` version knows \`${c.to}\` (capabilities, max output tokens)`,
      );
    }
  }
  if (args.skipped.length > 0) {
    lines.push("", `Skipped (no API key configured): ${args.skipped.join(", ")}.`);
  }
  if (args.unmatched.length > 0) {
    lines.push("", `No listed model matched: ${args.unmatched.join(", ")} — check the slot regex.`);
  }
  return `${lines.join("\n")}\n`;
}

async function listAnthropic(): Promise<ListedModel[]> {
  const client = new Anthropic();
  const models: ListedModel[] = [];
  for await (const m of client.models.list()) models.push({ id: m.id, label: m.display_name });
  return models;
}

async function listOpenAI(apiKey: string): Promise<ListedModel[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI models list failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { id: string }[] };
  return body.data.map((m) => ({ id: m.id, label: openAiLabel(m.id) }));
}

async function listGoogle(apiKey: string): Promise<ListedModel[]> {
  const models: ListedModel[] = [];
  let pageToken = "";
  do {
    const url = new URL("https://generativelanguage.googleapis.com/v1beta/models");
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const res = await fetch(url, { headers: { "x-goog-api-key": apiKey } });
    if (!res.ok) throw new Error(`Google models list failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as {
      models?: { name: string; displayName: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    for (const m of body.models ?? []) {
      if (!m.supportedGenerationMethods?.includes("generateContent")) continue;
      models.push({ id: m.name.replace(/^models\//, ""), label: m.displayName });
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return models;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const summaryIdx = argv.indexOf("--summary");
  const summaryPath = summaryIdx >= 0 ? argv[summaryIdx + 1] : undefined;
  const dryRun = argv.includes("--dry-run");

  const listed: Partial<Record<Provider, ListedModel[]>> = {};
  const skipped: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) listed.anthropic = await listAnthropic();
  else skipped.push("anthropic");
  if (process.env.OPENAI_API_KEY) listed.openai = await listOpenAI(process.env.OPENAI_API_KEY);
  else skipped.push("openai");
  if (process.env.GOOGLE_API_KEY) listed.google = await listGoogle(process.env.GOOGLE_API_KEY);
  else skipped.push("google");

  const current = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Catalog;
  const { catalog, changes, unmatched } = refreshCatalog(current, listed);
  const priced = pricedModels(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")),
  );
  const summary = renderSummary({ changes, skipped, unmatched, priced });

  if (changes.length > 0 && !dryRun) {
    writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  if (summaryPath) writeFileSync(summaryPath, summary);
  console.log(summary);
}

if (import.meta.main) {
  await main();
}
