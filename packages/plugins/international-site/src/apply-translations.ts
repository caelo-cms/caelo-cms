// SPDX-License-Identifier: MPL-2.0

/**
 * #741 — translation work items and the tool that takes their answers.
 *
 * On the Power-MCP the calling agent does the AI work on its own
 * subscription: translate_variant / translate_all_stale / translate_chrome
 * hand out {@link AiWorkItem}s carrying the exact prompt the install's
 * model would have received, and `apply_translations` writes the agent's
 * answers through the same validation and write path the install side
 * uses (./page-translation.ts, ./chrome-ops.ts).
 *
 * Drift: every item carries a `basis` — a digest of the content its
 * prompt was built from. Applying re-prepares the translation and refuses
 * when the basis moved, because an answer for an older source would
 * silently overwrite newer content.
 *
 * All-or-nothing validation: every item is parsed, drift-checked and held
 * to its contract BEFORE anything is written, and one bad item refuses the
 * whole call. A half-applied batch would leave the agent guessing which
 * answers landed; a refusal that lists every problem lets it fix them and
 * resend once. Writes then run per item — a write failure (core refusing)
 * is reported on that item and the others still land, since translations
 * of different pages/locales do not depend on each other.
 */

import type { AiWorkItem } from "@caelo-cms/plugin-sdk";
import { z } from "@caelo-cms/plugin-sdk";
import type { ChromeTranslationPayload } from "./chrome.js";
import {
  type ChromeDeps,
  chromeTranslationBasis,
  type PreparedChromeTranslation,
  parseChromeTranslationAnswer,
  prepareChromeTranslation,
  writeChromeTranslation,
} from "./chrome-ops.js";
import {
  checkListTranslations,
  type ListTranslationState,
  loadListTranslationState,
  writeListTranslations,
} from "./list-translation-ops.js";
import {
  outcomeNextStep,
  type PageTranslationOutcome,
  type PreparedPageTranslation,
  pageTranslationBasis,
  parsePageTranslationAnswer,
  preparePageTranslation,
  writePageTranslation,
} from "./page-translation.js";
import type { TranslationResultPayload } from "./translation.js";

/** The tool every translation work item names. */
export const APPLY_TRANSLATIONS_TOOL = "apply_translations";

/** Where a work item's answer goes inside `apply.args` (a one-item batch). */
const RESULT_ARG = "items[0].result";

/** Told with every work item handed out. */
export const WORK_ITEM_NEXT_STEP =
  "Translate it yourself: answer workItem.instructions (system + user) with your own model, exactly as asked — bare JSON. Then call apply_translations with workItem.apply.args and your answer as items[0].result. Several work items go in ONE apply_translations call: put each item's apply.args.items[0] (with its result) into one items array.";

const basis = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "basis must be the sha256:<hex> value from the work item");
/** The agent's answer: the JSON text the instructions asked for, or that JSON already parsed. */
const answer = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

const pageItem = z
  .object({
    kind: z.literal("page"),
    variantPageId: z.string().uuid(),
    mode: z.enum(["full", "update"]),
    basis,
    result: answer,
  })
  .strict();
const chromeItem = z
  .object({
    kind: z.literal("chrome"),
    localeCode: z.string().min(2).max(35),
    basis,
    result: answer,
  })
  .strict();

/**
 * Epic #1107 — translations of list texts given directly by value
 * address (`list/<listId>/item/<itemId>/<field>`, `instance/…`,
 * `page/<pageId>/props/<field>`): the operator dictates a wording
 * ("the German menu says 'Preise'"), or an agent answers by address
 * without a work item. Each address must be a current list text of that
 * language (intl_status.lists / translate_chrome name them).
 */
const addressesItem = z
  .object({
    kind: z.literal("addresses"),
    localeCode: z.string().min(2).max(35),
    translations: z
      .array(
        z.object({ address: z.string().min(1).max(400), value: z.string().max(20_000) }).strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

/** `apply_translations` input. */
export const applyTranslationsArgs = z
  .object({
    items: z
      .array(z.discriminatedUnion("kind", [pageItem, chromeItem, addressesItem]))
      .min(1)
      .max(100),
  })
  .strict();

type ApplyItem = z.infer<typeof applyTranslationsArgs>["items"][number];

/** The `apply_translations` tool's input schema, kept next to the Zod schema it mirrors. */
export const applyTranslationsInputJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      description:
        "One entry per work item: the work item's apply.args.items[0] plus your answer as `result`.",
      items: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "variantPageId", "mode", "basis", "result"],
            properties: {
              kind: { type: "string", const: "page" },
              variantPageId: { type: "string", format: "uuid" },
              mode: { type: "string", enum: ["full", "update"] },
              basis: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
              result: {
                anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
                description:
                  "Your answer to the work item's instructions: the JSON object (or its text).",
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "localeCode", "translations"],
            description:
              "List texts by address, without a work item: the wording the operator gave, or your translation of texts intl_status.lists / translate_chrome named.",
            properties: {
              kind: { type: "string", const: "addresses" },
              localeCode: { type: "string", minLength: 2, maxLength: 35 },
              translations: {
                type: "array",
                minItems: 1,
                maxItems: 500,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["address", "value"],
                  properties: {
                    address: {
                      type: "string",
                      description:
                        "Value address, e.g. list/<listId>/item/<itemId>/label or page/<pageId>/props/<field>.",
                    },
                    value: { type: "string", maxLength: 20000 },
                  },
                },
              },
            },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "localeCode", "basis", "result"],
            properties: {
              kind: { type: "string", const: "chrome" },
              localeCode: { type: "string", minLength: 2, maxLength: 35 },
              basis: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
              result: {
                anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
                description:
                  "Your answer to the work item's instructions: the JSON object (or its text).",
              },
            },
          },
        ],
      },
    },
  },
} as const;

/** The work item for one prepared page translation. */
export function pageWorkItem(p: PreparedPageTranslation, itemBasis: string): AiWorkItem {
  const title = p.sourceTitle.length > 0 ? `"${p.sourceTitle}"` : `page ${p.variantPageId}`;
  return {
    kind: "ai_work_item",
    task: `Translate ${title} into ${p.targetLocale.display_name} (${p.sourceLocale.code} → ${p.targetLocale.code}, ${p.mode} pass)`,
    instructions: p.prompt,
    responseFormat: "json",
    apply: {
      tool: APPLY_TRANSLATIONS_TOOL,
      args: {
        items: [{ kind: "page", variantPageId: p.variantPageId, mode: p.mode, basis: itemBasis }],
      },
      resultArg: RESULT_ARG,
    },
  };
}

/**
 * The work item for one locale's prepared chrome translation.
 *
 * @throws when nothing is offered — the caller reports "nothing to do"
 *   instead of handing out an empty task.
 */
export function chromeWorkItem(p: PreparedChromeTranslation, itemBasis: string): AiWorkItem {
  if (p.prompt === null) {
    throw new Error(
      `international-site: no chrome work for ${p.locale.code} — check offered.length first`,
    );
  }
  return {
    kind: "ai_work_item",
    task: `Translate the site chrome (${p.offered.length} shared menu/header/footer entr${p.offered.length === 1 ? "y" : "ies"}, ${p.offeredLists.length} list${p.offeredLists.length === 1 ? "" : "s"}) into ${p.locale.display_name} (${p.sourceLocale.code} → ${p.locale.code})`,
    instructions: p.prompt,
    responseFormat: "json",
    apply: {
      tool: APPLY_TRANSLATIONS_TOOL,
      args: { items: [{ kind: "chrome", localeCode: p.locale.code, basis: itemBasis }] },
      resultArg: RESULT_ARG,
    },
  };
}

/** One validated item, ready to write. */
type ReadyItem =
  | { kind: "page"; prepared: PreparedPageTranslation; payload: TranslationResultPayload }
  | { kind: "chrome"; prepared: PreparedChromeTranslation; payload: ChromeTranslationPayload }
  | {
      kind: "addresses";
      localeCode: string;
      state: ListTranslationState;
      answers: Map<string, string>;
    };

/** Per-item result of `apply_translations`. */
export type ApplyItemOutcome =
  | ({ kind: "page"; variantPageId: string; status: "applied" } & PageTranslationOutcome)
  | { kind: "chrome"; localeCode: string; status: "applied"; translated: number }
  | { kind: "addresses"; localeCode: string; status: "applied"; translated: number }
  | {
      kind: "page" | "chrome" | "addresses";
      variantPageId?: string;
      localeCode?: string;
      status: "failed";
      error: string;
      nextStep: string;
    };

function itemLabel(item: ApplyItem, index: number): string {
  return item.kind === "page"
    ? `items[${index}] (page ${item.variantPageId})`
    : `items[${index}] (${item.kind} ${item.localeCode})`;
}

function freshItemStep(item: ApplyItem): string {
  return item.kind === "page"
    ? `call translate_variant({ variantPageId: "${item.variantPageId}" }) again for a fresh work item`
    : `call translate_chrome({ localeCode: "${item.localeCode}" }) again for a fresh work item`;
}

/** Re-prepare, drift-check and validate one item; throws an AI-actionable error. */
async function readyItem(deps: ChromeDeps, item: ApplyItem): Promise<ReadyItem> {
  const retryHint =
    "Fix your answer to match the JSON the work item's instructions describe and send it again.";
  if (item.kind === "addresses") {
    const locale = deps.locales.get(item.localeCode);
    if (!locale || locale.is_default) {
      throw new Error(
        `"${item.localeCode}" is not a translated language (intl_status lists the locales; the default language's texts are the lists themselves)`,
      );
    }
    const answers = new Map<string, string>();
    for (const t of item.translations) {
      if (answers.has(t.address)) throw new Error(`address ${t.address} appears twice`);
      answers.set(t.address, t.value);
    }
    const state = await loadListTranslationState(deps);
    checkListTranslations(state, locale, answers);
    return { kind: "addresses", localeCode: item.localeCode, state, answers };
  }
  if (item.kind === "page") {
    const prepared = await preparePageTranslation(deps, {
      variantPageId: item.variantPageId,
      mode: item.mode,
    });
    if ((await pageTranslationBasis(prepared)) !== item.basis) {
      throw new Error(`the page changed since the work item was issued — ${freshItemStep(item)}`);
    }
    return {
      kind: "page",
      prepared,
      payload: parsePageTranslationAnswer(item.result, prepared, retryHint),
    };
  }
  const prepared = await prepareChromeTranslation(deps, { localeCode: item.localeCode });
  if ((await chromeTranslationBasis(prepared)) !== item.basis) {
    throw new Error(
      `the site chrome or its translation state changed since the work item was issued — ${freshItemStep(item)}`,
    );
  }
  return {
    kind: "chrome",
    prepared,
    payload: parseChromeTranslationAnswer(item.result, prepared, retryHint),
  };
}

/**
 * Apply agent answers to translation work items. Validates every item
 * first and refuses the whole call when any is invalid or stale (nothing
 * written); then writes each.
 */
export async function applyTranslations(
  deps: ChromeDeps,
  rawArgs: unknown,
): Promise<{
  applied: number;
  failed: number;
  results: ApplyItemOutcome[];
  nextStep?: string;
}> {
  const parsed = applyTranslationsArgs.safeParse(rawArgs);
  if (!parsed.success) {
    throw new Error(
      `apply_translations input is invalid: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ")}. Each item is a work item's apply.args.items[0] plus your answer as "result".`,
    );
  }
  const items = parsed.data.items;

  const problems: string[] = [];
  const seen = new Map<string, number>();
  items.forEach((item, i) => {
    const key =
      item.kind === "page" ? `page:${item.variantPageId}` : `${item.kind}:${item.localeCode}`;
    const first = seen.get(key);
    if (first !== undefined) {
      problems.push(
        `${itemLabel(item, i)}: duplicates items[${first}] — send one answer per work item`,
      );
    } else {
      seen.set(key, i);
    }
  });

  const ready: ReadyItem[] = [];
  if (problems.length === 0) {
    for (const [i, item] of items.entries()) {
      try {
        ready.push(await readyItem(deps, item));
      } catch (e) {
        problems.push(`${itemLabel(item, i)}: ${(e as Error).message}`);
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(
      `apply_translations refused — nothing was written. ${problems.join(" | ")}. Fix or drop the listed items and send the call again.`,
    );
  }

  const results: ApplyItemOutcome[] = [];
  for (const r of ready) {
    try {
      if (r.kind === "addresses") {
        const locale = deps.locales.get(r.localeCode) as NonNullable<
          ReturnType<typeof deps.locales.get>
        >;
        const translated = await writeListTranslations(deps, r.state, locale, r.answers);
        results.push({
          kind: "addresses",
          localeCode: r.localeCode,
          status: "applied",
          translated,
        });
      } else if (r.kind === "page") {
        const outcome = await writePageTranslation(deps, r.prepared, r.payload);
        results.push({
          kind: "page",
          variantPageId: r.prepared.variantPageId,
          status: "applied",
          ...outcome,
        });
      } else {
        const translated = await writeChromeTranslation(deps, r.prepared, r.payload);
        results.push({
          kind: "chrome",
          localeCode: r.prepared.locale.code,
          status: "applied",
          translated,
        });
      }
    } catch (e) {
      results.push(
        r.kind === "addresses"
          ? {
              kind: "addresses",
              localeCode: r.localeCode,
              status: "failed",
              error: (e as Error).message,
              nextStep:
                "Fix the listed addresses or values (intl_status.lists names the current ones) and send them again.",
            }
          : r.kind === "page"
            ? {
                kind: "page",
                variantPageId: r.prepared.variantPageId,
                status: "failed",
                error: (e as Error).message,
                nextStep: `Writing this page failed part-way; call translate_variant({ variantPageId: "${r.prepared.variantPageId}" }) for a fresh work item and apply it again.`,
              }
            : {
                kind: "chrome",
                localeCode: r.prepared.locale.code,
                status: "failed",
                error: (e as Error).message,
                nextStep: `Writing this locale's chrome failed part-way; call translate_chrome({ localeCode: "${r.prepared.locale.code}" }) for a fresh work item and apply it again.`,
              },
      );
    }
  }
  const applied = results.filter((r) => r.status === "applied").length;
  const steps = new Set(
    results.flatMap((r) => {
      if (r.kind !== "page" || r.status !== "applied") return [];
      const step = outcomeNextStep(r);
      return step ? [step] : [];
    }),
  );
  return {
    applied,
    failed: results.length - applied,
    results,
    ...(steps.size > 0 ? { nextStep: [...steps].join(" ") } : {}),
  };
}
