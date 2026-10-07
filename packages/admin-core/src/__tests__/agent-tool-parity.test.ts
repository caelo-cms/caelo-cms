// SPDX-License-Identifier: MPL-2.0

/**
 * Agent-tool parity guard (CLAUDE.md §11 + §11.A).
 *
 * Product principle: an operator never has to do something manually that
 * the agent cannot do — including over the admin Power-MCP. Two mechanical
 * checks keep that from silently regressing:
 *
 *  (a) every Query API op whose actorScope admits the AI is named by at
 *      least one registered AI tool's source (a string literal `"<op>"` in
 *      `src/ai/tools/**`), OR is listed in `AI_OP_EXCEPTIONS` with a
 *      reviewed reason. An op opened to the AI without a tool is exactly
 *      the "AI could call this but has no tool" gap §11 calls a review-pass
 *      item;
 *  (b) every op whose actorScope EXCLUDES the AI carries a
 *      `// Why human-only:` (or `// Why system-only:`) justification inside
 *      its `defineOperation({...})`, before `actorScope` — CLAUDE.md §11's
 *      "narrower scopes need a justification at the op definition" — or is
 *      parked in `HUMAN_ONLY_PENDING` for a named follow-up.
 *
 * Plus: every registered tool (and every tool an exception says covers an
 * op) is on the Power-MCP catalogue unless it is in the documented
 * `POWER_MCP_EXCLUDED_TOOLS` set.
 *
 * Both exception lists are checked for staleness: an entry for an op that
 * no longer needs it fails, so the lists only ever shrink honestly.
 *
 * Why a source scan for (a) and not a runtime trace: tools call ops through
 * `execute(registry, adapter, ctx, "<op>", …)` (or a factory's `opName:`),
 * always with a literal op name; the knip gate keeps `src/ai/tools` free of
 * unregistered dead files, so a literal there is a reachable tool path.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { OperationRegistry } from "@caelo-cms/query-api";

import { createDefaultToolRegistry } from "../ai/tools/index.js";
import { POWER_MCP_EXCLUDED_TOOLS, powerToolCatalogue } from "../ops/security/mcp_power.js";
import { registerAdminOps } from "../register.js";
import { AI_OP_EXCEPTIONS, HUMAN_ONLY_PENDING } from "./agent-tool-parity.exceptions.js";

const ADMIN_CORE_SRC = join(import.meta.dir, "..");
const PACKAGES_DIR = join(ADMIN_CORE_SRC, "..", "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist")
        continue;
      out.push(...sourceFiles(p));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const registry = new OperationRegistry();
registerAdminOps(registry);
const opScopes = new Map<string, readonly string[]>(
  registry.names().map((name) => {
    const r = registry.lookup(name);
    if (!r.ok) throw new Error(`registered op ${name} failed lookup`);
    return [name, r.value.actorScope];
  }),
);
const aiOps = [...opScopes].filter(([, scope]) => scope.includes("ai")).map(([n]) => n);
const humanOnlyOps = [...opScopes].filter(([, scope]) => !scope.includes("ai")).map(([n]) => n);

const tools = createDefaultToolRegistry();
const toolNames = new Set(tools.catalogue().map((t) => t.name));
const toolSource = sourceFiles(join(ADMIN_CORE_SRC, "ai", "tools"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");

/** Op names the tool sources reference as a string literal. */
function referencedByTools(op: string): boolean {
  return toolSource.includes(`"${op}"`);
}

/**
 * The check behind (a), pure so its failure mode is itself tested: the
 * AI-scoped ops that no tool source names and no exception explains.
 */
function uncoveredAiOps(
  ops: readonly string[],
  source: string,
  exceptions: Readonly<Record<string, unknown>>,
): string[] {
  return ops.filter((op) => !source.includes(`"${op}"`) && !(op in exceptions));
}

describe("agent-tool parity (a): every AI-scoped op has a tool or a reviewed exception", () => {
  it("flags an AI-scoped op that has neither a tool nor an exception", () => {
    const source = 'execute(registry, adapter, ctx, "widgets.create", input);';
    expect(
      uncoveredAiOps(["widgets.create", "widgets.delete", "widgets.list"], source, {
        "widgets.list": { kind: "internal", reason: "x" },
      }),
    ).toEqual(["widgets.delete"]);
  });

  it("no AI-scoped op is unreachable for the agent", () => {
    const missing = uncoveredAiOps(aiOps, toolSource, AI_OP_EXCEPTIONS);
    expect(
      missing,
      "These ops admit the AI actor but no AI tool names them. Add a tool (CLAUDE.md §11; " +
        "hard-to-revert → an Owner-approval card, §11.A), narrow the actorScope with a " +
        "`// Why human-only:` justification, or — if the agent genuinely reaches it another " +
        "way — add a reviewed entry to agent-tool-parity.exceptions.ts.",
    ).toEqual([]);
  });

  it("exceptions are not stale", () => {
    const stale = Object.keys(AI_OP_EXCEPTIONS).flatMap((op) => {
      const scope = opScopes.get(op);
      if (!scope) return [`${op}: not a registered op`];
      if (!scope.includes("ai")) return [`${op}: no longer AI-scoped`];
      if (referencedByTools(op)) return [`${op}: a tool now names it — drop the exception`];
      return [];
    });
    expect(stale).toEqual([]);
  });

  it("every exception carries a real reason, and gaps name their follow-up", () => {
    const weak = Object.entries(AI_OP_EXCEPTIONS).flatMap(([op, e]) => {
      const text = e.kind === "covered" ? e.note : e.reason;
      const problems: string[] = [];
      if (text.trim().length < 20) problems.push(`${op}: reason too thin`);
      if (e.kind === "gap" && e.followUp.trim().length < 10) problems.push(`${op}: no follow-up`);
      return problems;
    });
    expect(weak).toEqual([]);
  });

  it("'covered' exceptions point at registered tools that the Power-MCP serves", () => {
    const broken = Object.entries(AI_OP_EXCEPTIONS).flatMap(([op, e]) => {
      if (e.kind !== "covered") return [];
      return e.by.flatMap((tool) => {
        if (!toolNames.has(tool)) return [`${op}: covering tool ${tool} is not registered`];
        if (POWER_MCP_EXCLUDED_TOOLS.has(tool))
          return [`${op}: covering tool ${tool} is excluded from Power-MCP`];
        return [];
      });
    });
    expect(broken).toEqual([]);
  });
});

describe("agent-tool parity: the Power-MCP surface", () => {
  it("serves every registered tool except the documented chat-loop-only exclusions", () => {
    const served = new Set(powerToolCatalogue(tools).map((t) => t.name));
    const notServed = [...toolNames].filter(
      (t) => !served.has(t) && !POWER_MCP_EXCLUDED_TOOLS.has(t),
    );
    expect(notServed).toEqual([]);
  });

  it("serves the agent-parity tools added for the operator buttons", () => {
    const served = new Set(powerToolCatalogue(tools).map((t) => t.name));
    for (const t of [
      "deploy_staging",
      "create_experiment",
      "list_experiments",
      "get_experiment_results",
      "verify_domains",
      "verify_dns_records",
      "delete_media_many",
      "delete_modules_many",
      "accept_import_pages",
      "cleanup_import_run",
      "send_test_email",
    ]) {
      expect(served.has(t)).toBe(true);
    }
  });
});

// ─── (b) human-only ops carry their justification ──────────────────────

const HUMAN_ONLY_JUSTIFICATION = /\/\/\s*Why (?:human|system)-only\b/;

/** Every non-test source file that can define an admin op. */
const definitionSources = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => {
    const src = join(PACKAGES_DIR, d.name, "src");
    try {
      return sourceFiles(src);
    } catch {
      return [];
    }
  })
  .map((file) => ({ file, text: readFileSync(file, "utf8") }));

/**
 * The text of an op's definition from `defineOperation(` up to the end of
 * its `actorScope` line — where CLAUDE.md §11 wants the justification.
 * Returns null when the op is not defined with a literal `name: "<op>"`.
 */
function headIn(text: string, op: string): string | null {
  const at = text.indexOf(`name: "${op}"`);
  if (at === -1) return null;
  const start = text.lastIndexOf("defineOperation", at);
  const scopeAt = text.indexOf("actorScope", at);
  if (start === -1 || scopeAt === -1) return null;
  const lineEnd = text.indexOf("\n", scopeAt);
  return text.slice(start, lineEnd === -1 ? undefined : lineEnd);
}

function definitionHead(op: string): { file: string; head: string } | null {
  for (const { file, text } of definitionSources) {
    const head = headIn(text, op);
    if (head !== null) return { file: relative(PACKAGES_DIR, file), head };
  }
  return null;
}

describe("agent-tool parity (b): every human-only op says why", () => {
  it("each op without the AI in its actorScope has a `// Why human-only:` justification", () => {
    const missing = humanOnlyOps.flatMap((op) => {
      if (op in HUMAN_ONLY_PENDING) return [];
      const def = definitionHead(op);
      if (!def) return [`${op}: definition not found (expected a literal name: "${op}")`];
      return HUMAN_ONLY_JUSTIFICATION.test(def.head) ? [] : [`${op} (${def.file})`];
    });
    expect(
      missing,
      "CLAUDE.md §11: an actorScope narrower than human+ai+system needs a `// Why human-only:` " +
        "(or `// Why system-only:`) comment inside defineOperation, before actorScope. If the " +
        "honest answer is 'the agent should be able to do this', give it a tool or an " +
        "Owner-approval card instead.",
    ).toEqual([]);
  });

  it("pending entries are not stale", () => {
    const stale = Object.keys(HUMAN_ONLY_PENDING).flatMap((op) => {
      const scope = opScopes.get(op);
      if (!scope) return [`${op}: not a registered op`];
      if (scope.includes("ai")) return [`${op}: now AI-scoped`];
      const def = definitionHead(op);
      if (def && HUMAN_ONLY_JUSTIFICATION.test(def.head))
        return [`${op}: now annotated — drop the pending entry`];
      return [];
    });
    expect(stale).toEqual([]);
  });

  it("finds the justification only inside the op definition, before actorScope", () => {
    const annotated =
      'defineOperation({\n  name: "x.y",\n  // Why human-only: Owner gate.\n  actorScope: ["human"],';
    const bare =
      'defineOperation({\n  name: "x.y",\n  actorScope: ["human"],\n  // Why human-only: too late';
    expect(HUMAN_ONLY_JUSTIFICATION.test(headIn(annotated, "x.y") ?? "")).toBe(true);
    expect(HUMAN_ONLY_JUSTIFICATION.test(headIn(bare, "x.y") ?? "")).toBe(false);
  });

  it("the justification pattern matches the documented forms", () => {
    expect(HUMAN_ONLY_JUSTIFICATION.test("  // Why human-only: Owner-only")).toBe(true);
    expect(HUMAN_ONLY_JUSTIFICATION.test("  // Why system-only: bearer in input")).toBe(true);
    expect(HUMAN_ONLY_JUSTIFICATION.test("  // Why human-only (+system): auth page")).toBe(true);
    expect(HUMAN_ONLY_JUSTIFICATION.test("  // human-only by design")).toBe(false);
  });
});
