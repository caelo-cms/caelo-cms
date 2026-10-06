// SPDX-License-Identifier: MPL-2.0

/**
 * Weekly model check (.github/workflows/model-catalog-refresh.yml).
 *
 * Lists the models each provider currently serves and works out which slots
 * in `packages/admin-core/src/ai/model-catalog.json` should move to a newer id
 * (newest id matching the slot's `match` regex, or off a retired id). The
 * workflow turns the result into an issue assigned to the Copilot coding
 * agent, which implements the whole update — catalog, `ai_pricing`
 * migration, Anthropic capability predicates, SDK bump — as one PR. The
 * agent has no provider keys, so this script (which does) supplies the facts.
 *
 * A provider whose key is not set is skipped and reported, never guessed.
 *
 *   bun scripts/refresh-model-catalog.ts [--issue-body <file>] [--write]
 *
 * `--write` also rewrites the catalog locally (handy for manual runs).
 * Sets `changed=true|false` in $GITHUB_OUTPUT when running in Actions.
 * Keys: ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY.
 */

import { appendFileSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
const DATED_SNAPSHOT = /-\d{8}$/;

/**
 * Adds the alias of every dated snapshot the provider lists without its alias
 * (Anthropic lists `claude-haiku-4-5-20251001` but not `claude-haiku-4-5`).
 * Slots track aliases, so without this a dated-only family never matches its
 * regex and the catalog's alias looks retired.
 */
export function withAliases(models: readonly ListedModel[]): ListedModel[] {
  const ids = new Set(models.map((m) => m.id));
  const out = [...models];
  for (const m of models) {
    const alias = m.id.replace(DATED_SNAPSHOT, "");
    if (alias !== m.id && !ids.has(alias)) {
      ids.add(alias);
      out.push({ id: alias, label: m.label });
    }
  }
  return out;
}

export function refreshCatalog(
  catalog: Catalog,
  listed: Partial<Record<Provider, readonly ListedModel[]>>,
): { catalog: Catalog; changes: SlotChange[]; unmatched: string[] } {
  const next = structuredClone(catalog);
  const changes: SlotChange[] = [];
  const unmatched: string[] = [];
  for (const provider of Object.keys(next.providers) as Provider[]) {
    const listedModels = listed[provider];
    if (!listedModels) continue;
    // Slots track aliases; a dated id would otherwise slip through regexes like
    // `^claude-haiku-\d+(-\d+)?$` (the date reads as a minor version).
    const models = withAliases(listedModels).filter((m) => !DATED_SNAPSHOT.test(m.id));
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

const DOCS: Record<Provider, { pricing: string; models: string }> = {
  anthropic: {
    pricing: "https://platform.claude.com/docs/en/about-claude/pricing.md",
    models: "https://platform.claude.com/docs/en/about-claude/models/migration-guide.md",
  },
  openai: {
    pricing: "https://openai.com/api/pricing/",
    models: "https://platform.openai.com/docs/models",
  },
  google: {
    pricing: "https://ai.google.dev/gemini-api/docs/pricing",
    models: "https://ai.google.dev/gemini-api/docs/models",
  },
};

/**
 * Issue body for the coding agent (the workflow assigns it to Copilot). It
 * carries the exact slot changes — the agent has no provider keys — plus the
 * complete definition of done, so the resulting PR only needs review.
 */
export function renderIssueBody(args: {
  changes: readonly SlotChange[];
  skipped: readonly string[];
  unmatched: readonly string[];
  priced: ReadonlySet<string>;
  /** Newest existing pricing migration, shown as the pattern to follow. */
  pricingExample: string;
}): string {
  const lines: string[] = [];
  if (args.changes.length === 0) {
    lines.push("No newer models found — `model-catalog.json` is up to date.");
  } else {
    lines.push(
      "The weekly model check found newer models. Update Caelo to them in ONE pull request.",
      "",
      "## Catalog changes (from the providers' live model lists)",
      "",
      "| Provider | Slot | From | To | Label |",
      "|---|---|---|---|---|",
    );
    for (const c of args.changes) {
      lines.push(`| ${c.provider} | ${c.role} | \`${c.from}\` | \`${c.to}\` | ${c.label} |`);
    }
    const tasks: string[][] = [
      [
        "In `packages/admin-core/src/ai/model-catalog.json`, set each slot above to the new `id` and `label` (keep `role`, `note`, `match`).",
      ],
    ];
    const unpriced = args.changes.filter((c) => !args.priced.has(c.to));
    if (unpriced.length > 0) {
      tasks.push([
        `Add ONE new migration \`packages/migrations/migrations/cms_admin/<next number>_p_pricing_<models>.sql\` with \`ai_pricing\` rows, following \`${args.pricingExample}\` (microcents per 1K tokens; cache write = 1.25x input for Anthropic, = input for providers that don't bill cache writes separately) for:`,
        ...unpriced.map(
          (c) => `   - \`${c.provider}\` / \`${c.to}\` — prices from ${DOCS[c.provider].pricing}`,
        ),
        "   Take every number from the official pricing page and cite it in the migration header. If a page is unreachable or does not list a model, do NOT guess: leave that row out — and if no row is left, add no migration file at all — and name the missing price in the PR description.",
      ]);
    } else {
      tasks.push(["Pricing: every new id already has an `ai_pricing` row — no migration needed."]);
    }
    if (args.changes.some((c) => c.provider === "anthropic")) {
      tasks.push([
        `Anthropic: read ${DOCS.anthropic.models} for each new Claude id and update the capability predicates in \`packages/admin-core/src/ai/providers/anthropic.ts\` — \`isAdaptiveModel\` (rejects \`temperature\` / \`budget_tokens\`) and \`rejectsForcedToolChoice\` (rejects \`tool_choice\` any/tool). Extend \`packages/admin-core/src/ai/__tests__/thinking-option.test.ts\` for the new ids.`,
      ]);
    }
    tasks.push(
      [
        "Check that the installed `@ai-sdk/<provider>` package (`packages/admin-core/package.json`) recognises each new id (search its `dist/index.js` for the model name). If it does not, bump that package and `ai` to the newest compatible versions.",
      ],
      [
        "Run `bun test ./scripts ./packages/admin-core/src/ai`, `bunx biome check .` and `bunx tsc -b packages/admin-core`; all must pass. Do not add tests that pin the catalog's exact ids — the weekly update would break them.",
      ],
    );
    lines.push("", "## Tasks", "");
    tasks.forEach(([first, ...rest], i) => {
      lines.push(`${i + 1}. ${first}`, ...rest);
    });
    lines.push(
      "",
      "Follow `CLAUDE.md` and `CONTRIBUTING.md` (conventional commit `chore(ai): …`, PR description from `.github/PULL_REQUEST_TEMPLATE.md`). Existing installs keep their stored model — do not write a data migration for `ai_providers.config`.",
    );
  }
  if (args.skipped.length > 0) {
    lines.push("", `_Not checked (no API key configured): ${args.skipped.join(", ")}._`);
  }
  if (args.unmatched.length > 0) {
    lines.push(
      "",
      `_No listed model matched: ${args.unmatched.join(", ")} — the slot regex may need an update._`,
    );
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
  const issueIdx = argv.indexOf("--issue-body");
  const issuePath = issueIdx >= 0 ? argv[issueIdx + 1] : undefined;
  const writeCatalog = argv.includes("--write");

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
  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const priced = pricedModels(migrations.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")));
  const pricingExample = migrations.filter((f) => f.includes("_p_pricing_")).at(-1);
  if (!pricingExample) throw new Error(`no *_p_pricing_*.sql migration found in ${MIGRATIONS_DIR}`);
  const body = renderIssueBody({ changes, skipped, unmatched, priced, pricingExample });

  if (writeCatalog && changes.length > 0) {
    writeFileSync(CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`);
  }
  if (issuePath) writeFileSync(issuePath, body);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changes.length > 0}\n`);
  }
  console.log(body);
}

if (import.meta.main) {
  await main();
}
