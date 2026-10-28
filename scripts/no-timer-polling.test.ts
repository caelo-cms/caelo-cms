// SPDX-License-Identifier: MPL-2.0

/**
 * Issue #1215 — the admin's browser code does not poll the admin on a timer
 * (CLAUDE.md §11.B: every request keeps an instance up; on 2026-10-28 two idle
 * editor tabs made ~1.7 requests a second and, once the admin slowed down,
 * stacked >100 in-flight requests per instance). Live surfaces re-read on
 * live-refresh topics, focus and own actions instead (`lib/live/live-refresh.ts`).
 *
 * This static scan fails on a timer LOOP that reaches a request:
 * - `setInterval(cb, …)` whose callback reaches a request, or
 * - `setTimeout(cb, …)` whose callback reaches a request AND reschedules
 *   itself (it reaches code that calls `setTimeout` again — the
 *   `#schedule()` pattern).
 * A one-shot `setTimeout` (a debounce of typing, a 200 ms reload coalescer)
 * and a timer that only updates local state (a clock, a watchdog) pass.
 *
 * "Reaches" follows calls to functions defined in the same file, a few
 * levels deep. A request is a `fetch`-like call (`fetch`, `liveFetch`,
 * `fetchAgentRuns`, …), `invalidate` / `invalidateAll`, `goto`, an
 * `EventSource`, or a call the scan cannot resolve whose name says it
 * re-reads (`refresh`, `poll`, `load`, `reload`). Being conservative is the
 * point: a false positive costs a rename or an allow-list line with a
 * reason; a false negative is the 2026-10-28 incident again.
 */

import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ADMIN_SRC = resolve(REPO_ROOT, "apps/admin/src");

/** Timer loops that may reach a request, and why each may. */
const ALLOWED: Record<string, string> = {
  "apps/admin/src/lib/csrf-refresh.ts":
    "one token renewal per half token lifetime (30 min), retried a minute later after a failure: a form submit in a long-open tab must not 403 (#1191). Not a status poll.",
  "apps/admin/src/lib/components/updates/UpdateTimeline.svelte":
    "progress of a running Caelo update, only while one runs, on the Owner's Updates page: the admin being asked is replaced mid-update, so no push from it survives the roll.",
};

/** Server code runs in the admin, not in a tab: not what this guard is about. */
function isClientSource(path: string): boolean {
  if (!/\.(ts|svelte)$/.test(path) || path.endsWith(".d.ts")) return false;
  if (/\.(test|bench|browser)\.ts$/.test(path)) return false;
  if (/(^|\/)lib\/server\//.test(path)) return false;
  if (/\.server\.ts$/.test(path) || /(^|\/)\+server\.ts$/.test(path)) return false;
  return true;
}

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (isClientSource(path)) out.push(path);
  }
  return out;
}

/** Index of the bracket that closes the one at `open` (`(`, `{` or `[`). */
function closingIndex(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i] ?? "";
    // Skip comments: an apostrophe in "can't" must not open a string.
    if (ch === "/" && text[i + 1] === "/") {
      const eol = text.indexOf("\n", i);
      i = eol === -1 ? text.length : eol;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    if (ch in pairs) stack.push(pairs[ch] ?? "");
    else if (ch === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i;
    } else if (ch === '"' || ch === "'" || ch === "`") {
      // Skip string literals so a ")" inside one does not end the call.
      const quote = ch;
      for (i += 1; i < text.length && text[i] !== quote; i++) if (text[i] === "\\") i++;
    }
  }
  return text.length - 1;
}

/** The first argument of the call whose `(` is at `open`. */
function firstArgument(text: string, open: number): string {
  const end = closingIndex(text, open);
  let depth = 0;
  for (let i = open + 1; i < end; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === "," && depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, end);
}

const IDENT = String.raw`[A-Za-z_$#][\w$]*`;

/** The source of `name`'s definition in `text`, or null when it is not defined there. */
function definitionOf(text: string, name: string): string | null {
  const n = name.replace(/[$#]/g, (c) => `\\${c}`);
  const patterns = [
    // function name(…) { … }
    new RegExp(String.raw`\bfunction\s+${n}\s*\(`),
    // const name = …(  /  let name = …
    new RegExp(String.raw`\b(?:const|let|var)\s+${n}\s*(?::[^=]+)?=`),
    // class / object method: name(…) {  /  async name(…) {  /  #name(…) {
    new RegExp(String.raw`(?:^|[\s;{}])(?:async\s+)?${n}\s*\([^)]*\)\s*(?::[^{]+)?\{`, "m"),
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const start = m.index;
    const brace = text.indexOf("{", start);
    const paren = text.indexOf("(", start);
    // A `const x = coalescedRefresh(async () => { … })` spans its call.
    const open = paren !== -1 && (brace === -1 || paren < brace) ? paren : brace;
    if (open === -1) return text.slice(start, start + 200);
    const close = closingIndex(text, open);
    // The body of an arrow / function after its parameter list.
    const after = text.slice(close + 1, close + 40);
    if (text[open] === "(" && /^\s*(?::[^={]+)?(?:=>)?\s*\{/.test(after)) {
      const bodyOpen = text.indexOf("{", close);
      return text.slice(start, closingIndex(text, bodyOpen) + 1);
    }
    return text.slice(start, close + 1);
  }
  return null;
}

/** Names of the functions `code` calls (or passes as a bare reference). */
function calledNames(code: string): string[] {
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`(?:this\.)?(${IDENT})\s*\(`, "g"))) {
    if (m[1]) names.add(m[1]);
  }
  const bare = code.trim();
  if (new RegExp(String.raw`^(?:this\.)?${IDENT}$`).test(bare)) {
    names.add(bare.replace(/^this\./, ""));
  }
  return [...names];
}

const REQUEST =
  /\b\w*fetch\w*\s*\(|\binvalidate(?:All)?\s*\(|\bgoto\s*\(|\bnew\s+EventSource\s*\(/i;
const REREAD_NAME = /refresh|poll|load|reload/i;
const TIMER = /\b(?:[\w$]+\.)?(setInterval|setTimeout)\s*\(/g;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "void"]);

interface Reach {
  readonly request: boolean;
  readonly reschedules: boolean;
}

/** What a timer callback reaches within its file. */
function reachOf(text: string, callback: string): Reach {
  const seen = new Set<string>();
  let request = false;
  let reschedules = false;
  let frontier = [callback];
  for (let depth = 0; depth < 6 && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const code of frontier) {
      if (REQUEST.test(code)) request = true;
      if (/\bsetTimeout\s*\(/.test(code) && depth > 0) reschedules = true;
      for (const name of calledNames(code)) {
        if (seen.has(name) || KEYWORDS.has(name)) continue;
        seen.add(name);
        const def = definitionOf(text, name);
        if (def !== null) next.push(def);
        else if (REREAD_NAME.test(name)) request = true;
      }
    }
    frontier = next;
  }
  return { request, reschedules };
}

/** Timer loops in `text` that reach a request: one line per finding. */
function timerPollingFindings(text: string): string[] {
  const findings: string[] = [];
  for (const m of text.matchAll(TIMER)) {
    const kind = m[1];
    const open = (m.index ?? 0) + m[0].length - 1;
    const callback = firstArgument(text, open);
    const reach = reachOf(text, callback);
    const loop = kind === "setInterval" || reach.reschedules;
    if (loop && reach.request) {
      const line = text.slice(0, m.index).split("\n").length;
      findings.push(`line ${line}: ${kind}(${callback.trim().slice(0, 60)}…)`);
    }
  }
  return findings;
}

const CLIENT_SOURCES = sources(ADMIN_SRC).map((path) => ({
  path: relative(REPO_ROOT, path),
  text: readFileSync(path, "utf8"),
}));

describe("the admin's browser code does not poll the admin on a timer (#1215)", () => {
  it("scans the real admin sources", () => {
    // A walker that silently stopped would pass vacuously.
    expect(CLIENT_SOURCES.length).toBeGreaterThan(200);
    expect(
      CLIENT_SOURCES.some((s) => s.path.endsWith("lib/components/chat/ChatPanel.svelte")),
    ).toBe(true);
  });

  it("no timer loop reaches a request, except the reviewed ones", () => {
    const offenders = CLIENT_SOURCES.flatMap((s) =>
      timerPollingFindings(s.text).map((f) => `${s.path} ${f}`),
    ).filter((f) => !Object.keys(ALLOWED).some((path) => f.startsWith(`${path} `)));
    expect(offenders).toEqual([]);
  });

  it("every allow-list entry still exists and still needs its exception", () => {
    for (const path of Object.keys(ALLOWED)) {
      const source = CLIENT_SOURCES.find((s) => s.path === path);
      expect(source, `${path} is gone: drop it from ALLOWED`).toBeDefined();
      expect(timerPollingFindings(source?.text ?? ""), `${path} no longer polls`).not.toEqual([]);
    }
  });

  it("catches the pollers this issue removed", () => {
    // RunningAgentsBar / NotificationBell before #1215.
    expect(
      timerPollingFindings(`
        async function refresh() { const next = await fetchAgentRuns(id); runs = next; }
        $effect(() => {
          const id = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
          }, pollMs);
          return () => clearInterval(id);
        });`),
    ).toHaveLength(1);
    // The deployments page: a bare function reference.
    expect(
      timerPollingFindings(`
        async function refetch() { const r = await fetch("/api/deploy-runs"); }
        pollHandle = setInterval(refetch, 1_500);`),
    ).toHaveLength(1);
    // quality-status.svelte.ts: a self-rescheduling setTimeout.
    expect(
      timerPollingFindings(`
        class Poller {
          async refresh(): Promise<void> {
            await this.#fetchCoalesced();
            this.#schedule();
          }
          #schedule(): void {
            this.#timer = setTimeout(() => void this.refresh(), busy ? 4_000 : 20_000);
          }
        }`),
    ).toHaveLength(1);
    // A call the scan cannot resolve, named like a re-read.
    expect(
      timerPollingFindings(`setInterval(() => void loadPendingProposals(), 10_000);`),
    ).toHaveLength(1);
  });

  it("lets debounces, clocks and watchdogs through", () => {
    // A one-shot debounce of typing that fetches once.
    expect(
      timerPollingFindings(`
        debounceTimer = setTimeout(() => {
          void fetch("/api/fonts?q=" + query);
        }, 250);`),
    ).toEqual([]);
    // A local clock.
    expect(
      timerPollingFindings(`const id = setInterval(() => (nowMs = Date.now()), 1000);`),
    ).toEqual([]);
    // The stream-stall watchdog.
    expect(
      timerPollingFindings(`
        const id = setInterval(() => {
          if (Date.now() - lastEventAtMs > STREAM_STALL_THRESHOLD_MS) streamStalled = true;
        }, 5000);`),
    ).toEqual([]);
  });
});
