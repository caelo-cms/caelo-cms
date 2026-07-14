// SPDX-License-Identifier: MPL-2.0

/**
 * issue #268 / #304 — the concurrency + budget core of `spawn_subagents`,
 * factored out of the tool handler so it is unit-testable with a mock
 * `runSpawn` (no chat-runner, no DB, no provider).
 *
 * Two layers:
 *   - {@link runSubagentBatch} — ONE dispatch wave: bounded worker pool +
 *     in-flight batch-cost abort + n-of-m progress (issue #268, PR #291).
 *   - {@link runSubagentWaves} — issue #304: wave orchestration on top.
 *     Derives per-child caps from the remaining run budget before each
 *     wave, re-dispatches partial children's remainders in follow-up
 *     waves, stops loudly on no-progress, and stops dispatching entirely
 *     when the #297 run ceiling is reached (surfacing the #297 pause
 *     wording — never a second pause mechanism).
 */

import type { SpawnSubagentToolInput, SubagentModelTier } from "@caelo-cms/shared";
import {
  buildEscalationTask,
  buildRemainderTask,
  deriveChildCaps,
  escalateSpecTier,
  extractEscalations,
  MAX_ESCALATION_DEPTH,
  MAX_ZERO_PROGRESS_WAVES,
  mergeRebuildPages,
  pageRefList,
  type SubagentPageRef,
  type SubagentPartialState,
} from "./subagent-budget.js";

/**
 * Run #10 D2 — structured failure classes for a spawn (CLAUDE.md §11:
 * failure surfaces are AI-actionable). `child-error` is the child's own
 * provider/runtime failure (context limit, cost cap, dead stream) —
 * NEVER parseable-looking output; `empty-result` / `shape-mismatch`
 * are result-channel failures after the automatic nudge retry;
 * `spawn-error` is plumbing (session create, stream threw).
 */
export type SubagentErrorKind =
  | "spawn-error"
  | "child-error"
  | "empty-result"
  | "shape-mismatch"
  // issue #268 — this spec was never started: the batch had already
  // spent past `batchMaxCostMicrocents` when its pool slot came up.
  | "batch-aborted"
  // issue #304 — a remainder that completed ZERO new pages in
  // MAX_ZERO_PROGRESS_WAVES consecutive waves; re-dispatching it again
  // would spend money on the same wall.
  | "no-progress"
  // issue #304 — not (re-)dispatched: the run's #297 cost ceiling was
  // reached between waves. Completed pages are kept; the run resumes
  // after the operator re-arms the budget.
  | "run-budget-paused"
  // issue #304 — the SUBAGENT_MAX_WAVES belt fired while the remainder
  // was still making progress (braces: no-progress guard + budget gate).
  | "wave-limit"
  // issue #306 — pages flagged needs_escalation with no automated rung
  // left to route to: the flagging child already ran at the top
  // (inherit) tier, or the page was escalated once already
  // (MAX_ESCALATION_DEPTH). The parent AI / operator takes over.
  | "escalation-limit";

export interface SubagentInvocationResult {
  role: string;
  status: "completed" | "partial" | "errored" | "timed_out";
  resultJson: unknown;
  costMicrocents: number;
  durationMs: number;
  subagentChatSessionId: string;
  errorMessage?: string;
  /** Run #10 D2 — which structured failure class an errored spawn belongs to. */
  errorKind?: SubagentErrorKind;
  /**
   * issue #304 — set when `status === "partial"` (and preserved on the
   * final result when a partial remainder is stopped by a guard):
   * what landed and what remains, so the wave orchestrator can
   * re-dispatch exactly the remainder and the parent AI can report it.
   */
  partial?: SubagentPartialState;
}

/** issue #268 — one n-of-m tick the batch orchestrator hands its caller. */
export interface SubagentBatchProgress {
  /** Specs settled so far (run OR budget-aborted). */
  finished: number;
  /** Total specs in the batch. */
  total: number;
  /** Specs that actually invoked a child turn (excludes budget-aborted). */
  ran: number;
  /** Running sum of settled children's rolled-up cost. */
  totalCostMicrocents: number;
  /** Role of the spec that just settled. */
  lastRole: string;
  /** True once the running cost tripped the batch cap and later specs are skipped. */
  batchAborted: boolean;
}

/** issue #268 — the batch orchestrator's return: ordered results + roll-up. */
export interface SubagentBatchOutcome {
  /** One result per input spec, in input order. */
  results: SubagentInvocationResult[];
  /** Sum of every settled child's rolled-up `ai_calls` cost. */
  totalCostMicrocents: number;
  /** True when at least one spec was skipped because the batch cap was hit. */
  batchAborted: boolean;
  /**
   * True when the final total spend exceeded the cap — the hard budget
   * signal. Distinct from `batchAborted`: the LAST in-flight child can
   * tip the total over the cap with NO later specs left to skip, in
   * which case nothing is aborted (`batchAborted` stays false) but the
   * ceiling was still blown. Callers gating on budget MUST read this,
   * not `batchAborted` (Copilot #291-1). `batchAborted ⟹ overBudget`,
   * never the reverse.
   */
  overBudget: boolean;
  /** Count of specs that actually ran (invoked a child turn). */
  ran: number;
}

/**
 * The synthetic result for a spec that never started because the batch
 * had already spent past its cap. Zero cost, zero duration — it did no
 * work. AI-actionable message (CLAUDE.md §11): tells the parent exactly
 * how to recover (smaller batch, or raise the cap).
 */
function batchAbortedResult(
  spec: SpawnSubagentToolInput,
  spentMicrocents: number,
  capMicrocents: number,
): SubagentInvocationResult {
  return {
    role: spec.role,
    status: "errored",
    resultJson: null,
    costMicrocents: 0,
    durationMs: 0,
    subagentChatSessionId: "",
    errorKind: "batch-aborted",
    errorMessage:
      `not started: the batch had already spent $${(spentMicrocents / 1e8).toFixed(4)} ` +
      `(cap $${(capMicrocents / 1e8).toFixed(4)}) when this subagent's turn came up. ` +
      "Recovery: re-run this page in a fresh, SMALLER spawn_subagents batch, or raise " +
      "SUBAGENT_BATCH_CAP_MICROCENTS if the higher spend is expected.",
  };
}

/**
 * issue #268 — one dispatch wave. Runs `specs` through a bounded worker
 * pool:
 *
 *   - **Concurrency:** at most `maxParallel` child turns are in flight at
 *     once. `Promise.all` over N children would flood the provider; the
 *     pool caps it and drains the queue as slots free up.
 *   - **Budget abort (in-flight, not post-hoc):** each worker checks the
 *     running cost BEFORE it starts the next spec. Once the batch total
 *     exceeds `batchMaxCostMicrocents`, remaining specs resolve as
 *     `batch-aborted` WITHOUT running — so the batch can overshoot the
 *     cap by at most the cost of the children already in flight when the
 *     line was crossed, never by the full width of the untouched queue.
 *   - **Progress:** `onProgress` fires once per settled spec with the
 *     n-of-m counts + running cost, so the caller can stream live ticks.
 *
 * Results are returned in input order regardless of completion order.
 *
 * @param specs        the batch (already length-validated by the caller).
 * @param runSpawn     runs ONE subagent; the real one is `runOneSubagent`,
 *                     tests pass a mock that records max-in-flight / cost.
 * @param opts.maxParallel            max simultaneous in-flight spawns.
 * @param opts.batchMaxCostMicrocents batch-wide spend ceiling.
 * @param opts.onProgress            per-settlement n-of-m callback.
 */
export async function runSubagentBatch(
  specs: readonly SpawnSubagentToolInput[],
  runSpawn: (spec: SpawnSubagentToolInput, index: number) => Promise<SubagentInvocationResult>,
  opts: {
    maxParallel: number;
    batchMaxCostMicrocents: number;
    onProgress?: (progress: SubagentBatchProgress) => void;
  },
): Promise<SubagentBatchOutcome> {
  const total = specs.length;
  const results = new Array<SubagentInvocationResult>(total);
  let runningCostMicrocents = 0;
  let finished = 0;
  let ran = 0;
  let batchAborted = false;
  // Claimed synchronously (no await between read and increment) so two
  // workers never grab the same index — JS's single-threaded loop makes
  // this the whole mutual-exclusion story; no lock needed.
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const spec = specs[index] as SpawnSubagentToolInput;

      if (runningCostMicrocents > opts.batchMaxCostMicrocents) {
        batchAborted = true;
        results[index] = batchAbortedResult(
          spec,
          runningCostMicrocents,
          opts.batchMaxCostMicrocents,
        );
      } else {
        const result = await runSpawn(spec, index);
        runningCostMicrocents += result.costMicrocents;
        ran += 1;
        results[index] = result;
      }

      finished += 1;
      opts.onProgress?.({
        finished,
        total,
        ran,
        totalCostMicrocents: runningCostMicrocents,
        lastRole: spec.role,
        batchAborted,
      });
    }
  };

  const workerCount = Math.max(1, Math.min(opts.maxParallel, total));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    results,
    totalCostMicrocents: runningCostMicrocents,
    batchAborted,
    // Final-total budget check: catches the last-child-tips-over case
    // that `batchAborted` (specs-were-skipped) misses (Copilot #291-1).
    overBudget: runningCostMicrocents > opts.batchMaxCostMicrocents,
    ran,
  };
}

// ---------------------------------------------------------------------
// issue #304 — wave orchestration
// ---------------------------------------------------------------------

/**
 * The run-budget snapshot the wave orchestrator re-reads before EVERY
 * wave. Built by the caller from the #297 gate state
 * (`imports.get_session_budget_state` via `fetchBudgetGate`) so this
 * module stays pure/mockable. `null` from the fetcher = no ceilinged run
 * governs this session — fallback caps apply and no budget stop fires
 * here (the parent loop's own #297 gate still governs the turn).
 */
export interface RunBudgetSnapshot {
  /** `ceiling − spent` in microcents (may be ≤ 0 once overrun). */
  remainingMicrocents: number;
  /** True when the #297 gate evaluates to `trip` (spend ≥ ceiling). */
  tripped: boolean;
  /**
   * The #297 pause message (`budgetTripText` wording) to surface when
   * dispatch stops — reused verbatim so there is exactly ONE pause
   * vocabulary in the product, not a second subagent-flavoured one.
   */
  pauseText: string;
}

/** Options for {@link runSubagentWaves}. */
export interface SubagentWavesOpts {
  maxParallel: number;
  /** Env fallback per-child cap, used when no run ceiling is armed. */
  fallbackChildCapMicrocents: number;
  /** Env fallback per-wave batch cap, used when no run ceiling is armed. */
  fallbackBatchCapMicrocents: number;
  /** Wave belt (see SUBAGENT_MAX_WAVES). */
  maxWaves: number;
  /** Re-read the remaining run budget; called once before each wave. */
  fetchRunBudget: (() => Promise<RunBudgetSnapshot | null>) | null;
  /** Per-settlement progress tick, tagged with the wave index. */
  onProgress?: (progress: SubagentBatchProgress & { wave: number }) => void;
  /**
   * issue #306 — tiers (beyond `inherit`) the install has models mapped
   * for; drives the escalation ladder (`small` steps to `mid` only when
   * `mid` is mapped, else straight to `inherit`). Absent/empty = tiering
   * off — escalations from small/mid still route to `inherit` (the
   * parent's model), which needs no mapping.
   */
  availableTiers?: ReadonlySet<string>;
}

/** The wave orchestrator's return: final per-original-spec results + roll-up. */
export interface SubagentWavesOutcome {
  /** One FINAL result per original input spec (remainder attempts merged). */
  results: SubagentInvocationResult[];
  /** Spend summed across every wave. */
  totalCostMicrocents: number;
  /** Waves actually dispatched (≥ 1 unless the budget was tripped up front). */
  waves: number;
  /** Child turns actually run across all waves. */
  ran: number;
  /** True when dispatch stopped because the run ceiling was reached. */
  budgetStopped: boolean;
  /** The #297 pause wording when `budgetStopped`; null otherwise. */
  pauseText: string | null;
  /**
   * True when a FALLBACK-capped wave blew the env batch cap — the hard
   * not-ok signal in un-ceilinged runs (Copilot #291-1 semantics). In
   * run-budget-capped waves an overrun is recoverable: the next wave's
   * budget re-check either absorbs it or stops dispatch.
   */
  fallbackOverBudget: boolean;
  /** Where the LAST dispatched wave's caps came from (roll-up display). */
  capSource: "run-budget" | "fallback" | null;
}

/** Per-dispatch-line state carried across waves. Pre-#306 exactly one of
 * these existed per original spec; escalation (issue #306) can FORK a
 * second line off the same spec (the cost-remainder continues at the
 * child's own tier while the escalated pages re-dispatch a tier up), so
 * several items may share an `originalIndex` — their finalized parts are
 * merged back into ONE result per spec by {@link mergeFinalParts}. */
interface PendingItem {
  originalIndex: number;
  /** The untouched original spec (source of truth for the remainder brief). */
  originalSpec: SpawnSubagentToolInput;
  /** The spec to dispatch THIS wave (task rewritten for remainders). */
  waveSpec: SpawnSubagentToolInput;
  /** issue #306 — the tier this line dispatches at (escalation raises it). */
  tier: SubagentModelTier;
  /** issue #306 — how many escalations led to this line (bound: 1). */
  escalationDepth: number;
  completedPages: SubagentPageRef[];
  costSoFarMicrocents: number;
  durationSoFarMs: number;
  zeroProgressWaves: number;
}

/**
 * issue #306 — fold several finalized parts (a forked spec's dispatch
 * lines) back into ONE result for the original spec. Later parts win on
 * per-page collisions (the escalated attempt has the freshest status for
 * a page it resolved). Single-part specs — every pre-#306 flow — pass
 * through untouched.
 */
function mergeFinalParts(parts: readonly SubagentInvocationResult[]): SubagentInvocationResult {
  if (parts.length === 1) return parts[0] as SubagentInvocationResult;
  const first = parts[0] as SubagentInvocationResult;
  let resultJson: unknown = first.resultJson;
  let costMicrocents = first.costMicrocents;
  let durationMs = first.durationMs;
  let subagentChatSessionId = first.subagentChatSessionId;
  const completedPages: SubagentPageRef[] = [...(first.partial?.completedPages ?? [])];
  const remainingPages: SubagentPageRef[] = [...(first.partial?.remainingPages ?? [])];
  const errorMessages: string[] = first.errorMessage ? [first.errorMessage] : [];
  let errorKind = first.errorKind;
  for (const part of parts.slice(1)) {
    costMicrocents += part.costMicrocents;
    durationMs += part.durationMs;
    if (part.subagentChatSessionId) subagentChatSessionId = part.subagentChatSessionId;
    resultJson = mergeRebuildResultJson(resultJson, part.resultJson);
    completedPages.push(...(part.partial?.completedPages ?? []));
    remainingPages.push(...(part.partial?.remainingPages ?? []));
    if (part.errorMessage) errorMessages.push(part.errorMessage);
    if (!errorKind && part.errorKind) errorKind = part.errorKind;
  }
  const allCompleted = parts.every((p) => p.status === "completed");
  const anyLanded = parts.some((p) => p.status === "completed") || completedPages.length > 0;
  const status: SubagentInvocationResult["status"] = allCompleted
    ? "completed"
    : anyLanded
      ? "partial"
      : ((parts.find((p) => p.status !== "completed")?.status ??
          "errored") as SubagentInvocationResult["status"]);
  return {
    role: first.role,
    status,
    resultJson,
    costMicrocents,
    durationMs,
    subagentChatSessionId,
    ...(errorMessages.length > 0 ? { errorMessage: errorMessages.join("\n") } : {}),
    ...(errorKind ? { errorKind } : {}),
    ...(status === "partial" || completedPages.length > 0 || remainingPages.length > 0
      ? { partial: { completedPages, remainingPages } }
      : {}),
  };
}

/**
 * Merge two rebuild-shaped result payloads page-wise, `b` (the later
 * part) winning on slug/pageId collision. Non-rebuild payloads pass the
 * non-null one through — same tolerance as {@link mergeRebuildPages}.
 */
function mergeRebuildResultJson(a: unknown, b: unknown): unknown {
  const pagesOf = (v: unknown): Record<string, unknown>[] | null => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
    const pages = (v as Record<string, unknown>).pages;
    return Array.isArray(pages) ? (pages as Record<string, unknown>[]) : null;
  };
  const aPages = pagesOf(a);
  const bPages = pagesOf(b);
  if (bPages === null) return aPages !== null ? a : (a ?? b);
  if (aPages === null) return b;
  const keyOf = (p: { pageId?: unknown; slug?: unknown }): string =>
    String(p.slug ?? p.pageId ?? "");
  const bKeys = new Set(bPages.map(keyOf).filter((k) => k !== ""));
  const carried = aPages.filter((p) => {
    const k = keyOf(p);
    return k === "" || !bKeys.has(k);
  });
  return {
    ...(a as Record<string, unknown>),
    ...(b as Record<string, unknown>),
    pages: [...carried, ...bPages],
  };
}

/** Finalize a pending item's last partial attempt with a guard verdict. */
function stopPartial(
  item: PendingItem,
  last: SubagentInvocationResult,
  errorKind: SubagentErrorKind,
  errorMessage: string,
): SubagentInvocationResult {
  return {
    ...last,
    status: "partial",
    errorKind,
    errorMessage,
    costMicrocents: item.costSoFarMicrocents + last.costMicrocents,
    durationMs: item.durationSoFarMs + last.durationMs,
    resultJson: mergeRebuildPages(item.completedPages, last.resultJson),
    partial: {
      completedPages: [...item.completedPages, ...(last.partial?.completedPages ?? [])],
      remainingPages: last.partial?.remainingPages ?? [],
    },
  };
}

/**
 * issue #304 — run a `spawn_subagents` call as budget-derived waves.
 *
 * Wave 0 dispatches the caller's specs. Children that submit a PARTIAL
 * result (cost wrap-up: landed pages + explicit remainder) get their
 * remainder re-dispatched as a fresh spec in the next wave — work is
 * preserved and re-briefed, never re-done. Before every wave the run
 * budget is re-read; a tripped #297 ceiling stops dispatch and surfaces
 * the #297 pause text. Guards: a remainder with zero new pages
 * MAX_ZERO_PROGRESS_WAVES waves in a row stops loudly (`no-progress`),
 * and `maxWaves` is the belt over everything.
 */
export async function runSubagentWaves(
  specs: readonly SpawnSubagentToolInput[],
  runSpawn: (
    spec: SpawnSubagentToolInput,
    originalIndex: number,
  ) => Promise<SubagentInvocationResult>,
  opts: SubagentWavesOpts,
): Promise<SubagentWavesOutcome> {
  // issue #306 — a spec can fork into several dispatch lines (cost
  // remainder + escalation), so finals accumulate as PARTS per original
  // index and merge at the end. Single-line specs merge to themselves.
  const finalParts: SubagentInvocationResult[][] = specs.map(() => []);
  const pushFinal = (originalIndex: number, part: SubagentInvocationResult): void => {
    finalParts[originalIndex]?.push(part);
  };
  const availableTiers = opts.availableTiers ?? new Set<string>();
  let pending: PendingItem[] = specs.map((spec, i) => ({
    originalIndex: i,
    originalSpec: spec,
    waveSpec: spec,
    // `?? "inherit"` — callers that build specs without the Zod parse
    // (tests, internal wiring) may omit the defaulted field.
    tier: spec.tier ?? "inherit",
    escalationDepth: 0,
    completedPages: [],
    costSoFarMicrocents: 0,
    durationSoFarMs: 0,
    zeroProgressWaves: 0,
  }));

  let waves = 0;
  let ran = 0;
  let totalCostMicrocents = 0;
  let budgetStopped = false;
  let pauseText: string | null = null;
  let fallbackOverBudget = false;
  let capSource: SubagentWavesOutcome["capSource"] = null;

  while (pending.length > 0) {
    // Belt: never exceed maxWaves dispatches, whatever the remainders say.
    if (waves >= opts.maxWaves) {
      for (const item of pending) {
        const message =
          `stopped after ${waves} dispatch waves (SUBAGENT_MAX_WAVES belt). ` +
          `${item.completedPages.length} page(s) completed so far are saved. ` +
          "Recovery: re-run the remaining pages in a fresh spawn_subagents call.";
        pushFinal(item.originalIndex, {
          role: item.originalSpec.role,
          status: item.completedPages.length > 0 ? "partial" : "errored",
          resultJson: null,
          costMicrocents: item.costSoFarMicrocents,
          durationMs: item.durationSoFarMs,
          subagentChatSessionId: "",
          errorKind: "wave-limit",
          errorMessage: message,
          ...(item.completedPages.length > 0
            ? { partial: { completedPages: item.completedPages, remainingPages: [] } }
            : {}),
        });
      }
      break;
    }

    // issue #304 deliverable 3 — re-read the remaining run budget before
    // EVERY wave. A tripped ceiling stops dispatch cleanly: pending items
    // keep their landed pages, and the #297 pause text (same wording the
    // chat loop uses) is surfaced instead of a second pause mechanism.
    const budget = opts.fetchRunBudget ? await opts.fetchRunBudget() : null;
    if (budget !== null && (budget.tripped || budget.remainingMicrocents <= 0)) {
      budgetStopped = true;
      pauseText = budget.pauseText;
      for (const item of pending) {
        const notDispatched =
          `not ${waves === 0 ? "started" : "re-dispatched"}: the run's cost ceiling was reached. ` +
          `${item.completedPages.length} completed page(s) are saved` +
          (item.completedPages.length > 0 ? ` (${pageRefList(item.completedPages)})` : "") +
          ". The run resumes where it stopped once the operator raises the budget.";
        pushFinal(item.originalIndex, {
          role: item.originalSpec.role,
          // Landed pages make this an honest PARTIAL; a spec that never
          // ran (or landed nothing) is errored-not-dispatched.
          status: item.completedPages.length > 0 ? "partial" : "errored",
          resultJson: null,
          costMicrocents: item.costSoFarMicrocents,
          durationMs: item.durationSoFarMs,
          subagentChatSessionId: "",
          errorKind: "run-budget-paused",
          errorMessage: notDispatched,
          ...(item.completedPages.length > 0
            ? { partial: { completedPages: item.completedPages, remainingPages: [] } }
            : {}),
        });
      }
      break;
    }

    // Deliverable 1 — caps derived from the armed run budget (env
    // fallbacks only when no ceiling governs the session). Explicit
    // per-spec caps always win over the derived value.
    const caps = deriveChildCaps({
      remainingRunBudgetMicrocents: budget?.remainingMicrocents ?? null,
      plannedChildren: pending.length,
      fallbackChildCapMicrocents: opts.fallbackChildCapMicrocents,
      fallbackBatchCapMicrocents: opts.fallbackBatchCapMicrocents,
    });
    capSource = caps.source;
    const waveSpecs = pending.map((item) => ({
      ...item.waveSpec,
      maxCostMicrocents: item.waveSpec.maxCostMicrocents ?? caps.perChildCapMicrocents,
    }));

    const wave = waves;
    const outcome = await runSubagentBatch(
      waveSpecs,
      (spec, waveIndex) => runSpawn(spec, (pending[waveIndex] as PendingItem).originalIndex),
      {
        maxParallel: opts.maxParallel,
        batchMaxCostMicrocents: caps.batchCapMicrocents,
        onProgress: opts.onProgress ? (p) => opts.onProgress?.({ ...p, wave }) : undefined,
      },
    );
    waves += 1;
    ran += outcome.ran;
    totalCostMicrocents += outcome.totalCostMicrocents;
    if (outcome.overBudget && caps.source === "fallback") fallbackOverBudget = true;

    const next: PendingItem[] = [];
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i] as PendingItem;
      const result = outcome.results[i] as SubagentInvocationResult;

      // issue #306 — route needs_escalation pages ONE capability step up
      // BEFORE the normal status handling: escalation composes with every
      // outcome class (a child can be partial for cost AND escalate other
      // pages — the remainder continues at its own tier below while the
      // escalated pages fork onto a higher-tier line here).
      const escalations = extractEscalations(result.resultJson);
      if (escalations.length > 0) {
        const nextTier =
          item.escalationDepth >= MAX_ESCALATION_DEPTH
            ? null
            : escalateSpecTier(item.tier, availableTiers);
        if (nextTier === null) {
          // No automated rung left (already escalated once, or the child
          // ran at the parent's own capability). Loud, structured stop —
          // never a silent drop or a same-tier re-run of the confusion.
          const reasonLines = escalations
            .map((e) => `- ${e.slug ?? e.pageId ?? "(unidentified page)"}: ${e.reason}`)
            .join("\n");
          pushFinal(item.originalIndex, {
            role: item.originalSpec.role,
            status: "partial",
            resultJson: null,
            costMicrocents: 0,
            durationMs: 0,
            subagentChatSessionId: result.subagentChatSessionId,
            errorKind: "escalation-limit",
            errorMessage:
              `${escalations.length} page(s) need work beyond what automated re-dispatch can ` +
              `route further:\n${reasonLines}\nThese pages were NOT re-dispatched. Handle them ` +
              "directly in this chat (or brief the operator on the open decisions).",
          });
        } else {
          // Fork a fresh dispatch line one step up. It starts clean (no
          // inherited pages/cost) — its spend and results merge back into
          // the same original spec's final entry.
          next.push({
            originalIndex: item.originalIndex,
            originalSpec: item.originalSpec,
            tier: nextTier,
            escalationDepth: item.escalationDepth + 1,
            waveSpec: {
              ...item.originalSpec,
              tier: nextTier,
              task: buildEscalationTask({
                originalTask: item.originalSpec.task,
                escalations,
              }),
            },
            completedPages: [],
            costSoFarMicrocents: 0,
            durationSoFarMs: 0,
            zeroProgressWaves: 0,
          });
        }
      }

      if (result.status === "partial" && result.partial) {
        const newlyCompleted = result.partial.completedPages;
        const progressed = newlyCompleted.length > 0;
        item.zeroProgressWaves = progressed ? 0 : item.zeroProgressWaves + 1;
        if (item.zeroProgressWaves >= MAX_ZERO_PROGRESS_WAVES) {
          // Loud stop — deliverable 2's bounded-retry guard.
          pushFinal(
            item.originalIndex,
            stopPartial(
              item,
              result,
              "no-progress",
              `remainder made no progress ${item.zeroProgressWaves} waves in a row ` +
                `(${result.partial.remainingPages.length} page(s) still unfinished: ` +
                `${pageRefList(result.partial.remainingPages)}). Stopping instead of spending ` +
                "again on the same wall. Recovery: split these pages into smaller, more explicit " +
                "tasks, or handle them directly.",
            ),
          );
          continue;
        }
        const completedPages = [...item.completedPages, ...newlyCompleted];
        next.push({
          ...item,
          completedPages,
          costSoFarMicrocents: item.costSoFarMicrocents + result.costMicrocents,
          durationSoFarMs: item.durationSoFarMs + result.durationMs,
          waveSpec: {
            ...item.originalSpec,
            task: buildRemainderTask({
              originalTask: item.originalSpec.task,
              completedPages,
              remainingPages: result.partial.remainingPages,
              wave,
            }),
          },
        });
        continue;
      }

      if (result.errorKind === "batch-aborted") {
        // Never started this wave — requeue unchanged. Counted as a
        // zero-progress wave so a wave that aborts the same spec twice in
        // a row still terminates (in fallback mode the cap is constant,
        // so a third attempt would abort identically).
        item.zeroProgressWaves += 1;
        if (item.zeroProgressWaves >= MAX_ZERO_PROGRESS_WAVES) {
          pushFinal(item.originalIndex, {
            ...result,
            // Landed pages from earlier partial waves stay visible even
            // when the last wave never started this spec.
            status: item.completedPages.length > 0 ? "partial" : result.status,
            costMicrocents: item.costSoFarMicrocents,
            durationMs: item.durationSoFarMs,
            ...(item.completedPages.length > 0
              ? { partial: { completedPages: item.completedPages, remainingPages: [] } }
              : {}),
          });
        } else {
          next.push(item);
        }
        continue;
      }

      // Terminal: completed / errored / timed_out. Fold earlier waves'
      // landed pages + spend into the final result so the parent sees one
      // full-coverage entry per original spec.
      pushFinal(item.originalIndex, {
        ...result,
        costMicrocents: item.costSoFarMicrocents + result.costMicrocents,
        durationMs: item.durationSoFarMs + result.durationMs,
        resultJson:
          result.status === "completed"
            ? mergeRebuildPages(item.completedPages, result.resultJson)
            : result.resultJson,
      });
    }
    pending = next;
  }

  return {
    // issue #306 — fold forked dispatch lines (escalations) back to ONE
    // entry per original spec. Pre-#306 flows have exactly one part.
    results: finalParts.map((parts) => mergeFinalParts(parts)),
    totalCostMicrocents,
    waves,
    ran,
    budgetStopped,
    pauseText,
    fallbackOverBudget,
    capSource,
  };
}
